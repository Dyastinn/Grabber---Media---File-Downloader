// WIRING ONLY — runs the pure scan() function against the real page DOM and
// reports results to the background service worker. No classification logic
// lives here; that's all in scan.ts / shared/media-types.ts.

import {
  isSnifferMessage,
  SNIFFER_LISTENER_READY,
  type MediaFoundMessage,
  type Message,
  type RequestHeadersSeenMessage,
} from "../shared/messages";
import { extractMediaItems, manifestItem, pageTitle } from "./scan";

function reportFoundMedia(): void {
  const items = extractMediaItems(document, location.href);
  if (items.length === 0) return;
  const message: MediaFoundMessage = { type: "MEDIA_FOUND", items };
  chrome.runtime.sendMessage(message);
}

// Initial scan once the page has settled (manifest also sets run_at:
// "document_idle", so this mostly matters for content injected right at load).
reportFoundMedia();

// Many video/audio players (and "load more" style link lists) inject their
// markup after the initial page load, so we keep watching. Debounced because
// busy pages can mutate the DOM dozens of times a second and we only care
// about the settled result, not every intermediate state.
let debounceHandle: ReturnType<typeof setTimeout> | undefined;
const observer = new MutationObserver(() => {
  clearTimeout(debounceHandle);
  debounceHandle = setTimeout(reportFoundMedia, 500);
});
observer.observe(document.body, { childList: true, subtree: true, attributes: true });

// Failure diagnostics from the background worker are printed here, in the
// page's own console (F12) — the popup's console closes with the popup, and
// the worker's is buried in chrome://extensions.
chrome.runtime.onMessage.addListener((message: Message) => {
  if (message.type !== "DIAGNOSTIC") return;
  const { diagnostic } = message;
  console.error(
    `[Grabber] Couldn't fetch the ${diagnostic.stage} at ${diagnostic.host}: ${diagnostic.error}` +
      (diagnostic.networkError ? ` — browser reported ${diagnostic.networkError}` : "") +
      `\n${diagnostic.hint}`,
    diagnostic
  );
});

// The page-world sniffer (sniffer.ts) recognises manifests by their content
// and posts them here, since it has no chrome.* access of its own. Only
// same-window messages with our marker are trusted — any script on the page
// can call window.postMessage.
window.addEventListener("message", (event) => {
  if (event.source !== window || !isSnifferMessage(event.data)) return;
  const { url, kind, childUrls, requestHeaders } = event.data;
  if (requestHeaders) {
    const seen: RequestHeadersSeenMessage = { type: "REQUEST_HEADERS_SEEN", url, headers: requestHeaders };
    chrome.runtime.sendMessage(seen);
  }
  const message: MediaFoundMessage = {
    type: "MEDIA_FOUND",
    items: [
      manifestItem(url, kind, location.href, Date.now(), {
        ...(childUrls && { childUrls }),
        ...(pageTitle(document) !== undefined && { title: pageTitle(document) }),
      }),
    ],
  };
  chrome.runtime.sendMessage(message);
});
// Listener is attached above; tell the sniffer to flush anything it queued.
window.postMessage(SNIFFER_LISTENER_READY, "*");
