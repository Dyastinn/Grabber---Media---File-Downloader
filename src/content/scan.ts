// Pure function — takes a Document (and the page's URL), returns data. No
// chrome.* calls, so this is testable with plain jsdom and no real browser.

import { classifyByUrl, isStreamingManifest, type MediaItem } from "../shared/media-types";
import { guessFilename } from "../shared/filename";

const MEDIA_SELECTOR = "video[src], video source[src], audio[src], audio source[src], a[href]";

/**
 * Resolves an element's src/href against the document's base URL and
 * classifies it. Returns null for anything that isn't a recognized
 * downloadable type (including HLS/DASH manifests, out of scope for v0.1).
 */
function toMediaItem(url: string, sourceUrl: string, detectedAt: number): MediaItem | null {
  if (isStreamingManifest(url)) return null;
  const category = classifyByUrl(url);
  if (!category) return null;
  return {
    url,
    category,
    filename: guessFilename(url),
    sourceUrl,
    detectedAt,
  };
}

/** Scans a document for video/audio/source/anchor elements pointing at downloadable files. */
export function extractMediaItems(doc: Document, sourceUrl: string, now: number = Date.now()): MediaItem[] {
  const items = new Map<string, MediaItem>();

  for (const el of doc.querySelectorAll(MEDIA_SELECTOR)) {
    const rawUrl = el instanceof HTMLAnchorElement ? el.href : (el as HTMLMediaElement | HTMLSourceElement).src;
    if (!rawUrl) continue;
    const item = toMediaItem(rawUrl, sourceUrl, now);
    if (item) items.set(item.url, item);
  }

  return [...items.values()];
}
