import { describe, expect, it } from "vitest";
import {
  classifyByContentType,
  classifyByUrl,
  classifyMedia,
  getUrlExtension,
  isStreamingManifest,
} from "./media-types";

describe("getUrlExtension", () => {
  it("extracts the extension from a simple path", () => {
    expect(getUrlExtension("https://example.com/video.mp4")).toBe("mp4");
  });

  it("ignores query strings and fragments", () => {
    expect(getUrlExtension("https://example.com/video.mp4?token=abc#t=10")).toBe("mp4");
  });

  it("returns undefined when there is no extension", () => {
    expect(getUrlExtension("https://example.com/videos")).toBeUndefined();
  });

  it("returns undefined for an invalid URL", () => {
    expect(getUrlExtension("not a url")).toBeUndefined();
  });
});

describe("classifyByUrl", () => {
  it.each([
    ["https://example.com/a.mp4", "video"],
    ["https://example.com/a.mp3", "audio"],
    ["https://example.com/a.png", "image"],
    ["https://example.com/a.pdf", "document"],
    ["https://example.com/a.zip", "archive"],
  ] as const)("classifies %s as %s", (url, expected) => {
    expect(classifyByUrl(url)).toBe(expected);
  });

  it("returns null for unrecognized extensions", () => {
    expect(classifyByUrl("https://example.com/a.exe")).toBeNull();
  });

  it("returns null when there is no extension", () => {
    expect(classifyByUrl("https://example.com/a")).toBeNull();
  });
});

describe("classifyByContentType", () => {
  it("classifies by MIME prefix", () => {
    expect(classifyByContentType("video/mp4")).toBe("video");
    expect(classifyByContentType("audio/mpeg; charset=binary")).toBe("audio");
    expect(classifyByContentType("application/pdf")).toBe("document");
  });

  it("returns null for unrecognized or missing content types", () => {
    expect(classifyByContentType("text/html")).toBeNull();
    expect(classifyByContentType(undefined)).toBeNull();
    expect(classifyByContentType(null)).toBeNull();
  });
});

describe("classifyMedia", () => {
  it("prefers the URL extension over content-type", () => {
    expect(classifyMedia("https://example.com/a.mp4", "application/octet-stream")).toBe("video");
  });

  it("falls back to content-type when the URL has no usable extension", () => {
    expect(classifyMedia("https://example.com/download?id=1", "audio/mpeg")).toBe("audio");
  });

  it("returns null when neither signal matches", () => {
    expect(classifyMedia("https://example.com/page", "text/html")).toBeNull();
  });
});

describe("isStreamingManifest", () => {
  it("flags HLS and DASH manifests", () => {
    expect(isStreamingManifest("https://example.com/index.m3u8")).toBe(true);
    expect(isStreamingManifest("https://example.com/manifest.mpd")).toBe(true);
  });

  it("does not flag regular media files", () => {
    expect(isStreamingManifest("https://example.com/video.mp4")).toBe(false);
  });
});
