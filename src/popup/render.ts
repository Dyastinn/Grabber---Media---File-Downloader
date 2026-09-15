// Pure functions — each takes data and returns a DOM node. No chrome.*
// calls, no event listeners attached here (that's wiring, done in index.ts
// via event delegation on the returned elements' data-* attributes), so
// these are testable with plain jsdom.

import type { StreamProgressEntry } from "../shared/messages";
import type { MediaCategory, MediaItem } from "../shared/media-types";

// Streams first: they're usually what someone opened the extension for on a
// video page, and they're the only category needing an extra choice.
const CATEGORY_ORDER: MediaCategory[] = [
  "stream",
  "video",
  "audio",
  "image",
  "document",
  "archive",
  "other",
];
const CATEGORY_LABEL: Record<MediaCategory, string> = {
  stream: "Video stream",
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
  // An empty screen is an invitation, not a report: say what to do next.
  el.textContent = "Nothing to grab yet. Start a video or open a file, and it shows up here.";
  return el;
}

/** The header tally. Empty when nothing is found — the empty state says it better. */
export function formatFoundCount(count: number): string {
  if (count === 0) return "";
  return count === 1 ? "1 found" : `${count} found`;
}

/**
 * A single row. Carries the URL/filename needed to trigger a download as
 * data-* attributes on the download button, rather than an attached click
 * handler — the wiring layer (index.ts) reads those via event delegation.
 */
export function renderRow(item: MediaItem): HTMLElement {
  const row = document.createElement("li");
  row.className = "media-row";
  // Lets the wiring layer find this row again to show a picker or progress bar.
  row.dataset["url"] = item.url;
  // Not painted from today, but it tells wiring or a future style what the
  // row is without a lookup.
  row.dataset["category"] = item.category;

  const main = document.createElement("div");
  main.className = "media-main";

  const info = document.createElement("div");
  info.className = "media-info";

  const name = document.createElement("span");
  name.className = "media-filename";
  name.textContent = item.filename;
  // The name is truncated with an ellipsis; the tooltip keeps it recoverable.
  name.title = item.filename;
  info.appendChild(name);

  const size = formatSize(item.size);
  if (size) {
    const sizeEl = document.createElement("span");
    sizeEl.className = "media-size";
    sizeEl.textContent = size;
    info.appendChild(sizeEl);
  }

  main.appendChild(info);

  const button = document.createElement("button");
  button.type = "button";
  button.dataset["url"] = item.url;

  if (item.category === "stream") {
    // A stream is a manifest, not a file: the user picks a quality first, and
    // the download is assembled from many segments.
    button.className = "quality-btn";
    button.textContent = "Choose quality";
  } else {
    button.className = "download-btn";
    button.textContent = "Download";
    button.dataset["filename"] = item.filename;
  }

  main.appendChild(button);
  row.appendChild(main);

  // Where the quality picker / progress bar / error message gets swapped in.
  // Live, so a phase change or an error is announced, not just shown.
  const extra = document.createElement("div");
  extra.className = "row-extra";
  extra.setAttribute("aria-live", "polite");
  row.appendChild(extra);

  return row;
}

/** One selectable quality in the stream picker. */
export interface QualityOption {
  label: string;
  detail?: string;
  /**
   * Relative size of this rung, 0-1, drawn as the length of its bar. Only the
   * HLS-master and DASH paths know a bitrate; `weightRungs` falls back to
   * resolution height and otherwise leaves this undefined, in which case the
   * rung renders as a plain row with no bar rather than an empty one.
   */
  weight?: number;
}

/** Shortest bar that still reads as a bar, so a tightly-clustered ladder
 *  (5.0 / 4.5 / 4.0 Mbps) doesn't flatten into three identical lengths. */
const MIN_WEIGHT = 0.12;

/**
 * Turns raw per-rung magnitudes (bitrate, or resolution height as a stand-in)
 * into 0-1 bar weights scaled against the largest. Returns all-undefined when
 * no rung has a usable magnitude, or when every rung is identical — a ladder
 * of equal bars says nothing.
 */
export function weightRungs(magnitudes: (number | undefined)[]): (number | undefined)[] {
  const usable = magnitudes.filter((m): m is number => typeof m === "number" && m > 0);
  const max = Math.max(0, ...usable);
  if (usable.length < 2 || max === 0) return magnitudes.map(() => undefined);
  if (usable.every((m) => m === max)) return magnitudes.map(() => undefined);

  return magnitudes.map((m) =>
    typeof m === "number" && m > 0 ? MIN_WEIGHT + (1 - MIN_WEIGHT) * (m / max) : undefined
  );
}

/**
 * The quality picker: a ladder of rungs, each bar's length its bitrate
 * relative to the top rung. Each button carries its index, which the wiring
 * layer maps back to the parsed variant it stashed when the manifest was
 * fetched.
 */
export function renderQualityOptions(options: QualityOption[]): HTMLElement {
  const container = document.createElement("div");
  container.className = "quality-options";

  for (const [index, option] of options.entries()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quality-option";
    button.dataset["index"] = String(index);
    if (option.weight !== undefined) {
      button.style.setProperty("--weight", String(option.weight));
    }

    const label = document.createElement("span");
    label.className = "quality-label";
    label.textContent = option.label;
    button.appendChild(label);

    if (option.detail) {
      const detail = document.createElement("span");
      detail.className = "quality-detail";
      detail.textContent = option.detail;
      button.appendChild(detail);
    }

    container.appendChild(button);
  }

  return container;
}

const PHASE_LABEL: Record<StreamProgressEntry["phase"], string> = {
  fetching: "Downloading segments",
  decrypting: "Decrypting",
  muxing: "Merging video and audio",
  saving: "Saving",
  done: "Saved",
  error: "Failed",
};

/** Progress bar for an in-flight (or finished) stream download. */
export function renderStreamProgress(entry: StreamProgressEntry): HTMLElement {
  const container = document.createElement("div");
  container.className = `stream-progress stream-progress-${entry.phase}`;

  // Label on the left, percentage on the right, both over the bar they
  // describe — no joined "label — 40%" string to read through.
  const status = document.createElement("div");
  status.className = "progress-status";

  const label = document.createElement("span");
  label.className = "progress-label";
  label.textContent = entry.phase === "error" ? (entry.error ?? PHASE_LABEL.error) : PHASE_LABEL[entry.phase];
  status.appendChild(label);

  // The row slot is a live region, and progress re-renders per segment. Only
  // the phase label is live text; the number is hidden from the reader and
  // carried by the progressbar's aria-valuenow, which isn't re-announced on
  // every tick.
  if (entry.phase !== "error" && entry.phase !== "done") {
    const percent = document.createElement("span");
    percent.className = "progress-percent";
    percent.textContent = `${Math.round(entry.percent)}%`;
    percent.setAttribute("aria-hidden", "true");
    status.appendChild(percent);
  }

  container.appendChild(status);

  if (entry.phase !== "error") {
    const track = document.createElement("div");
    track.className = "progress-track";
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", PHASE_LABEL[entry.phase]);
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    track.setAttribute("aria-valuenow", String(Math.round(Math.min(Math.max(entry.percent, 0), 100))));
    const fill = document.createElement("div");
    fill.className = "progress-fill";
    fill.style.width = `${Math.min(Math.max(entry.percent, 0), 100)}%`;
    track.appendChild(fill);
    container.appendChild(track);
  }

  return container;
}

/** A short status/error line shown under a row (e.g. an unsupported stream). */
export function renderNotice(text: string): HTMLElement {
  const notice = document.createElement("p");
  notice.className = "row-notice";
  notice.textContent = text;
  return notice;
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
