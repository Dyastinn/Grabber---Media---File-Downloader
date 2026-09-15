// WIRING ONLY — asks the background service worker for the active tab's
// media list, hands the data to the pure render.ts functions, and turns
// clicks into messages. Manifest parsing is done by the same pure modules the
// offscreen document uses (shared/hls-playlist.ts, shared/dash-manifest.ts),
// so the popup and the downloader can never disagree about a stream.

import { parseManifest, type DashRepresentation } from "../shared/dash-manifest";
import {
  isMasterPlaylist,
  parseMasterPlaylist,
  parseMediaPlaylist,
  type HlsAudioRendition,
  type HlsVariant,
} from "../shared/hls-playlist";
import type {
  DownloadMessage,
  DownloadStreamMessage,
  GetMediaMessage,
  GetStreamProgressMessage,
  MediaListMessage,
  Message,
  StreamProgressEntry,
  StreamProgressListMessage,
} from "../shared/messages";
import type { MediaItem, StreamQualitySource } from "../shared/media-types";
import {
  describeQuality,
  pickAudioRendition,
  pickHighestBandwidth,
  planDashDownload,
  planHlsDownload,
  type StreamPlanResult,
} from "../shared/stream-plan";
import {
  renderList,
  renderNotice,
  renderQualityOptions,
  renderStreamProgress,
  formatFoundCount,
  weightRungs,
  type QualityOption,
} from "./render";

function getRoot(): HTMLElement {
  const el = document.getElementById("root");
  if (!el) throw new Error("popup.html is missing #root");
  return el;
}

const root = getRoot();

/** What the picker for a given manifest URL is offering, so a click can be turned back into a plan. */
type PickerContext = { manifestUrl: string; title?: string } & (
  | { kind: "hls"; variants: HlsVariant[]; audioRenditions: HlsAudioRendition[] }
  | { kind: "dash"; representations: DashRepresentation[]; audio: DashRepresentation[] }
  // One manifest per quality (see MediaItem.qualitySources): the chosen
  // source's manifest is only fetched once the user picks.
  | { kind: "hls-sources"; sources: StreamQualitySource[] }
);

const pickers = new Map<string, PickerContext>();
let items: MediaItem[] = [];

async function loadAndRender(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;

  const request: GetMediaMessage = { type: "GET_MEDIA", tabId: tab.id };
  const response = (await chrome.runtime.sendMessage(request)) as MediaListMessage;
  items = response.items;

  root.replaceChildren(renderList(items));

  const count = document.getElementById("found-count");
  if (count) count.textContent = formatFoundCount(items.length);

  // A stream download keeps running after the popup closes, so show where any
  // in-flight download got to rather than offering to start it again.
  const progressRequest: GetStreamProgressMessage = { type: "GET_STREAM_PROGRESS" };
  const progress = (await chrome.runtime.sendMessage(progressRequest)) as StreamProgressListMessage;
  for (const entry of progress.entries) showProgress(entry);
}

function findRowExtra(url: string): HTMLElement | null {
  return root.querySelector(`.media-row[data-url="${CSS.escape(url)}"] .row-extra`);
}

function showInRow(url: string, content: HTMLElement): void {
  findRowExtra(url)?.replaceChildren(content);
}

function showProgress(entry: StreamProgressEntry): void {
  showInRow(entry.streamUrl, renderStreamProgress(entry));
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't load the stream manifest (HTTP ${response.status}).`);
  return response.text();
}

const byBandwidthDescending = <T extends { bandwidth: number }>(a: T, b: T): number =>
  b.bandwidth - a.bandwidth;

/** Fetches and parses a manifest, then shows what qualities are available. */
async function openQualityPicker(item: MediaItem): Promise<void> {
  // A site that serves one manifest per quality already told us the choices;
  // nothing to fetch until the user picks one.
  if (item.qualitySources && item.qualitySources.length > 0) {
    const sources = [...item.qualitySources].sort((a, b) => b.height - a.height);
    pickers.set(item.url, {
      kind: "hls-sources",
      manifestUrl: item.url,
      ...(item.title && { title: item.title }),
      sources,
    });
    showOptions(
      item.url,
      sources.map((source) => ({ label: describeQuality(source.height, 0) })),
      sources.map((source) => source.height)
    );
    return;
  }

  showInRow(item.url, renderNotice("Loading stream details..."));

  try {
    const text = await fetchText(item.url);

    if (item.streamKind === "dash") {
      const parsed = parseManifest(text, item.url);
      if (!parsed.supported) {
        showInRow(item.url, renderNotice(parsed.reason));
        return;
      }

      const representations = [...parsed.video].sort(byBandwidthDescending);
      pickers.set(item.url, {
        kind: "dash",
        manifestUrl: item.url,
        ...(item.title && { title: item.title }),
        representations,
        audio: parsed.audio,
      });
      showOptions(
        item.url,
        representations.map((rep) => ({
          label: describeQuality(rep.height, rep.bandwidth),
          detail: rep.width && rep.height ? `${rep.width}x${rep.height}` : undefined,
        })),
        representations.map((rep) => rep.bandwidth || rep.height)
      );
      return;
    }

    // HLS. A master playlist lists variants to choose from; a bare media
    // playlist is already the only option there is.
    if (isMasterPlaylist(text)) {
      const master = parseMasterPlaylist(text, item.url);
      const variants = [...master.variants].sort(byBandwidthDescending);
      if (variants.length === 0) {
        showInRow(item.url, renderNotice("This playlist didn't list any video variants."));
        return;
      }

      pickers.set(item.url, {
        kind: "hls",
        manifestUrl: item.url,
        ...(item.title && { title: item.title }),
        variants,
        audioRenditions: master.audioRenditions,
      });
      showOptions(
        item.url,
        variants.map((variant) => ({
          label: describeQuality(variant.resolution?.height, variant.bandwidth),
          detail: `${Math.round(variant.bandwidth / 1000)} kbps`,
        })),
        variants.map((variant) => variant.bandwidth || variant.resolution?.height)
      );
      return;
    }

    const soleVariant: HlsVariant = { url: item.url, bandwidth: 0 };
    pickers.set(item.url, {
      kind: "hls",
      manifestUrl: item.url,
      ...(item.title && { title: item.title }),
      variants: [soleVariant],
      audioRenditions: [],
    });
    showOptions(item.url, [{ label: "Download", detail: "single quality" }]);
  } catch (error) {
    showInRow(item.url, renderNotice(errorMessage(error)));
  }
}

/**
 * Shows the quality ladder. `magnitudes` is whatever the manifest gave us to
 * size each rung's bar by — bitrate where there is one, resolution height as
 * a stand-in, undefined where there is neither. `weightRungs` decides whether
 * the ladder gets bars at all.
 */
function showOptions(
  url: string,
  options: QualityOption[],
  magnitudes: (number | undefined)[] = []
): void {
  const weights = weightRungs(options.map((_, index) => magnitudes[index]));
  const rungs = options.map((option, index) => {
    const weight = weights[index];
    return weight === undefined ? option : { ...option, weight };
  });
  showInRow(url, renderQualityOptions(rungs));
}

/** Turns the user's quality choice into a plan and hands it to the background worker. */
async function startStreamDownload(url: string, index: number): Promise<void> {
  const context = pickers.get(url);
  if (!context) return;

  showInRow(url, renderNotice("Preparing download..."));

  try {
    const result = await buildPlan(context, index);
    if (!result.ok) {
      showInRow(url, renderNotice(result.reason));
      return;
    }

    const message: DownloadStreamMessage = {
      type: "DOWNLOAD_STREAM",
      streamUrl: url,
      plan: result.plan,
    };
    await chrome.runtime.sendMessage(message);

    showProgress({ streamUrl: url, phase: "fetching", percent: 0 });
  } catch (error) {
    showInRow(url, renderNotice(errorMessage(error)));
  }
}

async function buildPlan(context: PickerContext, index: number): Promise<StreamPlanResult> {
  if (context.kind === "dash") {
    const video = context.representations[index];
    if (!video) return { ok: false, reason: "That quality is no longer available." };

    // Audio is auto-selected (highest bitrate); only video quality is user-facing.
    const audio = pickHighestBandwidth(context.audio);
    return planDashDownload({
      manifestUrl: context.manifestUrl,
      ...(context.title && { title: context.title }),
      video,
      ...(audio && { audio }),
    });
  }

  if (context.kind === "hls-sources") {
    const source = context.sources[index];
    if (!source) return { ok: false, reason: "That quality is no longer available." };

    // The per-quality manifest is normally a one-variant master, but treat it
    // exactly like any other HLS manifest in case it isn't.
    const text = await fetchText(source.url);
    if (isMasterPlaylist(text)) {
      const master = parseMasterPlaylist(text, source.url);
      const variant = pickHighestBandwidth(master.variants);
      if (!variant) return { ok: false, reason: "This playlist didn't list any video variants." };
      return planHlsVariant(source.url, variant, master.audioRenditions, context.title);
    }
    return planHlsVariant(source.url, { url: source.url, bandwidth: 0 }, [], context.title);
  }

  const variant = context.variants[index];
  if (!variant) return { ok: false, reason: "That quality is no longer available." };
  return planHlsVariant(context.manifestUrl, variant, context.audioRenditions, context.title);
}

/** Fetches a chosen HLS variant's media playlist (and its audio rendition, if separate) and plans it. */
async function planHlsVariant(
  manifestUrl: string,
  variant: HlsVariant,
  audioRenditions: HlsAudioRendition[],
  title: string | undefined
): Promise<StreamPlanResult> {
  const videoPlaylist = parseMediaPlaylist(await fetchText(variant.url), variant.url);

  // CMAF/fMP4 streams often deliver audio as a separate rendition that has to
  // be fetched and muxed in; simpler streams mux audio into the video segments.
  const audioRendition = pickAudioRendition(audioRenditions, variant.audioGroupId);
  const audioPlaylist = audioRendition?.url
    ? parseMediaPlaylist(await fetchText(audioRendition.url), audioRendition.url)
    : undefined;

  return planHlsDownload({
    manifestUrl,
    ...(title && { title }),
    variant,
    videoPlaylist,
    ...(audioPlaylist && { audioPlaylist }),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Event delegation: one listener on the container instead of one per row, so
// re-rendering never needs to re-attach anything.
root.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;

  const downloadButton = target.closest<HTMLButtonElement>(".download-btn");
  if (downloadButton) {
    const url = downloadButton.dataset["url"];
    const filename = downloadButton.dataset["filename"];
    if (!url || !filename) return;
    const message: DownloadMessage = { type: "DOWNLOAD", url, filename };
    void chrome.runtime.sendMessage(message);
    return;
  }

  const qualityButton = target.closest<HTMLButtonElement>(".quality-btn");
  if (qualityButton) {
    const url = qualityButton.dataset["url"];
    const item = items.find((candidate) => candidate.url === url);
    if (item) void openQualityPicker(item);
    return;
  }

  const option = target.closest<HTMLButtonElement>(".quality-option");
  if (option) {
    const row = option.closest<HTMLElement>(".media-row");
    const url = row?.dataset["url"];
    const index = Number(option.dataset["index"]);
    if (url && Number.isInteger(index)) void startStreamDownload(url, index);
  }
});

// The offscreen document broadcasts progress to every extension context, so
// the popup can update live while it's open.
chrome.runtime.onMessage.addListener((message: Message) => {
  switch (message.type) {
    case "STREAM_PROGRESS":
      showProgress({
        streamUrl: message.streamUrl,
        phase: message.phase,
        percent: message.percent,
      });
      break;
    case "STREAM_COMPLETE":
      showProgress({ streamUrl: message.streamUrl, phase: "done", percent: 100 });
      break;
    case "STREAM_ERROR":
      showProgress({
        streamUrl: message.streamUrl,
        phase: "error",
        percent: 0,
        error: message.message,
      });
      break;
  }
});

void loadAndRender();
