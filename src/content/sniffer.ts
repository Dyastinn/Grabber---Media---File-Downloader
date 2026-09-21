// WIRING ONLY — runs in the page's MAIN world (see manifest.json), not the
// isolated content-script world, because only there can it wrap the page's
// own fetch() and XMLHttpRequest. It looks at the START of every text-ish
// response the player receives and, when it is an HLS playlist or DASH MPD,
// tells the isolated-world content script (content/index.ts) via
// window.postMessage. That script owns all chrome.* messaging; this file has
// no access to chrome.* at all.
//
// Why this exists: the background network watcher classifies by URL extension
// and Content-Type. Private players routinely serve playlists from URLs like
// /api/stream/1234 with Content-Type text/plain or application/octet-stream,
// which is invisible to that watcher while the segments it lists are not — so
// the popup showed thirty "video66.ts" rows and no stream. Sniffing the body
// is the only way to catch those.

import { isMasterPlaylist, parseMasterPlaylist } from "../shared/hls-playlist";
import { headersFromFetchArgs, type HeaderRecord } from "./fetch-headers";
import { sniffManifestKind } from "../shared/media-types";
import { SNIFFER_LISTENER_READY, SNIFFER_MESSAGE_SOURCE, type SnifferMessage } from "../shared/messages";

/** Anything larger than this is media, not a playlist — don't read it. */
const MAX_SNIFF_BODY = 4 * 1024 * 1024;

const reported = new Set<string>();

// The isolated-world content script (the only thing listening for our
// messages) is injected later than this script. Hold messages until it says
// it is ready, else early manifests — usually THE manifest — are lost.
let listenerReady = false;
const pending: SnifferMessage[] = [];

function post(message: SnifferMessage): void {
  if (listenerReady) window.postMessage(message, "*");
  else pending.push(message);
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data !== SNIFFER_LISTENER_READY) return;
  listenerReady = true;
  for (const message of pending.splice(0)) window.postMessage(message, "*");
});

function report(url: string, text: string, requestHeaders: HeaderRecord): void {
  if (!url || url.startsWith("blob:") || url.startsWith("data:")) return; // nothing re-fetchable
  const kind = sniffManifestKind(text);
  if (!kind || reported.has(url)) return;
  reported.add(url);

  // A master's variant playlists get fetched by the player next (and land
  // here too); naming them lets the store fold them into this one item.
  const childUrls = kind === "hls" && isMasterPlaylist(text) ? masterChildren(text, url) : [];

  const message: SnifferMessage = {
    source: SNIFFER_MESSAGE_SOURCE,
    url,
    kind,
    ...(childUrls.length > 0 && { childUrls }),
    ...(Object.keys(requestHeaders).length > 0 && { requestHeaders }),
  };
  post(message);
}

function masterChildren(text: string, url: string): string[] {
  try {
    const master = parseMasterPlaylist(text, url);
    const urls = master.variants.map((variant) => variant.url);
    for (const rendition of master.audioRenditions) if (rendition.url) urls.push(rendition.url);
    return [...new Set(urls)];
  } catch {
    return [];
  }
}

/** Media bodies are never playlists; skip them without reading. */
function mightBeManifest(contentType: string | null, contentLength: string | null): boolean {
  if (contentLength && Number(contentLength) > MAX_SNIFF_BODY) return false;
  if (!contentType) return true;
  const type = contentType.toLowerCase();
  return !type.startsWith("video/") && !type.startsWith("audio/") && !type.startsWith("image/");
}

// ---------------------------------------------------------------------------
// fetch(): clone the response so reading the head doesn't consume the body
// the player is about to parse.
// ---------------------------------------------------------------------------
const originalFetch = window.fetch;
window.fetch = async function sniffingFetch(input, init) {
  // Read before the call: a Request body/headers may be consumed by it.
  let requestHeaders: HeaderRecord = {};
  try {
    requestHeaders = headersFromFetchArgs(input, init);
  } catch {
    // A malformed headers init will make the real fetch throw below anyway.
  }
  const response = await originalFetch.call(this, input, init);
  try {
    const headers = response.headers;
    if (response.ok && mightBeManifest(headers.get("content-type"), headers.get("content-length"))) {
      void response
        .clone()
        .text()
        .then((text) => report(response.url, text, requestHeaders))
        .catch(() => undefined);
    }
  } catch {
    // Never let sniffing break the page's own request.
  }
  return response;
};

// ---------------------------------------------------------------------------
// XMLHttpRequest: many HLS players (hls.js among them) load playlists this
// way, as text. Segments are usually requested as arraybuffer, which is not
// read at all.
// ---------------------------------------------------------------------------
const xhrHeaders = new WeakMap<XMLHttpRequest, HeaderRecord>();

const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
XMLHttpRequest.prototype.setRequestHeader = function sniffingSetRequestHeader(
  this: XMLHttpRequest,
  name: string,
  value: string
) {
  try {
    let headers = xhrHeaders.get(this);
    if (!headers) xhrHeaders.set(this, (headers = {}));
    headers[String(name).toLowerCase()] = String(value);
  } catch {
    // Never let sniffing break the page's own request.
  }
  return originalSetRequestHeader.call(this, name, value);
};

const originalOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function sniffingOpen(this: XMLHttpRequest, ...args: unknown[]) {
  xhrHeaders.delete(this); // open() resets a reused XHR's headers
  this.addEventListener("load", () => {
    try {
      if (this.status < 200 || this.status >= 300) return;
      if (this.responseType !== "" && this.responseType !== "text") return;
      if (!mightBeManifest(this.getResponseHeader("content-type"), this.getResponseHeader("content-length"))) return;
      report(this.responseURL, this.responseText, xhrHeaders.get(this) ?? {});
    } catch {
      // As above: sniffing must be invisible to the page.
    }
  });
  return (originalOpen as (...a: unknown[]) => void).apply(this, args);
} as typeof XMLHttpRequest.prototype.open;
