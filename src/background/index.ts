// WIRING ONLY — this file's job is to connect real chrome.* events to the
// pure logic in shared/ and media-store.ts. No classification or filename
// logic lives here; if you're adding a rule for "what counts as media," it
// belongs in shared/media-types.ts, not here.
//
// This runs as a Manifest V3 background "service worker" — a script the
// browser starts on demand (when an event it's listening for fires) and can
// kill when idle to save memory. That's why all state lives in MediaStore
// instead of top-level variables we'd expect to persist forever: if the
// worker restarts, a fresh page scan repopulates it, which is fine for v0.1.

import { classifyMedia, isStreamingManifest, type MediaItem } from "../shared/media-types";
import { guessFilename } from "../shared/filename";
import type { Message } from "../shared/messages";
import { MediaStore } from "./media-store";

const store = new MediaStore();

// ---------------------------------------------------------------------------
// 1. Network layer: catch media/files the page loads directly (e.g. a
//    <video src> request, or a direct link the user clicked), even if
//    there's no matching DOM element (some players set src via JS after
//    fetching a blob, for example).
//
//    onHeadersReceived here is "observational" — we only read the response,
//    we don't call event.preventDefault() or modify anything. MV3 removed
//    *blocking* webRequest for most extensions, but read-only observation
//    like this is still fully supported in Chrome, Edge, and Firefox.
// ---------------------------------------------------------------------------
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return; // not associated with a tab (e.g. a service worker's own fetch)

    const headers = details.responseHeaders ?? [];
    const contentType = findHeader(headers, "content-type");
    const contentLength = findHeader(headers, "content-length");
    const contentDisposition = findHeader(headers, "content-disposition");

    if (isStreamingManifest(details.url)) return; // HLS/DASH — explicitly out of scope for v0.1

    const category = classifyMedia(details.url, contentType);
    if (!category) return;

    const item: MediaItem = {
      url: details.url,
      category,
      filename: guessFilename(details.url, contentDisposition),
      sourceUrl: details.url,
      detectedAt: Date.now(),
      ...(contentType !== undefined && { contentType }),
      ...(contentLength !== undefined && { size: Number(contentLength) }),
    };

    store.add(details.tabId, item);
    updateBadge(details.tabId);
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "object", "other"] },
  ["responseHeaders"]
);

function findHeader(headers: chrome.webRequest.HttpHeader[], name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name)?.value;
}

// ---------------------------------------------------------------------------
// 2. Lifecycle: a tab's media list represents "what's on the current page,"
//    so it needs to reset on navigation and go away when the tab closes.
// ---------------------------------------------------------------------------
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return; // ignore iframe navigations, only top-level page loads
  store.clear(details.tabId);
  updateBadge(details.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  store.clear(tabId);
});

// ---------------------------------------------------------------------------
// 3. Messages: the content script reports DOM-found media, the popup asks
//    for the current tab's list and requests downloads.
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  switch (message.type) {
    case "MEDIA_FOUND": {
      const tabId = sender.tab?.id;
      if (tabId === undefined) break;
      for (const item of message.items) store.add(tabId, item);
      updateBadge(tabId);
      break;
    }

    case "GET_MEDIA": {
      sendResponse({ type: "MEDIA_LIST", items: store.list(message.tabId) });
      break;
    }

    case "DOWNLOAD": {
      chrome.downloads.download({ url: message.url, filename: message.filename });
      break;
    }
  }
  // No async work follows any of the branches above, so we don't return true —
  // sendResponse (used only by GET_MEDIA) has already been called synchronously.
});

// ---------------------------------------------------------------------------
// 4. Badge: a quick visual count on the toolbar icon for the active tab.
// ---------------------------------------------------------------------------
function updateBadge(tabId: number): void {
  const count = store.count(tabId);
  chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : "" });
}
