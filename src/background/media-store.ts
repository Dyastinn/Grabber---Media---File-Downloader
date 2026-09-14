// Pure class — no browser APIs. Single owner of "what media has each tab
// found so far." Background/index.ts is the only wiring code that touches
// this, and it only ever calls these three methods.

import type { MediaItem } from "../shared/media-types";

export class MediaStore {
  private readonly byTab = new Map<number, Map<string, MediaItem>>();

  /** Adds an item for a tab. Re-adding the same URL overwrites (e.g. once headers give us a size we didn't have before). */
  add(tabId: number, item: MediaItem): void {
    let items = this.byTab.get(tabId);
    if (!items) {
      items = new Map();
      this.byTab.set(tabId, items);
    }
    items.set(item.url, item);
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
