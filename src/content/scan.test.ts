import { describe, expect, it } from "vitest";
import { extractMediaItems } from "./scan";

const PAGE_URL = "https://example.com/page";

function docFromHtml(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

describe("extractMediaItems", () => {
  it("finds a video element's src", () => {
    const doc = docFromHtml(`<video src="https://cdn.example.com/clip.mp4"></video>`);
    const items = extractMediaItems(doc, PAGE_URL);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      url: "https://cdn.example.com/clip.mp4",
      category: "video",
      filename: "clip.mp4",
    });
  });

  it("finds a video's nested source element", () => {
    const doc = docFromHtml(
      `<video><source src="https://cdn.example.com/clip.webm" type="video/webm"></video>`
    );
    const items = extractMediaItems(doc, PAGE_URL);
    expect(items.map((i) => i.url)).toEqual(["https://cdn.example.com/clip.webm"]);
  });

  it("finds audio elements", () => {
    const doc = docFromHtml(`<audio src="https://cdn.example.com/track.mp3"></audio>`);
    const items = extractMediaItems(doc, PAGE_URL);
    expect(items[0]?.category).toBe("audio");
  });

  it("finds anchor links to downloadable files", () => {
    const doc = docFromHtml(`
      <a href="https://cdn.example.com/report.pdf">Report</a>
      <a href="https://cdn.example.com/archive.zip">Archive</a>
    `);
    const items = extractMediaItems(doc, PAGE_URL);
    expect(items.map((i) => i.category).sort()).toEqual(["archive", "document"]);
  });

  it("ignores anchor links that aren't recognized file types", () => {
    const doc = docFromHtml(`<a href="https://example.com/about">About</a>`);
    expect(extractMediaItems(doc, PAGE_URL)).toEqual([]);
  });

  it("detects HLS/DASH streaming manifests as streams, tagged with their kind", () => {
    const doc = docFromHtml(`
      <video src="https://cdn.example.com/index.m3u8"></video>
      <a href="https://cdn.example.com/manifest.mpd">Stream</a>
    `);
    const items = extractMediaItems(doc, PAGE_URL);
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.category === "stream")).toBe(true);
    expect(items.map((item) => item.streamKind).sort()).toEqual(["dash", "hls"]);
  });

  it("dedupes repeated URLs", () => {
    const doc = docFromHtml(`
      <a href="https://cdn.example.com/report.pdf">Mirror 1</a>
      <a href="https://cdn.example.com/report.pdf">Mirror 2</a>
    `);
    expect(extractMediaItems(doc, PAGE_URL)).toHaveLength(1);
  });

  it("returns an empty list when nothing matches", () => {
    const doc = docFromHtml(`<p>No media here.</p>`);
    expect(extractMediaItems(doc, PAGE_URL)).toEqual([]);
  });
});
