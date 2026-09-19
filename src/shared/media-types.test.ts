import { describe, expect, it } from "vitest";
import {
  classifyByContentType,
  classifyByUrl,
  classifyMedia,
  isStreamSegment,
  sniffManifestKind,
  classifyStreamKind,
  getUrlExtension,
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
    expect(classifyMedia("https://example.com/a.mp4", "application/octet-stream")).toEqual({
      category: "video",
    });
  });

  it("falls back to content-type when the URL has no usable extension", () => {
    expect(classifyMedia("https://example.com/download?id=1", "audio/mpeg")).toEqual({
      category: "audio",
    });
  });

  it("returns null when neither signal matches", () => {
    expect(classifyMedia("https://example.com/page", "text/html")).toBeNull();
  });

  it("classifies streaming manifests as streams, with their kind", () => {
    expect(classifyMedia("https://example.com/index.m3u8")).toEqual({
      category: "stream",
      streamKind: "hls",
    });
    expect(classifyMedia("https://example.com/manifest.mpd")).toEqual({
      category: "stream",
      streamKind: "dash",
    });
  });

  it("classifies an extension-less manifest URL by its content type", () => {
    expect(classifyMedia("https://example.com/playlist", "application/vnd.apple.mpegurl")).toEqual({
      category: "stream",
      streamKind: "hls",
    });
  });
});

describe("classifyStreamKind", () => {
  it("identifies HLS and DASH by extension", () => {
    expect(classifyStreamKind("https://example.com/index.m3u8")).toBe("hls");
    expect(classifyStreamKind("https://example.com/manifest.mpd")).toBe("dash");
  });

  it("identifies manifests by content type when the URL has no extension", () => {
    expect(classifyStreamKind("https://example.com/playlist", "application/x-mpegURL")).toBe("hls");
    expect(classifyStreamKind("https://example.com/manifest", "application/dash+xml")).toBe("dash");
  });

  it("returns null for regular media files", () => {
    expect(classifyStreamKind("https://example.com/video.mp4", "video/mp4")).toBeNull();
  });
});

describe("sniffManifestKind", () => {
  it("recognises an HLS playlist by its #EXTM3U header", () => {
    expect(sniffManifestKind("#EXTM3U\n#EXT-X-VERSION:3\n")).toBe("hls");
    expect(sniffManifestKind("\n  #EXTM3U\n")).toBe("hls");
  });

  it("ignores a UTF-8 BOM", () => {
    expect(sniffManifestKind(String.fromCharCode(0xfeff) + "#EXTM3U\n")).toBe("hls");
  });

  it("recognises a DASH MPD, with or without an XML declaration", () => {
    expect(sniffManifestKind('<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">')).toBe("dash");
    expect(sniffManifestKind("<MPD>")).toBe("dash");
  });

  it("returns null for anything else", () => {
    expect(sniffManifestKind('{"playlist":"#EXTM3U"}')).toBeNull();
    expect(sniffManifestKind("<html><body>#EXTM3U</body></html>")).toBeNull();
    expect(sniffManifestKind("")).toBeNull();
  });
});

describe("isStreamSegment", () => {
  it("flags .ts and .m4s segment files", () => {
    expect(isStreamSegment("https://cdn.example.com/hls/video66.ts")).toBe(true);
    expect(isStreamSegment("https://cdn.example.com/dash/seg-1.m4s?token=x")).toBe(true);
  });

  it("flags MPEG-TS / ISO segment content types on extension-less URLs", () => {
    expect(isStreamSegment("https://cdn.example.com/seg/66", "video/mp2t")).toBe(true);
    expect(isStreamSegment("https://cdn.example.com/seg/66", "video/iso.segment")).toBe(true);
  });

  it("leaves whole files alone", () => {
    expect(isStreamSegment("https://cdn.example.com/clip.mp4", "video/mp4")).toBe(false);
    expect(isStreamSegment("https://cdn.example.com/master.m3u8")).toBe(false);
  });
});
