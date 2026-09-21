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

import { classifyMedia, isStreamSegment, type MediaItem } from "../shared/media-types";
import { guessFilename } from "../shared/filename";
import type {
  DiagnosticMessage,
  Message,
  SaveStreamFileMessage,
  SaveStreamFileResultMessage,
  StreamProgressListMessage,
} from "../shared/messages";
import type { StreamDownloadPlan } from "../shared/stream-plan";
import { buildFetchDiagnostic, NetworkErrorLog, type FetchDiagnostic } from "./diagnostics";
import { MediaStore } from "./media-store";
import {
  buildHeaderRule,
  fallbackHeaders,
  originOf,
  RequestHeaderStore,
  type HeaderMap,
} from "./request-headers";
import { StreamProgressStore } from "./stream-progress-store";

const store = new MediaStore();
const streamProgress = new StreamProgressStore();
const requestHeaders = new RequestHeaderStore();
const networkErrors = new NetworkErrorLog();
/** Which tab each running stream download was started from, for its diagnostics. */
const streamTabs = new Map<string, number>();

const WATCHED_REQUEST_TYPES: chrome.webRequest.ResourceType[] = ["media", "xmlhttprequest", "object", "other"];

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

    // A player fetches dozens of segments a minute; those are parts of a
    // stream (listed under its manifest), not thirty separate videos.
    if (isStreamSegment(details.url, contentType)) return;

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
  { urls: ["<all_urls>"], types: WATCHED_REQUEST_TYPES },
  ["responseHeaders"]
);

// ---------------------------------------------------------------------------
// 1b. Remember the request headers the page sends to each origin (Referer,
//     Origin, Authorization, custom tokens…). The popup and offscreen document
//     fetch from the extension's own origin, and servers that check those
//     headers answer 403 unless we replay them — see request-headers.ts.
//     Every fetch-style request counts, not just ones that look like media:
//     the playlist that needs the token is often exactly the one whose URL
//     says nothing (/api/stream/1234). "extraHeaders" is what makes
//     Referer/Origin visible in Chrome; Firefox doesn't know the option,
//     hence the fallback.
// ---------------------------------------------------------------------------
function rememberRequestHeaders(details: chrome.webRequest.WebRequestHeadersDetails): void {
  if (details.tabId < 0 || !details.requestHeaders) return;
  if (details.method === "OPTIONS") return; // a CORS preflight carries nothing worth replaying
  if (requestHeaders.record(details.url, details.requestHeaders)) {
    void installHeaderRule(details.url, requestHeaders.get(details.url) ?? {});
  }
}
try {
  chrome.webRequest.onSendHeaders.addListener(
    rememberRequestHeaders,
    { urls: ["<all_urls>"], types: WATCHED_REQUEST_TYPES },
    ["requestHeaders", "extraHeaders"]
  );
} catch {
  chrome.webRequest.onSendHeaders.addListener(
    rememberRequestHeaders,
    { urls: ["<all_urls>"], types: WATCHED_REQUEST_TYPES },
    ["requestHeaders"]
  );
}

// ---------------------------------------------------------------------------
// 1c. Remember the browser's own reason for a failed request. fetch() in the
//     popup/offscreen document only ever sees "Failed to fetch"; the real
//     cause (ERR_BLOCKED_BY_CLIENT, ERR_CONNECTION_REFUSED, …) is here.
// ---------------------------------------------------------------------------
chrome.webRequest.onErrorOccurred.addListener(
  (details) => networkErrors.record(details.url, details.error),
  { urls: ["<all_urls>"] }
);

/** Builds and logs the diagnostic for a failed extension fetch, in the worker's console and the tab's. */
function reportFetchFailure(tabId: number, url: string, stage: FetchDiagnostic["stage"], error: string): void {
  const diagnostic = buildFetchDiagnostic({
    url,
    stage,
    error,
    ...(networkErrors.get(url) !== undefined && { networkError: networkErrors.get(url) }),
    ...(requestHeaders.get(url) && { replayedHeaders: requestHeaders.get(url) }),
  });
  console.error("[Grabber] fetch failed", diagnostic);
  const message: DiagnosticMessage = { type: "DIAGNOSTIC", diagnostic };
  chrome.tabs.sendMessage(tabId, message).catch(() => undefined); // tab may be gone
}

/** What each origin's session rule currently sets, so unchanged headers don't rewrite it. */
const installedRules = new Map<string, { fingerprint: string; done: Promise<void> }>();

/**
 * Makes the extension's own requests to `url`'s origin carry `headers`.
 * Resolves once the rule is live — a caller about to fetch must await it,
 * even when an identical install is already in flight. No-op where
 * declarativeNetRequest is unavailable (Firefox < 113).
 */
function installHeaderRule(url: string, headers: HeaderMap): Promise<void> {
  const origin = originOf(url);
  if (!origin || Object.keys(headers).length === 0 || !chrome.declarativeNetRequest) return Promise.resolve();

  const fingerprint = JSON.stringify(headers);
  const current = installedRules.get(origin);
  if (current?.fingerprint === fingerprint) return current.done;

  const rule = buildHeaderRule(origin, headers, chrome.runtime.id);
  // Session rules survive a service-worker restart but not a browser
  // restart; removing the id first makes this an upsert either way.
  const done = chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: [rule.id], addRules: [rule] })
    .catch((error: unknown) => {
      installedRules.delete(origin);
      console.warn("Couldn't install request-header rule for", origin, error);
    });
  installedRules.set(origin, { fingerprint, done });
  return done;
}

/**
 * Rule for a URL about to be fetched. Referer/Origin derived from the page go
 * underneath whatever was recorded: the recorded set can be JS-set headers
 * only (the sniffer's view, when the page loaded before the worker could
 * observe its requests), and most hotlink checks want the Referer too.
 */
function prepareFetch(url: string, sourceUrl: string): Promise<void> {
  return installHeaderRule(url, { ...fallbackHeaders(sourceUrl), ...requestHeaders.get(url) });
}

/** Every distinct origin a plan will fetch from — segments, init segments and decryption keys. */
function planOrigins(plan: StreamDownloadPlan): Set<string> {
  const origins = new Set<string>();
  const add = (url: string | undefined): void => {
    const origin = url && originOf(url);
    if (origin) origins.add(origin);
  };
  for (const track of [plan.video, plan.audio]) {
    if (!track) continue;
    add(track.initUrl);
    for (const segment of track.segments) {
      add(segment.url);
      add(segment.decryption?.keyUrl);
    }
  }
  return origins;
}

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
      streamTabs.set(message.streamUrl, message.tabId);
      void startStreamDownload(message.streamUrl, message.sourceUrl, message.plan);
      break;
    }

    case "REPORT_FETCH_FAILURE": {
      reportFetchFailure(message.tabId, message.url, "manifest", message.error);
      break;
    }

    case "REQUEST_HEADERS_SEEN": {
      // The page-world sniffer saw these on the manifest request itself —
      // covers the case where onSendHeaders missed it (worker still starting).
      const entries = Object.entries(message.headers).map(([name, value]) => ({ name, value }));
      if (requestHeaders.record(message.url, entries)) {
        void installHeaderRule(message.url, requestHeaders.get(message.url) ?? {});
      }
      break;
    }

    case "PREPARE_STREAM_FETCH": {
      void prepareFetch(message.url, message.sourceUrl).then(() => sendResponse(undefined));
      return true;
    }

    // The offscreen document broadcasts these; the popup listens for them too,
    // so it can update live. The background tracks them so a popup that was
    // closed and reopened can still see where a download got to.
    case "STREAM_PROGRESS": {
      streamProgress.update(message.streamUrl, message.phase, message.percent);
      break;
    }

    case "SAVE_STREAM_FILE": {
      // Answered once the download finishes — the only asynchronous response here.
      void saveStreamFile(message).then(sendResponse);
      return true;
    }

    case "STREAM_COMPLETE": {
      streamProgress.complete(message.streamUrl);
      notify("Download complete", message.filename);
      break;
    }

    case "STREAM_ERROR": {
      streamProgress.fail(message.streamUrl, message.message);
      notify("Download failed", message.message);
      const tabId = streamTabs.get(message.streamUrl);
      if (tabId !== undefined && message.failedUrl) {
        reportFetchFailure(tabId, message.failedUrl, "segment", message.message);
      }
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
  // GET_MEDIA and GET_STREAM_PROGRESS answer synchronously; only the
  // SAVE_STREAM_FILE and PREPARE_STREAM_FETCH branches return true to keep
  // their sendResponse alive.
  return false;
});

// ---------------------------------------------------------------------------
// 4. Stream downloads: ffmpeg.wasm can't run in a service worker, so the work
//    happens in an offscreen document that this worker creates on demand.
// ---------------------------------------------------------------------------
async function startStreamDownload(
  streamUrl: string,
  sourceUrl: string,
  plan: StreamDownloadPlan
): Promise<void> {
  try {
    // The offscreen document's segment fetches need the same headers the
    // player sent (the segment CDN is often a different origin from the manifest).
    await Promise.all(
      [...planOrigins(plan)].map((origin) => prepareFetch(`${origin}/`, sourceUrl))
    );
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({ type: "EXECUTE_STREAM_PLAN", streamUrl, plan });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    streamProgress.fail(streamUrl, reason);
    notify("Download failed", reason);
  }
}

/**
 * Downloads the offscreen document's finished file and resolves once the
 * browser has read all of it (or given up), so the sender can revoke the blob.
 */
async function saveStreamFile(message: SaveStreamFileMessage): Promise<SaveStreamFileResultMessage> {
  try {
    const downloadId = await chrome.downloads.download({
      url: message.blobUrl,
      filename: message.filename,
    });
    const error = await new Promise<string | undefined>((resolve) => {
      const finish = (result: string | undefined): void => {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve(result);
      };
      const onChanged = (delta: chrome.downloads.DownloadDelta): void => {
        if (delta.id !== downloadId || !delta.state) return;
        if (delta.state.current === "complete") finish(undefined);
        if (delta.state.current === "interrupted") finish(delta.error?.current ?? "Download interrupted.");
      };
      chrome.downloads.onChanged.addListener(onChanged);
      // The download may already have finished before the listener was attached.
      chrome.downloads.search({ id: downloadId }, ([item]) => {
        if (item?.state === "complete") finish(undefined);
        if (item?.state === "interrupted") finish(item.error ?? "Download interrupted.");
      });
    });
    return { type: "SAVE_STREAM_FILE_RESULT", ok: error === undefined, ...(error && { error }) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { type: "SAVE_STREAM_FILE_RESULT", ok: false, error: reason };
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
