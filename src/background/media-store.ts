// Pure class — no browser APIs. Single owner of "what media has each tab
// found so far." Background/index.ts is the only wiring code that touches
// this, and it only ever calls these three methods.

import type { MediaItem } from "../shared/media-types";

export class MediaStore {
  private readonly byTab = new Map<number, Map<string, MediaItem>>();

  /**
   * Adds an item for a tab. The same URL is typically reported more than once
   * — by the content script (which knows the page title and, for a master
   * playlist, which variant playlists it references) and by the network
   * watcher (which knows Content-Type and size, but names things after the
   * URL's last segment). Re-adds merge: the newest facts win, except that a
   * known title and the filename derived from it are never replaced by a
   * generic "master.m3u8", and a known list of related URLs is never dropped.
   *
   * URLs that another item already accounts for — a quality alternate in its
   * `qualitySources`, or a variant playlist in its `childUrls` — are parts of
   * that item's stream, not items of their own, whichever order they arrive in.
   */
  add(tabId: number, item: MediaItem): void {
    let items = this.byTab.get(tabId);
    if (!items) {
      items = new Map();
      this.byTab.set(tabId, items);
    }

    const merged = mergeItems(items.get(item.url), item);

    if (!hasChildren(merged) && isCoveredByAnother(items, merged.url)) return;
    for (const url of childUrlsOf(merged)) {
      if (url !== merged.url) items.delete(url);
    }

    items.set(merged.url, merged);
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

function mergeItems(existing: MediaItem | undefined, incoming: MediaItem): MediaItem {
  if (!existing) return incoming;
  const keepsTitledName = existing.title !== undefined && incoming.title === undefined;
  return {
    ...existing,
    ...incoming,
    ...(keepsTitledName && { title: existing.title, filename: existing.filename }),
  };
}

function childUrlsOf(item: MediaItem): string[] {
  return [
    ...(item.qualitySources?.map((source) => source.url) ?? []),
    ...(item.childUrls ?? []),
  ];
}

function hasChildren(item: MediaItem): boolean {
  return childUrlsOf(item).length > 0;
}

function isCoveredByAnother(items: Map<string, MediaItem>, url: string): boolean {
  for (const item of items.values()) {
    if (item.url !== url && childUrlsOf(item).includes(url)) return true;
  }
  return false;
}
