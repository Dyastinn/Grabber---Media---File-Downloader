// WIRING ONLY (offscreen document context) — executes a StreamDownloadPlan.
// Every decision about *what* to download lives in shared/stream-plan.ts; this
// file just carries it out: fetch, decrypt, concatenate, mux, save.
//
// This runs in an offscreen document rather than the background service
// worker because ffmpeg.wasm needs a real DOM/Worker context. The background
// worker creates this document on demand (see background/index.ts).

import type {
  ExecuteStreamPlanMessage,
  Message,
  StreamCompleteMessage,
  StreamErrorMessage,
  StreamPhase,
  StreamProgressMessage,
} from "../shared/messages";
import { countPlannedFetches, type PlannedTrack, type StreamDownloadPlan } from "../shared/stream-plan";
import { decryptSegment, importAesKey } from "./decrypt";
import { muxToMp4, type MuxInput } from "./ffmpeg-runner";

/** How many segments to fetch at once. Enough to saturate a connection without hammering the CDN. */
const FETCH_CONCURRENCY = 6;

chrome.runtime.onMessage.addListener((message: Message) => {
  if (message.type === "EXECUTE_STREAM_PLAN") {
    // Deliberately not awaited: a stream download can take minutes, far longer
    // than a message handler may block. Progress and completion are reported
    // through their own messages instead.
    void runDownload(message).catch((error: unknown) => {
      report<StreamErrorMessage>({
        type: "STREAM_ERROR",
        streamUrl: message.streamUrl,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
});

function report<T extends Message>(message: T): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // The background worker may be asleep; progress updates are advisory, so
    // a dropped one is not worth failing the download over.
  });
}

function reportProgress(streamUrl: string, phase: StreamPhase, percent: number): void {
  report<StreamProgressMessage>({
    type: "STREAM_PROGRESS",
    streamUrl,
    phase,
    percent: Math.round(percent),
  });
}

async function runDownload({ streamUrl, plan }: ExecuteStreamPlanMessage): Promise<void> {
  const totalFetches = countPlannedFetches(plan);
  let completedFetches = 0;

  const onFetched = (): void => {
    completedFetches += 1;
    // Fetching is the long pole, so it owns most of the progress bar; muxing
    // takes the last 20%.
    reportProgress(streamUrl, "fetching", (completedFetches / totalFetches) * 80);
  };

  const keyCache = new Map<string, Promise<CryptoKey>>();

  const videoBytes = await downloadTrack(plan.video, keyCache, onFetched);
  const audioBytes = plan.audio ? await downloadTrack(plan.audio, keyCache, onFetched) : undefined;

  reportProgress(streamUrl, "muxing", 80);

  const inputs: MuxInput[] = [{ name: `video${trackExtension(plan)}`, data: videoBytes }];
  if (audioBytes) inputs.push({ name: `audio${trackExtension(plan)}`, data: audioBytes });

  const output = await muxToMp4(inputs, (ratio) => {
    reportProgress(streamUrl, "muxing", 80 + ratio * 20);
  });

  reportProgress(streamUrl, "saving", 100);
  await save(output, plan.suggestedFilename);

  report<StreamCompleteMessage>({
    type: "STREAM_COMPLETE",
    streamUrl,
    filename: plan.suggestedFilename,
  });
}

/**
 * ffmpeg picks its demuxer from the file extension, so the concatenated bytes
 * have to be named for what they actually are: MPEG-TS segments (classic HLS)
 * vs. fragmented MP4 (DASH, and CMAF-style HLS, which always has an init segment).
 */
function trackExtension(plan: StreamDownloadPlan): string {
  return plan.kind === "dash" || plan.video.initUrl ? ".mp4" : ".ts";
}

async function downloadTrack(
  track: PlannedTrack,
  keyCache: Map<string, Promise<CryptoKey>>,
  onFetched: () => void
): Promise<Uint8Array> {
  // An fMP4 init segment must come first; the media segments follow in order.
  const parts: Uint8Array[] = new Array(track.segments.length + (track.initUrl ? 1 : 0));
  const offset = track.initUrl ? 1 : 0;

  if (track.initUrl) {
    parts[0] = await fetchBytes(track.initUrl);
    onFetched();
  }

  await runWithConcurrency(track.segments.length, FETCH_CONCURRENCY, async (index) => {
    const segment = track.segments[index];
    if (!segment) return;

    let bytes = await fetchBytes(segment.url);

    if (segment.decryption) {
      const key = await getKey(segment.decryption.keyUrl, keyCache);
      bytes = await decryptSegment(bytes, key, segment.decryption.iv);
    }

    parts[offset + index] = bytes;
    onFetched();
  });

  return concatenate(parts);
}

function getKey(keyUrl: string, cache: Map<string, Promise<CryptoKey>>): Promise<CryptoKey> {
  // Cached because a stream typically encrypts every segment with the same key.
  let key = cache.get(keyUrl);
  if (!key) {
    key = fetchBytes(keyUrl).then(importAesKey);
    cache.set(keyUrl, key);
  }
  return key;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url} (HTTP ${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Runs `task` for indices 0..count-1, at most `limit` at a time, preserving nothing but order of completion. */
async function runWithConcurrency(
  count: number,
  limit: number,
  task: (index: number) => Promise<void>
): Promise<void> {
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(limit, count) }, async () => {
    while (nextIndex < count) {
      const index = nextIndex;
      nextIndex += 1;
      await task(index);
    }
  });

  await Promise.all(workers);
}

function concatenate(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + (part?.byteLength ?? 0), 0);
  const result = new Uint8Array(total);
  let position = 0;
  for (const part of parts) {
    if (!part) continue;
    result.set(part, position);
    position += part.byteLength;
  }
  return result;
}

async function save(bytes: Uint8Array, filename: string): Promise<void> {
  const blobUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "video/mp4" }));
  const downloadId = await chrome.downloads.download({ url: blobUrl, filename });

  // Hold the blob URL until the browser has finished reading from it.
  const revokeWhenFinished = (delta: chrome.downloads.DownloadDelta): void => {
    if (delta.id !== downloadId || !delta.state) return;
    if (delta.state.current === "complete" || delta.state.current === "interrupted") {
      URL.revokeObjectURL(blobUrl);
      chrome.downloads.onChanged.removeListener(revokeWhenFinished);
    }
  };
  chrome.downloads.onChanged.addListener(revokeWhenFinished);
}
