// Pure logic — no browser APIs. This is the single place that knows how to
// tell "is this URL/response a downloadable file, and what kind" — the
// background network watcher and the content-script DOM scanner both import
// these functions instead of each maintaining their own copy.

export type MediaCategory = "video" | "audio" | "image" | "document" | "archive" | "other";

export interface MediaItem {
  url: string;
  category: MediaCategory;
  filename: string;
  contentType?: string;
  /** Size in bytes, when known from a Content-Length header. */
  size?: number;
  /** The page URL this item was found on. */
  sourceUrl: string;
  /** ms since epoch, when the item was first detected. */
  detectedAt: number;
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

/** Streaming-manifest formats we explicitly don't support yet (HLS/DASH). */
const STREAMING_MANIFEST_EXTENSIONS = new Set(["m3u8", "mpd"]);

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

/** True for .m3u8 / .mpd URLs — deliberately out of scope for v0.1 (see README). */
export function isStreamingManifest(url: string): boolean {
  const ext = getUrlExtension(url);
  return ext !== undefined && STREAMING_MANIFEST_EXTENSIONS.has(ext);
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

/**
 * Best-effort combined classification: prefer the URL extension (cheap, always
 * available), fall back to the Content-Type header (needed for extension-less
 * URLs, e.g. CDN links with query-string filenames).
 */
export function classifyMedia(url: string, contentType?: string | null): MediaCategory | null {
  return classifyByUrl(url) ?? classifyByContentType(contentType);
}
