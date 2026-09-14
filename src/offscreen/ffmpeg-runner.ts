// Thin wrapper around ffmpeg.wasm. Isolated in its own file because all the
// awkward setup lives here, and it's the one piece a future contributor is
// most likely to need to change.
//
// IMPORTANT (Manifest V3): the ffmpeg.wasm quickstart loads its core and
// worker from a CDN (unpkg/jsdelivr). That is NOT allowed in MV3 — extensions
// may not load executable code from a remote server, and the extension CSP
// also blocks the blob: URL worker @ffmpeg/ffmpeg creates by default. So all
// three files are packaged into dist/ffmpeg/ at build time (see
// esbuild.config.mjs) and loaded from chrome-extension:// URLs here. Do not
// "simplify" this back to a CDN URL.

import { FFmpeg } from "@ffmpeg/ffmpeg";

let ffmpegPromise: Promise<FFmpeg> | undefined;

/** Loads ffmpeg.wasm once and reuses it — the core is ~30MB, so re-loading per download would be wasteful. */
export function loadFfmpeg(): Promise<FFmpeg> {
  ffmpegPromise ??= (async () => {
    const ffmpeg = new FFmpeg();
    await ffmpeg.load({
      coreURL: chrome.runtime.getURL("dist/ffmpeg/ffmpeg-core.js"),
      wasmURL: chrome.runtime.getURL("dist/ffmpeg/ffmpeg-core.wasm"),
      classWorkerURL: chrome.runtime.getURL("dist/ffmpeg/814.ffmpeg.js"),
    });
    return ffmpeg;
  })();
  return ffmpegPromise;
}

export interface MuxInput {
  /** Name inside ffmpeg's virtual filesystem, e.g. "video.ts". */
  name: string;
  data: Uint8Array;
}

/**
 * Remuxes (never re-encodes) one or two inputs into a single MP4. With two
 * inputs — separate video and audio tracks, as DASH and CMAF-HLS deliver —
 * this interleaves them into one file; with one it just rewraps the container
 * so the result is a clean, seekable MP4.
 */
export async function muxToMp4(
  inputs: MuxInput[],
  onProgress?: (ratio: number) => void
): Promise<Uint8Array> {
  if (inputs.length === 0) throw new Error("Nothing to mux.");

  const ffmpeg = await loadFfmpeg();
  const outputName = "output.mp4";

  const handleProgress = ({ progress }: { progress: number }): void => {
    onProgress?.(Math.min(Math.max(progress, 0), 1));
  };
  ffmpeg.on("progress", handleProgress);

  try {
    for (const input of inputs) {
      await ffmpeg.writeFile(input.name, input.data);
    }

    const args = inputs.flatMap((input) => ["-i", input.name]);
    // -c copy: stream copy, no re-encode (fast, lossless).
    // +faststart: move the moov atom to the front so the file plays while still copying.
    args.push("-c", "copy", "-movflags", "+faststart", outputName);

    const exitCode = await ffmpeg.exec(args);
    if (exitCode !== 0) {
      throw new Error(`ffmpeg exited with code ${exitCode} while merging the stream.`);
    }

    const output = await ffmpeg.readFile(outputName);
    if (typeof output === "string") {
      throw new Error("ffmpeg returned text where binary output was expected.");
    }

    return output;
  } finally {
    ffmpeg.off("progress", handleProgress);
    // Free the virtual filesystem so a second download doesn't accumulate memory.
    for (const input of inputs) {
      await ffmpeg.deleteFile(input.name).catch(() => undefined);
    }
    await ffmpeg.deleteFile(outputName).catch(() => undefined);
  }
}
