import { describe, expect, it } from "vitest";
import type { MediaItem } from "../shared/media-types";
import { MediaStore } from "./media-store";

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

describe("MediaStore", () => {
  it("returns an empty list for a tab with nothing added", () => {
    const store = new MediaStore();
    expect(store.list(1)).toEqual([]);
    expect(store.count(1)).toBe(0);
  });

  it("lists items added for a tab", () => {
    const store = new MediaStore();
    const item = makeItem();
    store.add(1, item);
    expect(store.list(1)).toEqual([item]);
    expect(store.count(1)).toBe(1);
  });

  it("keeps different tabs' items separate", () => {
    const store = new MediaStore();
    store.add(1, makeItem({ url: "https://example.com/1.mp4" }));
    store.add(2, makeItem({ url: "https://example.com/2.mp4" }));
    expect(store.list(1)).toHaveLength(1);
    expect(store.list(2)).toHaveLength(1);
    expect(store.list(1)[0]?.url).toBe("https://example.com/1.mp4");
  });

  it("dedupes by URL, keeping the latest add", () => {
    const store = new MediaStore();
    store.add(1, makeItem({ size: undefined }));
    store.add(1, makeItem({ size: 1024 }));
    const items = store.list(1);
    expect(items).toHaveLength(1);
    expect(items[0]?.size).toBe(1024);
  });

  it("sorts newest first", () => {
    const store = new MediaStore();
    store.add(1, makeItem({ url: "https://example.com/old.mp4", detectedAt: 1 }));
    store.add(1, makeItem({ url: "https://example.com/new.mp4", detectedAt: 2 }));
    const items = store.list(1);
    expect(items.map((i) => i.url)).toEqual([
      "https://example.com/new.mp4",
      "https://example.com/old.mp4",
    ]);
  });

  it("clears a tab's items", () => {
    const store = new MediaStore();
    store.add(1, makeItem());
    store.clear(1);
    expect(store.list(1)).toEqual([]);
  });

  it("keeps a page title and its filename when the same URL is re-added without one", () => {
    const store = new MediaStore();
    const url = "https://cdn.example.com/v/master.m3u8";
    store.add(1, makeItem({ url, category: "stream", filename: "My Video (720p).m3u8", title: "My Video" }));
    // The network watcher sees the same manifest once the player fetches it,
    // knowing only the URL but now also the Content-Type.
    store.add(1, makeItem({ url, category: "stream", filename: "master.m3u8", contentType: "application/vnd.apple.mpegurl" }));

    expect(store.list(1)).toEqual([
      expect.objectContaining({
        url,
        filename: "My Video (720p).m3u8",
        title: "My Video",
        contentType: "application/vnd.apple.mpegurl",
      }),
    ]);
  });

  it("drops a generic sighting of a URL that a titled row already offers as a quality alternate", () => {
    const store = new MediaStore();
    const best = "https://cdn.example.com/v/720P/master.m3u8";
    const low = "https://cdn.example.com/v/240P/master.m3u8";
    store.add(1, makeItem({
      url: best,
      category: "stream",
      filename: "My Video.m3u8",
      title: "My Video",
      qualitySources: [{ url: best, height: 720 }, { url: low, height: 240 }],
    }));
    // The player picks 240p and fetches it; the network watcher reports it.
    store.add(1, makeItem({ url: low, category: "stream", filename: "master.m3u8" }));

    expect(store.list(1).map((item) => item.url)).toEqual([best]);
    expect(store.count(1)).toBe(1);
  });

  it("lets a titled re-add replace an untitled one", () => {
    const store = new MediaStore();
    const url = "https://cdn.example.com/v/master.m3u8";
    store.add(1, makeItem({ url, filename: "master.m3u8" }));
    store.add(1, makeItem({ url, filename: "My Video.m3u8", title: "My Video" }));
    expect(store.list(1)[0]?.filename).toBe("My Video.m3u8");
  });

  it("clearing one tab does not affect another", () => {
    const store = new MediaStore();
    store.add(1, makeItem({ url: "https://example.com/1.mp4" }));
    store.add(2, makeItem({ url: "https://example.com/2.mp4" }));
    store.clear(1);
    expect(store.list(1)).toEqual([]);
    expect(store.list(2)).toHaveLength(1);
  });
});
