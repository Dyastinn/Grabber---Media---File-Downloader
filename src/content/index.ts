// WIRING ONLY — runs the pure scan() function against the real page DOM and
// reports results to the background service worker. No classification logic
// lives here; that's all in scan.ts / shared/media-types.ts.

import type { MediaFoundMessage } from "../shared/messages";
import { extractMediaItems } from "./scan";

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
