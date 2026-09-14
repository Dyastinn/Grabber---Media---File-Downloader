// WIRING ONLY — asks the background service worker for the active tab's
// media list, hands the data to the pure render.ts functions, and turns
// download-button clicks into DOWNLOAD messages. No classification or
// rendering logic lives here.

import type { DownloadMessage, GetMediaMessage, MediaListMessage } from "../shared/messages";
import { renderList } from "./render";

function getRoot(): HTMLElement {
  const el = document.getElementById("root");
  if (!el) throw new Error("popup.html is missing #root");
  return el;
}

const root = getRoot();

async function loadAndRender(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;

  const request: GetMediaMessage = { type: "GET_MEDIA", tabId: tab.id };
  const response = (await chrome.runtime.sendMessage(request)) as MediaListMessage;

  root.replaceChildren(renderList(response.items));
}

// Event delegation: one listener on the container instead of one per row,
// so re-rendering the list (loadAndRender replacing root's children) never
// needs to re-attach anything.
root.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".download-btn");
  if (!button) return;

  const url = button.dataset["url"];
  const filename = button.dataset["filename"];
  if (!url || !filename) return;

  const message: DownloadMessage = { type: "DOWNLOAD", url, filename };
  chrome.runtime.sendMessage(message);
});

void loadAndRender();
