import { describe, expect, it } from "vitest";
import { extractMediaItems, manifestItem, pageTitle } from "./scan";

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

describe("manifestItem", () => {
  it("builds a stream item for a manifest the sniffer recognised, whatever its URL looks like", () => {
    const item = manifestItem("https://api.example.com/stream/1234?token=abc", "hls", PAGE_URL, 7);
    expect(item).toEqual({
      url: "https://api.example.com/stream/1234?token=abc",
      category: "stream",
      streamKind: "hls",
      filename: "1234",
      sourceUrl: PAGE_URL,
      detectedAt: 7,
    });
  });
});

describe("pageTitle", () => {
  function docWithHead(head: string): Document {
    return new DOMParser().parseFromString(`<html><head>${head}</head><body></body></html>`, "text/html");
  }

  it("prefers og:title", () => {
    const doc = docWithHead(`<title>Clip - Site</title><meta property="og:title" content="The Clip">`);
    expect(pageTitle(doc)).toBe("The Clip");
  });

  it("strips a short trailing site name from the document title", () => {
    expect(pageTitle(docWithHead(`<title>How To Chop Wood | WoodTube</title>`))).toBe("How To Chop Wood");
    expect(pageTitle(docWithHead(`<title>How To Chop Wood - Wood Tube</title>`))).toBe("How To Chop Wood");
    expect(pageTitle(docWithHead(`<title>Part 1 - Part 2 – Site</title>`))).toBe("Part 1 - Part 2");
  });

  it("keeps a title whose last segment is too long to be a site name, and one with no separator", () => {
    const long = "A" .repeat(50);
    expect(pageTitle(docWithHead(`<title>Intro - ${long}</title>`))).toBe(`Intro - ${long}`);
    expect(pageTitle(docWithHead(`<title>Just a title</title>`))).toBe("Just a title");
  });

  it("returns undefined for an untitled page", () => {
    expect(pageTitle(docWithHead(``))).toBeUndefined();
  });
});

describe("manifestItem with page context", () => {
  it("names the stream after the page and carries the master's child URLs", () => {
    const item = manifestItem("https://api.example.com/stream/1234", "hls", PAGE_URL, 7, {
      title: "Chop Wood: part 1/2",
      childUrls: ["https://cdn.example.com/720p/video.m3u8"],
    });
    expect(item).toMatchObject({
      filename: "Chop Wood part 1 2.m3u8",
      title: "Chop Wood: part 1/2",
      childUrls: ["https://cdn.example.com/720p/video.m3u8"],
    });
  });

  it("names DOM-scanned streams after the page too, but not plain files", () => {
    const doc = new DOMParser().parseFromString(
      `<html><head><title>Lecture 3 | Uni</title></head><body>
        <video src="https://cdn.example.com/lec/master.m3u8"></video>
        <a href="https://cdn.example.com/notes.pdf">Notes</a>
      </body></html>`,
      "text/html"
    );
    const items = extractMediaItems(doc, PAGE_URL);
    expect(items.find((item) => item.category === "stream")).toMatchObject({ filename: "Lecture 3.m3u8", title: "Lecture 3" });
    expect(items.find((item) => item.category === "document")).toMatchObject({ filename: "notes.pdf" });
    expect(items.find((item) => item.category === "document")?.title).toBeUndefined();
  });
});
