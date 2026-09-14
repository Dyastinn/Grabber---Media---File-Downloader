// Pure type definitions — the exact shape of every message that crosses a
// browser-context boundary (content script <-> background <-> popup).
// Every sender and every handler imports these same types, so a shape change
// is a compile error everywhere it's used instead of a silent runtime bug.

import type { MediaItem } from "./media-types";

/** Content script -> background: items found on the page. */
export interface MediaFoundMessage {
  type: "MEDIA_FOUND";
  items: MediaItem[];
}

/** Popup -> background: "what has this tab found so far?" */
export interface GetMediaMessage {
  type: "GET_MEDIA";
  tabId: number;
}

/** Background -> popup: response to GetMediaMessage. */
export interface MediaListMessage {
  type: "MEDIA_LIST";
  items: MediaItem[];
}

/** Popup -> background: "download this item." */
export interface DownloadMessage {
  type: "DOWNLOAD";
  url: string;
  filename: string;
}

export type Message = MediaFoundMessage | GetMediaMessage | MediaListMessage | DownloadMessage;
