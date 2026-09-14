import { describe, expect, it } from "vitest";
import { StreamProgressStore } from "./stream-progress-store";

const URL_A = "https://cdn.example.com/a/master.m3u8";
const URL_B = "https://cdn.example.com/b/master.m3u8";

describe("StreamProgressStore", () => {
  it("starts empty", () => {
    const store = new StreamProgressStore();
    expect(store.list()).toEqual([]);
    expect(store.get(URL_A)).toBeUndefined();
  });

  it("records progress updates, overwriting the previous state for that URL", () => {
    const store = new StreamProgressStore();
    store.update(URL_A, "fetching", 20);
    store.update(URL_A, "muxing", 80);

    expect(store.list()).toHaveLength(1);
    expect(store.get(URL_A)).toEqual({ streamUrl: URL_A, phase: "muxing", percent: 80 });
  });

  it("tracks several downloads independently", () => {
    const store = new StreamProgressStore();
    store.update(URL_A, "fetching", 10);
    store.update(URL_B, "muxing", 90);

    expect(store.list()).toHaveLength(2);
    expect(store.get(URL_B)?.percent).toBe(90);
  });

  it("marks completion at 100%", () => {
    const store = new StreamProgressStore();
    store.update(URL_A, "fetching", 50);
    store.complete(URL_A);
    expect(store.get(URL_A)).toEqual({ streamUrl: URL_A, phase: "done", percent: 100 });
  });

  it("keeps the reason when a download fails", () => {
    const store = new StreamProgressStore();
    store.fail(URL_A, "Segment fetch failed");
    expect(store.get(URL_A)).toMatchObject({ phase: "error", error: "Segment fetch failed" });
  });

  it("reports in-flight downloads as active, finished ones as not", () => {
    const store = new StreamProgressStore();
    expect(store.isActive(URL_A)).toBe(false);

    store.update(URL_A, "fetching", 10);
    expect(store.isActive(URL_A)).toBe(true);

    store.complete(URL_A);
    expect(store.isActive(URL_A)).toBe(false);

    store.fail(URL_B, "boom");
    expect(store.isActive(URL_B)).toBe(false);
  });

  it("clears a single entry without touching others", () => {
    const store = new StreamProgressStore();
    store.update(URL_A, "fetching", 10);
    store.update(URL_B, "fetching", 10);
    store.clear(URL_A);

    expect(store.get(URL_A)).toBeUndefined();
    expect(store.get(URL_B)).toBeDefined();
  });
});
