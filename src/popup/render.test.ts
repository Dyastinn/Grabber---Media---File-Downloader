import { describe, expect, it } from "vitest";
import type { MediaItem } from "../shared/media-types";
import {
  formatFoundCount,
  formatSize,
  renderEmptyState,
  renderList,
  renderQualityOptions,
  renderRow,
  renderStreamProgress,
  weightRungs,
} from "./render";

function makeItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    url: "https://example.com/a.mp4",
    category: "video",
    filename: "a.mp4",
    sourceUrl: "https://example.com/",
    detectedAt: 0,
    ...overrides,
  };
}

describe("formatSize", () => {
  it("formats bytes", () => {
    expect(formatSize(500)).toBe("500 B");
  });

  it("formats KB/MB/GB", () => {
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatSize(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
  });

  it("returns an empty string when size is unknown", () => {
    expect(formatSize(undefined)).toBe("");
  });
});

describe("renderEmptyState", () => {
  it("tells the user what to do next rather than only what is missing", () => {
    const el = renderEmptyState();
    expect(el.textContent).toMatch(/nothing to grab/i);
    expect(el.textContent).toMatch(/start a video or open a file/i);
  });
});

describe("formatFoundCount", () => {
  it("is empty at zero, so the empty state speaks alone", () => {
    expect(formatFoundCount(0)).toBe("");
  });

  it("singularises", () => {
    expect(formatFoundCount(1)).toBe("1 found");
    expect(formatFoundCount(4)).toBe("4 found");
  });
});

describe("weightRungs", () => {
  it("scales against the largest rung and keeps a visible floor", () => {
    const [top, bottom] = weightRungs([4000, 1000]);
    expect(top).toBe(1);
    expect(bottom).toBeGreaterThanOrEqual(0.12);
    expect(bottom).toBeLessThan(0.5);
  });

  it("gives no bars when fewer than two rungs have a magnitude", () => {
    expect(weightRungs([5000])).toEqual([undefined]);
    expect(weightRungs([0, 0, 0])).toEqual([undefined, undefined, undefined]);
    expect(weightRungs([undefined, 900])).toEqual([undefined, undefined]);
  });

  it("gives no bars when every rung is the same size", () => {
    expect(weightRungs([800, 800, 800])).toEqual([undefined, undefined, undefined]);
  });

  it("leaves rungs without a magnitude unweighted", () => {
    const weights = weightRungs([4000, undefined, 2000]);
    expect(weights[1]).toBeUndefined();
    expect(weights[0]).toBe(1);
  });
});

describe("renderQualityOptions", () => {
  it("sets --weight only on rungs that have one", () => {
    const container = renderQualityOptions([
      { label: "1080p", weight: 1 },
      { label: "480p" },
    ]);
    const rungs = [...container.querySelectorAll<HTMLElement>(".quality-option")];
    expect(rungs[0]!.style.getPropertyValue("--weight")).toBe("1");
    expect(rungs[1]!.style.getPropertyValue("--weight")).toBe("");
  });

  it("keeps the label text on its own so the picker reads as a ladder", () => {
    const container = renderQualityOptions([{ label: "720p", detail: "1200 kbps" }]);
    expect(container.querySelector(".quality-label")!.textContent).toBe("720p");
    expect(container.querySelector(".quality-detail")!.textContent).toBe("1200 kbps");
  });
});

describe("renderRow", () => {
  it("renders the filename and a download button carrying url/filename", () => {
    const item = makeItem({ filename: "clip.mp4", url: "https://cdn.example.com/clip.mp4", size: 1024 });
    const row = renderRow(item);
    expect(row.textContent).toContain("clip.mp4");
    expect(row.textContent).toContain("1.0 KB");
    const button = row.querySelector(".download-btn") as HTMLButtonElement;
    expect(button.dataset["url"]).toBe("https://cdn.example.com/clip.mp4");
    expect(button.dataset["filename"]).toBe("clip.mp4");
  });

  it("carries the category on the row", () => {
    const row = renderRow(makeItem({ category: "stream" }));
    expect(row.dataset["category"]).toBe("stream");
  });

  it("keeps a truncated filename recoverable and announces row updates", () => {
    const row = renderRow(makeItem({ filename: "a-very-long-name.mp4" }));
    expect(row.querySelector<HTMLElement>(".media-filename")!.title).toBe("a-very-long-name.mp4");
    expect(row.querySelector(".row-extra")!.getAttribute("aria-live")).toBe("polite");
  });

  it("omits size when unknown", () => {
    const row = renderRow(makeItem({ size: undefined }));
    expect(row.querySelector(".media-size")).toBeNull();
  });
});

describe("renderList", () => {
  it("renders the empty state when there are no items", () => {
    const container = renderList([]);
    expect(container.querySelector(".empty-state")).not.toBeNull();
  });

  it("groups items by category in a fixed order", () => {
    const items = [
      makeItem({ url: "a.zip", category: "archive", filename: "a.zip" }),
      makeItem({ url: "a.mp4", category: "video", filename: "a.mp4" }),
      makeItem({ url: "a.pdf", category: "document", filename: "a.pdf" }),
    ];
    const container = renderList(items);
    const headings = [...container.querySelectorAll("h2")].map((h) => h.textContent);
    expect(headings).toEqual(["Video (1)", "Document (1)", "Archive (1)"]);
  });

  it("renders one row per item within a group", () => {
    const items = [
      makeItem({ url: "a.mp4", filename: "a.mp4" }),
      makeItem({ url: "b.mp4", filename: "b.mp4" }),
    ];
    const container = renderList(items);
    expect(container.querySelectorAll(".media-row")).toHaveLength(2);
  });
});

describe("renderStreamProgress", () => {
  it("shows the percentage beside the label while in flight", () => {
    const el = renderStreamProgress({ streamUrl: "u", phase: "fetching", percent: 41.6 });
    expect(el.querySelector(".progress-label")!.textContent).toBe("Downloading segments");
    expect(el.querySelector(".progress-percent")!.textContent).toBe("42%");
    expect(el.querySelector<HTMLElement>(".progress-fill")!.style.width).toBe("41.6%");
  });

  it("keeps the per-tick number out of the live region and on the progressbar", () => {
    const el = renderStreamProgress({ streamUrl: "u", phase: "muxing", percent: 80 });
    expect(el.querySelector(".progress-percent")!.getAttribute("aria-hidden")).toBe("true");
    const track = el.querySelector(".progress-track")!;
    expect(track.getAttribute("role")).toBe("progressbar");
    expect(track.getAttribute("aria-valuenow")).toBe("80");
    expect(track.getAttribute("aria-label")).toBe("Merging video and audio");
  });

  it("drops the percentage once saved, and shows the error text on failure", () => {
    const done = renderStreamProgress({ streamUrl: "u", phase: "done", percent: 100 });
    expect(done.querySelector(".progress-label")!.textContent).toBe("Saved");
    expect(done.querySelector(".progress-percent")).toBeNull();

    const failed = renderStreamProgress({ streamUrl: "u", phase: "error", percent: 0, error: "Key fetch failed" });
    expect(failed.querySelector(".progress-label")!.textContent).toBe("Key fetch failed");
    expect(failed.querySelector(".progress-track")).toBeNull();
  });
});
