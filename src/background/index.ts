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

import { classifyMedia, type MediaItem } from "../shared/media-types";
import { guessFilename } from "../shared/filename";
import type { Message, StreamProgressListMessage } from "../shared/messages";
import type { StreamDownloadPlan } from "../shared/stream-plan";
import { MediaStore } from "./media-store";
import { StreamProgressStore } from "./stream-progress-store";

const store = new MediaStore();
const streamProgress = new StreamProgressStore();

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

    const classification = classifyMedia(details.url, contentType);
    if (!classification) return;

    const isStream = classification.category === "stream";

    const item: MediaItem = {
      url: details.url,
      category: classification.category,
      filename: guessFilename(details.url, contentDisposition),
      sourceUrl: details.url,
      detectedAt: Date.now(),
      ...(classification.streamKind && { streamKind: classification.streamKind }),
      ...(contentType !== undefined && { contentType }),
      // A manifest's Content-Length is the size of the playlist text, not of
      // the video, so reporting it would be actively misleading.
      ...(!isStream && contentLength !== undefined && { size: Number(contentLength) }),
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

    case "DOWNLOAD_STREAM": {
      // Ignore a second request for a download that's already running — the
      // popup disables the button, but it can be reopened mid-download.
      if (streamProgress.isActive(message.streamUrl)) break;
      streamProgress.update(message.streamUrl, "fetching", 0);
      void startStreamDownload(message.streamUrl, message.plan);
      break;
    }

    // The offscreen document broadcasts these; the popup listens for them too,
    // so it can update live. The background tracks them so a popup that was
    // closed and reopened can still see where a download got to.
    case "STREAM_PROGRESS": {
      streamProgress.update(message.streamUrl, message.phase, message.percent);
      break;
    }

    case "STREAM_COMPLETE": {
      streamProgress.complete(message.streamUrl);
      notify("Download complete", message.filename);
      break;
    }

    case "STREAM_ERROR": {
      streamProgress.fail(message.streamUrl, message.message);
      notify("Download failed", message.message);
      break;
    }

    case "GET_STREAM_PROGRESS": {
      const response: StreamProgressListMessage = {
        type: "STREAM_PROGRESS_LIST",
        entries: streamProgress.list(),
      };
      sendResponse(response);
      break;
    }
  }
  // No async work blocks any sendResponse above — both responding branches
  // (GET_MEDIA, GET_STREAM_PROGRESS) answer synchronously — so we don't return true.
});

// ---------------------------------------------------------------------------
// 4. Stream downloads: ffmpeg.wasm can't run in a service worker, so the work
//    happens in an offscreen document that this worker creates on demand.
// ---------------------------------------------------------------------------
async function startStreamDownload(streamUrl: string, plan: StreamDownloadPlan): Promise<void> {
  try {
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({ type: "EXECUTE_STREAM_PLAN", streamUrl, plan });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    streamProgress.fail(streamUrl, reason);
    notify("Download failed", reason);
  }
}

let offscreenCreation: Promise<void> | undefined;

/** Creates the offscreen document once; concurrent callers await the same creation. */
async function ensureOffscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;

  offscreenCreation ??= chrome.offscreen
    .createDocument({
      url: "offscreen/offscreen.html",
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: "Runs ffmpeg.wasm to merge downloaded video stream segments into one file.",
    })
    .finally(() => {
      offscreenCreation = undefined;
    });

  await offscreenCreation;
}

function notify(title: string, message: string): void {
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title,
    message,
  });
}

// ---------------------------------------------------------------------------
// 4. Badge: a quick visual count on the toolbar icon for the active tab.
// ---------------------------------------------------------------------------
function updateBadge(tabId: number): void {
  const count = store.count(tabId);
  chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : "" });
}
