// Pure logic — turns parsed playlists/manifests plus the user's quality choice
// into an executable download plan. The offscreen document just *runs* a plan;
// every decision about which segments to fetch, in what order, and how to
// decrypt them is made here, where it can be unit-tested without a browser.

import type { DashRepresentation } from "./dash-manifest";
import { computeSegmentIv, type HlsAudioRendition, type HlsMediaPlaylist, type HlsVariant } from "./hls-playlist";
import type { StreamKind } from "./media-types";

export interface PlannedSegment {
  url: string;
  /** Present only when this segment must be AES-128-CBC decrypted after fetching. */
  decryption?: { keyUrl: string; iv: Uint8Array };
}

export interface PlannedTrack {
  /** fMP4 initialization segment, prepended to the concatenated media segments. */
  initUrl?: string;
  segments: PlannedSegment[];
}

export interface StreamDownloadPlan {
  kind: StreamKind;
  video: PlannedTrack;
  /** Only set when audio is delivered as a separate track that must be muxed in. */
  audio?: PlannedTrack;
  suggestedFilename: string;
}

export type StreamPlanResult =
  | { ok: true; plan: StreamDownloadPlan }
  | { ok: false; reason: string };

/** Highest-bandwidth entry wins. Used to auto-select an audio track (video is user-chosen). */
export function pickHighestBandwidth<T extends { bandwidth: number }>(items: T[]): T | undefined {
  return items.reduce<T | undefined>(
    (best, item) => (best === undefined || item.bandwidth > best.bandwidth ? item : best),
    undefined
  );
}

/**
 * Picks the audio rendition a variant points at: the group's DEFAULT=YES entry
 * if there is one, otherwise the first in that group. Renditions without a URI
 * are muxed into the video segments and need no separate download.
 */
export function pickAudioRendition(
  renditions: HlsAudioRendition[],
  groupId: string | undefined
): HlsAudioRendition | undefined {
  if (!groupId) return undefined;
  const inGroup = renditions.filter((rendition) => rendition.groupId === groupId && rendition.url);
  return inGroup.find((rendition) => rendition.isDefault) ?? inGroup[0];
}

/**
 * A human-readable quality label, e.g. "720p" or "2400 kbps". Takes the two
 * fields directly rather than a whole variant, because HLS nests resolution
 * and DASH keeps width/height flat — one label implementation either way.
 */
export function describeQuality(height: number | undefined, bandwidth: number): string {
  if (height) return `${height}p`;
  return `${Math.round(bandwidth / 1000)} kbps`;
}

function baseNameFromUrl(url: string): string {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    // Manifests are usually named generically ("master.m3u8", "index.mpd"), so
    // the containing directory is normally the more meaningful name.
    const fileName = segments.pop() ?? "";
    const withoutExtension = fileName.replace(/\.(m3u8|m3u|mpd)$/i, "");
    const parent = segments.pop();
    const candidate =
      withoutExtension && !/^(master|index|playlist|manifest)$/i.test(withoutExtension)
        ? withoutExtension
        : (parent ?? withoutExtension);
    return candidate || "stream";
  } catch {
    return "stream";
  }
}

export function suggestStreamFilename(manifestUrl: string, qualityLabel: string): string {
  return `${baseNameFromUrl(manifestUrl)}-${qualityLabel}.mp4`;
}

function planHlsTrack(playlist: HlsMediaPlaylist): PlannedTrack {
  return {
    ...(playlist.initSegmentUrl && { initUrl: playlist.initSegmentUrl }),
    segments: playlist.segments.map((segment) => ({
      url: segment.url,
      ...(segment.encryption && {
        decryption: {
          keyUrl: segment.encryption.keyUrl,
          iv: computeSegmentIv(segment.sequenceNumber, segment.encryption.ivHex),
        },
      }),
    })),
  };
}

export function planHlsDownload(options: {
  manifestUrl: string;
  variant: HlsVariant;
  videoPlaylist: HlsMediaPlaylist;
  /** Only when the variant references a separate EXT-X-MEDIA audio rendition. */
  audioPlaylist?: HlsMediaPlaylist;
}): StreamPlanResult {
  const { manifestUrl, variant, videoPlaylist, audioPlaylist } = options;

  const unsupported = videoPlaylist.unsupportedEncryption ?? audioPlaylist?.unsupportedEncryption;
  if (unsupported) {
    return {
      ok: false,
      reason: `This stream uses ${unsupported} encryption (DRM), which can't be downloaded.`,
    };
  }

  if (videoPlaylist.segments.length === 0) {
    return { ok: false, reason: "This stream's playlist contained no segments." };
  }

  return {
    ok: true,
    plan: {
      kind: "hls",
      video: planHlsTrack(videoPlaylist),
      ...(audioPlaylist &&
        audioPlaylist.segments.length > 0 && { audio: planHlsTrack(audioPlaylist) }),
      suggestedFilename: suggestStreamFilename(
        manifestUrl,
        describeQuality(variant.resolution?.height, variant.bandwidth)
      ),
    },
  };
}

function planDashTrack(representation: DashRepresentation): PlannedTrack {
  return {
    ...(representation.initUrl && { initUrl: representation.initUrl }),
    segments: representation.segmentUrls.map((url) => ({ url })),
  };
}

export function planDashDownload(options: {
  manifestUrl: string;
  video: DashRepresentation;
  /** Auto-selected highest-bandwidth audio representation, when the manifest has one. */
  audio?: DashRepresentation;
}): StreamPlanResult {
  const { manifestUrl, video, audio } = options;

  if (video.segmentUrls.length === 0) {
    return { ok: false, reason: "This stream's manifest contained no segments." };
  }

  return {
    ok: true,
    plan: {
      kind: "dash",
      video: planDashTrack(video),
      ...(audio && audio.segmentUrls.length > 0 && { audio: planDashTrack(audio) }),
      suggestedFilename: suggestStreamFilename(
        manifestUrl,
        describeQuality(video.height, video.bandwidth)
      ),
    },
  };
}

/** Total number of network fetches a plan will make — used to report progress. */
export function countPlannedFetches(plan: StreamDownloadPlan): number {
  const trackCount = (track: PlannedTrack): number =>
    track.segments.length + (track.initUrl ? 1 : 0);
  return trackCount(plan.video) + (plan.audio ? trackCount(plan.audio) : 0);
}
