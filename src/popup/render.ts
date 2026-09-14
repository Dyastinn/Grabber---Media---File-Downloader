// Pure functions — each takes data and returns a DOM node. No chrome.*
// calls, no event listeners attached here (that's wiring, done in index.ts
// via event delegation on the returned elements' data-* attributes), so
// these are testable with plain jsdom.

import type { MediaCategory, MediaItem } from "../shared/media-types";

const CATEGORY_ORDER: MediaCategory[] = ["video", "audio", "image", "document", "archive", "other"];
const CATEGORY_LABEL: Record<MediaCategory, string> = {
  video: "Video",
  audio: "Audio",
  image: "Image",
  document: "Document",
  archive: "Archive",
  other: "Other",
};

export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function renderEmptyState(): HTMLElement {
  const el = document.createElement("p");
  el.className = "empty-state";
  el.textContent = "No downloadable media found on this page yet.";
  return el;
}

/**
 * A single row. Carries the URL/filename needed to trigger a download as
 * data-* attributes on the download button, rather than an attached click
 * handler — the wiring layer (index.ts) reads those via event delegation.
 */
export function renderRow(item: MediaItem): HTMLElement {
  const row = document.createElement("li");
  row.className = "media-row";

  const info = document.createElement("div");
  info.className = "media-info";

  const name = document.createElement("span");
  name.className = "media-filename";
  name.textContent = item.filename;
  info.appendChild(name);

  const size = formatSize(item.size);
  if (size) {
    const sizeEl = document.createElement("span");
    sizeEl.className = "media-size";
    sizeEl.textContent = size;
    info.appendChild(sizeEl);
  }

  row.appendChild(info);

  const button = document.createElement("button");
  button.className = "download-btn";
  button.type = "button";
  button.textContent = "Download";
  button.dataset["url"] = item.url;
  button.dataset["filename"] = item.filename;
  row.appendChild(button);

  return row;
}

function renderCategoryGroup(category: MediaCategory, items: MediaItem[]): HTMLElement {
  const section = document.createElement("section");
  section.className = "media-group";

  const heading = document.createElement("h2");
  heading.textContent = `${CATEGORY_LABEL[category]} (${items.length})`;
  section.appendChild(heading);

  const list = document.createElement("ul");
  list.className = "media-list";
  for (const item of items) list.appendChild(renderRow(item));
  section.appendChild(list);

  return section;
}

/** Renders the full popup body for a list of items, grouped by category. */
export function renderList(items: MediaItem[]): HTMLElement {
  const container = document.createElement("div");

  if (items.length === 0) {
    container.appendChild(renderEmptyState());
    return container;
  }

  const byCategory = new Map<MediaCategory, MediaItem[]>();
  for (const item of items) {
    const group = byCategory.get(item.category) ?? [];
    group.push(item);
    byCategory.set(item.category, group);
  }

  for (const category of CATEGORY_ORDER) {
    const group = byCategory.get(category);
    if (group && group.length > 0) container.appendChild(renderCategoryGroup(category, group));
  }

  return container;
}
