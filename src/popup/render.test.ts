import { describe, expect, it } from "vitest";
import type { MediaItem } from "../shared/media-types";
import { formatSize, renderEmptyState, renderList, renderRow } from "./render";

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
  it("renders a message", () => {
    const el = renderEmptyState();
    expect(el.textContent).toMatch(/no downloadable media/i);
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
