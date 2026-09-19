// Pure logic — no browser APIs. This is the single place that knows how to
// tell "is this URL/response a downloadable file, and what kind" — the
// background network watcher and the content-script DOM scanner both import
// these functions instead of each maintaining their own copy.

export type MediaCategory =
  | "video"
  | "audio"
  | "image"
  | "document"
  | "archive"
  | "stream"
  | "other";

/** Adaptive-streaming manifest formats. A "stream" item is a manifest, not a file. */
export type StreamKind = "hls" | "dash";

export interface MediaItem {
  url: string;
  category: MediaCategory;
  filename: string;
  contentType?: string;
  /** Size in bytes, when known from a Content-Length header. Never set for streams. */
  size?: number;
  /** The page URL this item was found on. */
  sourceUrl: string;
  /** ms since epoch, when the item was first detected. */
  detectedAt: number;
  /** Only set when category is "stream" — which manifest format this is. */
  streamKind?: StreamKind;
  /**
   * Human-readable name from the page (e.g. a video's title), when a scanner
   * can determine one. Used to name the saved file instead of the URL's last
   * path segment, which on video hosts is a meaningless "master.m3u8".
   */
  title?: string;
  /**
   * Only for streams. Some hosts publish a separate manifest per quality
   * instead of one master listing them all. Rather than one row per quality,
   * a scanner can emit one item — `url` is the highest-quality manifest —
   * and list every quality here, so the popup builds its picker from this
   * list instead of from the item's own manifest.
   */
  qualitySources?: StreamQualitySource[];
  /**
   * Only for streams. URLs this manifest references — an HLS master's variant
   * and audio-rendition playlists. The player fetches those too, and they
   * would otherwise each show up as their own "video.m3u8" row; the store
   * treats them as parts of this item instead.
   */
  childUrls?: string[];
}

/** One same-video manifest at a given quality; see MediaItem.qualitySources. */
export interface StreamQualitySource {
  url: string;
  /** Vertical resolution, e.g. 720. */
  height: number;
}

const EXTENSION_TO_CATEGORY: Record<string, MediaCategory> = {
  // video
  mp4: "video",
  webm: "video",
  mkv: "video",
  mov: "video",
  avi: "video",
  flv: "video",
  m4v: "video",
  wmv: "video",
  mpg: "video",
  mpeg: "video",
  "3gp": "video",
  ts: "video",
  ogv: "video",
  // audio
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  oga: "audio",
  m4a: "audio",
  flac: "audio",
  aac: "audio",
  wma: "audio",
  opus: "audio",
  weba: "audio",
  // image
  jpg: "image",
  jpeg: "image",
  png: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  svg: "image",
  avif: "image",
  // document
  pdf: "document",
  doc: "document",
  docx: "document",
  xls: "document",
  xlsx: "document",
  ppt: "document",
  pptx: "document",
  txt: "document",
  csv: "document",
  // archive
  zip: "archive",
  rar: "archive",
  "7z": "archive",
  tar: "archive",
  gz: "archive",
};

const MIME_PREFIX_TO_CATEGORY: Array<[prefix: string, category: MediaCategory]> = [
  ["video/", "video"],
  ["audio/", "audio"],
  ["image/", "image"],
  ["application/pdf", "document"],
  ["application/msword", "document"],
  ["application/vnd.ms-excel", "document"],
  ["application/vnd.ms-powerpoint", "document"],
  ["application/vnd.openxmlformats-officedocument", "document"],
  ["text/plain", "document"],
  ["text/csv", "document"],
  ["application/zip", "archive"],
  ["application/x-rar-compressed", "archive"],
  ["application/x-7z-compressed", "archive"],
  ["application/x-tar", "archive"],
  ["application/gzip", "archive"],
];

const STREAM_EXTENSION_TO_KIND: Record<string, StreamKind> = {
  m3u8: "hls",
  m3u: "hls",
  mpd: "dash",
};

const STREAM_MIME_TO_KIND: Array<[prefix: string, kind: StreamKind]> = [
  ["application/vnd.apple.mpegurl", "hls"],
  ["application/x-mpegurl", "hls"],
  ["audio/mpegurl", "hls"],
  ["audio/x-mpegurl", "hls"],
  ["application/dash+xml", "dash"],
];

function extensionFromPathname(pathname: string): string | undefined {
  const lastSegment = pathname.split("/").pop() ?? "";
  const dotIndex = lastSegment.lastIndexOf(".");
  if (dotIndex === -1 || dotIndex === lastSegment.length - 1) return undefined;
  return lastSegment.slice(dotIndex + 1).toLowerCase();
}

/** Returns the file extension for a URL, or undefined if it can't be determined or parsed. */
export function getUrlExtension(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return extensionFromPathname(parsed.pathname);
  } catch {
    return undefined;
  }
}

/**
 * Identifies adaptive-streaming manifests (HLS/DASH). Prefers the URL
 * extension, falls back to Content-Type — many CDNs serve manifests from
 * extension-less URLs but always set the right MIME type.
 */
export function classifyStreamKind(
  url: string,
  contentType?: string | null
): StreamKind | null {
  const ext = getUrlExtension(url);
  if (ext !== undefined && STREAM_EXTENSION_TO_KIND[ext]) {
    return STREAM_EXTENSION_TO_KIND[ext];
  }
  if (!contentType) return null;
  const normalized = contentType.toLowerCase().trim();
  for (const [prefix, kind] of STREAM_MIME_TO_KIND) {
    if (normalized.startsWith(prefix)) return kind;
  }
  return null;
}

/**
 * Recognises a manifest by its CONTENT — the fallback for players whose
 * playlist URL has no extension and whose server sends the wrong Content-Type
 * (text/plain, application/octet-stream…), which is the norm on private
 * players. Only the first few hundred bytes are looked at, so callers can
 * pass a prefix.
 */
export function sniffManifestKind(text: string): StreamKind | null {
  // Strip a UTF-8 BOM (U+FEFF) before looking at the first bytes.
  const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const head = text.slice(start, 2048).trimStart();
  if (head.startsWith("#EXTM3U")) return "hls";
  // An MPD may open with an XML declaration and/or comments before the root element.
  if (head.startsWith("<") && /<MPD[\s>]/.test(head)) return "dash";
  return null;
}

const SEGMENT_EXTENSIONS = new Set(["ts", "m4s"]);
const SEGMENT_MIME_TYPES = ["video/mp2t", "video/iso.segment"];

/**
 * True for a URL/response that is a single HLS/DASH media segment rather than
 * a whole file. Players fetch dozens of these per minute; the network watcher
 * must not list each one as a "video". (A `.ts` linked from the page DOM is
 * still reported by the content script — this only concerns JS-initiated
 * requests.)
 */
export function isStreamSegment(url: string, contentType?: string | null): boolean {
  const ext = getUrlExtension(url);
  if (ext !== undefined && SEGMENT_EXTENSIONS.has(ext)) return true;
  if (!contentType) return false;
  const normalized = contentType.toLowerCase().trim();
  return SEGMENT_MIME_TYPES.some((mime) => normalized.startsWith(mime));
}

/** Classifies a URL by its file extension. Returns null if it's not a recognized downloadable type. */
export function classifyByUrl(url: string): MediaCategory | null {
  const ext = getUrlExtension(url);
  if (ext === undefined) return null;
  return EXTENSION_TO_CATEGORY[ext] ?? null;
}

/** Classifies an HTTP Content-Type header value. Returns null if it's not a recognized downloadable type. */
export function classifyByContentType(contentType: string | undefined | null): MediaCategory | null {
  if (!contentType) return null;
  const normalized = contentType.toLowerCase().trim();
  for (const [prefix, category] of MIME_PREFIX_TO_CATEGORY) {
    if (normalized.startsWith(prefix)) return category;
  }
  return null;
}

export interface Classification {
  category: MediaCategory;
  /** Only present when category is "stream". */
  streamKind?: StreamKind;
}

/**
 * Best-effort combined classification: streams first (a .m3u8 is a manifest,
 * not a text file), then the URL extension (cheap, always available), then the
 * Content-Type header (needed for extension-less URLs, e.g. CDN links with
 * query-string filenames).
 *
 * Returning category and stream kind together means callers never have to run
 * two classification passes and risk disagreeing about what an item is.
 */
export function classifyMedia(url: string, contentType?: string | null): Classification | null {
  const streamKind = classifyStreamKind(url, contentType);
  if (streamKind) return { category: "stream", streamKind };

  const category = classifyByUrl(url) ?? classifyByContentType(contentType);
  return category ? { category } : null;
}
