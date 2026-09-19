// Pure function — takes a Document (and the page's URL), returns data. No
// chrome.* calls, so this is testable with plain jsdom and no real browser.

import { classifyMedia, type MediaItem, type StreamKind } from "../shared/media-types";
import { guessFilename, sanitizeFilename } from "../shared/filename";

const MEDIA_SELECTOR = "video[src], video source[src], audio[src], audio source[src], a[href]";

/**
 * Resolves an element's src/href against the document's base URL and
 * classifies it. Returns null for anything that isn't a recognized
 * downloadable type. Streaming manifests (.m3u8/.mpd) come back as
 * category "stream" — the popup offers a quality picker for those.
 */
function toMediaItem(url: string, sourceUrl: string, detectedAt: number): MediaItem | null {
  const classification = classifyMedia(url);
  if (!classification) return null;
  return {
    url,
    category: classification.category,
    filename: guessFilename(url),
    sourceUrl,
    detectedAt,
    ...(classification.streamKind && { streamKind: classification.streamKind }),
  };
}

// Separators sites use between a page's own title and their name:
// "Some video | SiteName", "Some video - SiteName", "Some video – SiteName".
const TITLE_SEPARATOR_RE = /\s+[|\-–—:·»]\s+/;
const MAX_SITE_NAME_LENGTH = 40;

/**
 * The page's name for what it shows, for naming a stream after it. Prefers
 * og:title (usually the clean media title); otherwise the document title with
 * a trailing short " - Site Name" segment removed. Undefined when the page has
 * no usable title.
 */
export function pageTitle(doc: Document): string | undefined {
  const og = doc.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim();
  if (og) return og;

  const title = doc.title.trim();
  if (!title) return undefined;
  const parts = title.split(TITLE_SEPARATOR_RE);
  const last = parts[parts.length - 1] ?? "";
  if (parts.length > 1 && last.length <= MAX_SITE_NAME_LENGTH) {
    const withoutSite = title.slice(0, title.length - last.length).replace(/\s+[|\-–—:·»]\s*$/, "").trim();
    if (withoutSite) return withoutSite;
  }
  return title;
}

function streamFilename(url: string, kind: StreamKind, title: string | undefined): string {
  const base = title ? sanitizeFilename(title) : "";
  return base ? `${base}.${kind === "hls" ? "m3u8" : "mpd"}` : guessFilename(url);
}

/**
 * A stream item for a manifest URL whose kind is already known — used for
 * manifests the page-world sniffer recognised by content, whose URL and
 * Content-Type said nothing. Named after the page when it has a title.
 */
export function manifestItem(
  url: string,
  kind: StreamKind,
  sourceUrl: string,
  now: number = Date.now(),
  extra: { title?: string; childUrls?: string[] } = {}
): MediaItem {
  return {
    url,
    category: "stream",
    streamKind: kind,
    filename: streamFilename(url, kind, extra.title),
    sourceUrl,
    detectedAt: now,
    ...(extra.title && { title: extra.title }),
    ...(extra.childUrls && extra.childUrls.length > 0 && { childUrls: extra.childUrls }),
  };
}

/**
 * Scans a document for video/audio/source/anchor elements pointing at
 * downloadable files. Streams are named after the page (a page normally
 * shows one video); plain files keep their own names, since a page can link
 * to many.
 */
export function extractMediaItems(doc: Document, sourceUrl: string, now: number = Date.now()): MediaItem[] {
  const items = new Map<string, MediaItem>();
  const title = pageTitle(doc);

  for (const el of doc.querySelectorAll(MEDIA_SELECTOR)) {
    const rawUrl = el instanceof HTMLAnchorElement ? el.href : (el as HTMLMediaElement | HTMLSourceElement).src;
    if (!rawUrl) continue;
    const item = toMediaItem(rawUrl, sourceUrl, now);
    if (!item) continue;
    if (item.streamKind && title) {
      items.set(item.url, { ...item, title, filename: streamFilename(item.url, item.streamKind, title) });
    } else {
      items.set(item.url, item);
    }
  }

  return [...items.values()];
}
