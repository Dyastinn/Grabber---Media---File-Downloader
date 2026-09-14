// Pure class — no browser APIs. Single owner of "what media has each tab
// found so far." Background/index.ts is the only wiring code that touches
// this, and it only ever calls these three methods.

import type { MediaItem } from "../shared/media-types";

export class MediaStore {
  private readonly byTab = new Map<number, Map<string, MediaItem>>();

  /**
   * Adds an item for a tab. Re-adding the same URL overwrites (e.g. once
   * headers give us a size we didn't have before) — except that a page title
   * already known for the URL is kept. A site extractor names an item after
   * the video; when the player then fetches that same URL, the network watcher
   * reports it again named after its last path segment ("master.m3u8"), and
   * that must not win.
   */
  add(tabId: number, item: MediaItem): void {
    let items = this.byTab.get(tabId);
    if (!items) {
      items = new Map();
      this.byTab.set(tabId, items);
    }
    const existing = items.get(item.url);
    const titled = existing?.title !== undefined && item.title === undefined ? existing : undefined;

    // Likewise, a quality alternate already offered by a titled row's picker
    // (a host's per-quality manifests) must not become a second, generic row
    // when the player fetches it.
    if (!titled && item.title === undefined && isQualityAlternate(items, item.url)) return;

    items.set(item.url, titled ? { ...item, title: titled.title, filename: titled.filename } : item);
  }

  /** Returns all items found for a tab, newest first. Empty array if none. */
  list(tabId: number): MediaItem[] {
    const items = this.byTab.get(tabId);
    if (!items) return [];
    return [...items.values()].sort((a, b) => b.detectedAt - a.detectedAt);
  }

  /** Returns how many items a tab has found (cheap — avoids building the sorted array just to count). */
  count(tabId: number): number {
    return this.byTab.get(tabId)?.size ?? 0;
  }

  /** Clears a tab's items — called on navigation to a new page and on tab close. */
  clear(tabId: number): void {
    this.byTab.delete(tabId);
  }
}

function isQualityAlternate(items: Map<string, MediaItem>, url: string): boolean {
  for (const item of items.values()) {
    if (item.qualitySources?.some((source) => source.url === url)) return true;
  }
  return false;
}
