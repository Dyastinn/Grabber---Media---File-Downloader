// Pure type definitions — the exact shape of every message that crosses a
// browser-context boundary (content script <-> background <-> popup <->
// offscreen document).
// Every sender and every handler imports these same types, so a shape change
// is a compile error everywhere it's used instead of a silent runtime bug.

import type { FetchDiagnostic } from "../background/diagnostics";
import type { MediaItem, StreamKind } from "./media-types";
import type { StreamDownloadPlan } from "./stream-plan";

/** Content script -> background: items found on the page. */
export interface MediaFoundMessage {
  type: "MEDIA_FOUND";
  items: MediaItem[];
}

/** Popup -> background: "what has this tab found?" */
export interface GetMediaMessage {
  type: "GET_MEDIA";
  tabId: number;
}

/** Background -> popup: response to GetMediaMessage. */
export interface MediaListMessage {
  type: "MEDIA_LIST";
  items: MediaItem[];
}

/** Popup -> background: "download this file." */
export interface DownloadMessage {
  type: "DOWNLOAD";
  url: string;
  filename: string;
}

/**
 * Popup -> background: "download this stream."
 * The popup builds the plan (it already fetched and parsed the manifest to
 * show the quality picker), so the offscreen document only has to execute it.
 */
export interface DownloadStreamMessage {
  type: "DOWNLOAD_STREAM";
  /** The manifest URL — identifies this download in progress updates. */
  streamUrl: string;
  /** The page the stream was found on; used for Referer/Origin when no player request was observed. */
  sourceUrl: string;
  /** The tab showing that page — where failure diagnostics get logged. */
  tabId: number;
  plan: StreamDownloadPlan;
}

/**
 * Popup -> background: "my fetch of this URL failed." The background enriches
 * it with the browser's real network error and logs a diagnostic into the
 * tab's console (DiagnosticMessage) — the only place a user will look.
 */
export interface ReportFetchFailureMessage {
  type: "REPORT_FETCH_FAILURE";
  tabId: number;
  url: string;
  error: string;
}

/** Background -> content script: "print this in the page console." */
export interface DiagnosticMessage {
  type: "DIAGNOSTIC";
  diagnostic: FetchDiagnostic;
}

/**
 * Content script -> background: "the page fetched this URL with these
 * JS-set request headers." A second source for header replay next to the
 * background's own webRequest observation, which can miss a page's very
 * first request while the service worker is still starting up — and that
 * first request is typically the manifest carrying the token.
 */
export interface RequestHeadersSeenMessage {
  type: "REQUEST_HEADERS_SEEN";
  url: string;
  headers: Record<string, string>;
}

/**
 * Popup -> background: "I am about to fetch this URL from the extension;
 * make sure the site's request headers will be replayed on it." Answered
 * (with no payload) once the declarativeNetRequest rule is in place. See
 * background/request-headers.ts for why.
 */
export interface PrepareStreamFetchMessage {
  type: "PREPARE_STREAM_FETCH";
  url: string;
  sourceUrl: string;
}

/**
 * Background -> offscreen: "run this plan."
 * Distinct from DOWNLOAD_STREAM because chrome.runtime.sendMessage broadcasts
 * to every extension context: if the offscreen document listened for the
 * popup's own message it would start the download twice once it was open.
 */
export interface ExecuteStreamPlanMessage {
  type: "EXECUTE_STREAM_PLAN";
  streamUrl: string;
  plan: StreamDownloadPlan;
}

export type StreamPhase = "fetching" | "decrypting" | "muxing" | "saving";

/** Offscreen -> background -> popup: how far along a stream download is. */
export interface StreamProgressMessage {
  type: "STREAM_PROGRESS";
  streamUrl: string;
  phase: StreamPhase;
  /** 0-100. */
  percent: number;
}

/**
 * Offscreen -> background: "save this finished file." Offscreen documents
 * only get chrome.runtime, not chrome.downloads, so the merged MP4 is exposed
 * as a blob: URL (same extension origin, so the worker can read it) and the
 * background worker starts the download. Answered with
 * SaveStreamFileResultMessage once the browser has finished reading the blob,
 * so the sender knows when it is safe to revoke the URL.
 */
export interface SaveStreamFileMessage {
  type: "SAVE_STREAM_FILE";
  streamUrl: string;
  blobUrl: string;
  filename: string;
}

/** Background -> offscreen: response to SaveStreamFileMessage. */
export interface SaveStreamFileResultMessage {
  type: "SAVE_STREAM_FILE_RESULT";
  ok: boolean;
  error?: string;
}

/** Offscreen -> background: the download finished and was handed to chrome.downloads. */
export interface StreamCompleteMessage {
  type: "STREAM_COMPLETE";
  streamUrl: string;
  filename: string;
}

/** Offscreen -> background: the download failed. */
export interface StreamErrorMessage {
  type: "STREAM_ERROR";
  streamUrl: string;
  message: string;
  /** The segment/key/init URL whose fetch failed, when that is what went wrong. */
  failedUrl?: string;
}

/** Popup -> background: "is a stream download already running for this tab?" */
export interface GetStreamProgressMessage {
  type: "GET_STREAM_PROGRESS";
}

/** Background -> popup: response to GetStreamProgressMessage. */
export interface StreamProgressListMessage {
  type: "STREAM_PROGRESS_LIST";
  entries: StreamProgressEntry[];
}

export interface StreamProgressEntry {
  streamUrl: string;
  phase: StreamPhase | "done" | "error";
  percent: number;
  error?: string;
}

export type Message =
  | MediaFoundMessage
  | GetMediaMessage
  | MediaListMessage
  | DownloadMessage
  | DownloadStreamMessage
  | PrepareStreamFetchMessage
  | ReportFetchFailureMessage
  | DiagnosticMessage
  | RequestHeadersSeenMessage
  | ExecuteStreamPlanMessage
  | StreamProgressMessage
  | SaveStreamFileMessage
  | SaveStreamFileResultMessage
  | StreamCompleteMessage
  | StreamErrorMessage
  | GetStreamProgressMessage
  | StreamProgressListMessage;

// ---------------------------------------------------------------------------
// Page-world -> content-script bridge. This one does NOT travel over
// chrome.runtime: the sniffer (content/sniffer.ts) runs in the page's MAIN
// world with no chrome.* access, so it uses window.postMessage, and
// content/index.ts filters incoming window messages by `source` before
// trusting them (any page script can post to window).
// ---------------------------------------------------------------------------
export const SNIFFER_MESSAGE_SOURCE = "grabber-manifest-sniffer";
/**
 * Content script -> sniffer (window.postMessage): "I am listening now." The
 * sniffer runs at document_start, the content script at document_idle; a
 * manifest fetched in between would be posted to nobody, so the sniffer
 * queues until it hears this.
 */
export const SNIFFER_LISTENER_READY = "grabber-manifest-listener-ready";

/** Sniffer -> content script: "this response body was an HLS/DASH manifest." */
export interface SnifferMessage {
  source: typeof SNIFFER_MESSAGE_SOURCE;
  url: string;
  kind: StreamKind;
  /** For an HLS master: the variant/rendition playlist URLs it lists (see MediaItem.childUrls). */
  childUrls?: string[];
  /**
   * The JS-set request headers the page used to fetch this manifest
   * (Authorization, custom tokens…), lower-cased. The background replays
   * these on the extension's own fetches; see RequestHeadersSeenMessage.
   */
  requestHeaders?: Record<string, string>;
}

export function isSnifferMessage(data: unknown): data is SnifferMessage {
  if (typeof data !== "object" || data === null) return false;
  const candidate = data as Record<string, unknown>;
  const childUrls = candidate["childUrls"];
  const requestHeaders = candidate["requestHeaders"];
  return (
    candidate["source"] === SNIFFER_MESSAGE_SOURCE &&
    typeof candidate["url"] === "string" &&
    (candidate["kind"] === "hls" || candidate["kind"] === "dash") &&
    (childUrls === undefined ||
      (Array.isArray(childUrls) && childUrls.every((url) => typeof url === "string"))) &&
    (requestHeaders === undefined || isStringRecord(requestHeaders))
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}
