// Pure logic — no chrome.* calls. Builds the diagnostic the extension logs
// into the page's console when one of its own fetches fails. A plain
// "Failed to fetch" tells the user nothing; the browser's real network error
// (net::ERR_BLOCKED_BY_CLIENT, ERR_CONNECTION_REFUSED, a CORS failure…) is
// only visible to the background worker, so it is gathered there and sent
// down to the tab.

import type { HeaderMap } from "./request-headers";

export interface FetchDiagnostic {
  /** What was being fetched. */
  url: string;
  host: string;
  /** "manifest" (popup) or "segment" (offscreen document). */
  stage: "manifest" | "segment";
  /** The JavaScript-level error text, e.g. "Failed to fetch" or "HTTP 403". */
  error: string;
  /** The browser's network error for that URL, when one was observed (webRequest.onErrorOccurred). */
  networkError?: string;
  /** Request headers the extension replayed on its own fetches to that origin, if any. */
  replayedHeaders?: HeaderMap;
  /** Human-readable reading of the above. */
  hint: string;
}

/** Keeps the most recent network error per URL, bounded (oldest URL out). */
export class NetworkErrorLog {
  private readonly byUrl = new Map<string, string>();

  constructor(private readonly maxEntries = 200) {}

  record(url: string, error: string): void {
    this.byUrl.delete(url);
    this.byUrl.set(url, error);
    if (this.byUrl.size > this.maxEntries) {
      const oldest = this.byUrl.keys().next().value;
      if (oldest !== undefined) this.byUrl.delete(oldest);
    }
  }

  get(url: string): string | undefined {
    return this.byUrl.get(url);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Turns the raw facts into the one line a person should read first. */
export function explain(error: string, networkError: string | undefined, replayed: HeaderMap | undefined): string {
  const net = networkError ?? "";
  if (net.includes("ERR_BLOCKED_BY_CLIENT")) {
    return "The browser blocked this request — another extension (ad/tracker blocker) or a site rule is rejecting it.";
  }
  if (net.includes("ERR_CONNECTION_REFUSED") || net.includes("ERR_NAME_NOT_RESOLVED") || net.includes("ERR_ADDRESS")) {
    return "The host isn't reachable from the browser at all (not a permissions problem).";
  }
  if (net.includes("ERR_CERT") || net.includes("ERR_SSL")) {
    return "TLS certificate problem on the media host.";
  }
  if (net.includes("ERR_ABORTED")) {
    return "The request was aborted before completing.";
  }
  if (net.includes("ERR_FAILED")) {
    return "The browser rejected the response (usually CORS). Check chrome://extensions → this extension → Details → \"Site access\" is \"On all sites\"; with a narrower setting the extension's cross-origin fetches are not exempt from CORS.";
  }
  if (/HTTP 401|HTTP 403/.test(error)) {
    return replayed && Object.keys(replayed).length > 0
      ? `The server refused the request even with the replayed headers (${Object.keys(replayed).join(", ")}); it may bind the URL to a session, a one-time token, or a Range request.`
      : "The server refused the request and no player request headers had been seen yet — play the video first, then retry.";
  }
  if (/HTTP 3\d\d/.test(error)) return "The server redirected — usually to a login page.";
  if (net) return `Network-level failure: ${net}.`;
  return "Network-level failure with no recorded cause — check the popup's DevTools Network tab (right-click the popup → Inspect).";
}

export function buildFetchDiagnostic(input: {
  url: string;
  stage: FetchDiagnostic["stage"];
  error: string;
  networkError?: string;
  replayedHeaders?: HeaderMap;
}): FetchDiagnostic {
  const { url, stage, error, networkError, replayedHeaders } = input;
  return {
    url,
    host: hostOf(url),
    stage,
    error,
    ...(networkError !== undefined && { networkError }),
    ...(replayedHeaders && Object.keys(replayedHeaders).length > 0 && { replayedHeaders }),
    hint: explain(error, networkError, replayedHeaders),
  };
}
