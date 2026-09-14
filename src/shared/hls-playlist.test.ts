import { describe, expect, it } from "vitest";
import {
  computeSegmentIv,
  isMasterPlaylist,
  parseMasterPlaylist,
  parseMediaPlaylist,
} from "./hls-playlist";

const BASE_URL = "https://cdn.example.com/videos/master.m3u8";

const MASTER_PLAYLIST = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Spanish",LANGUAGE="es",DEFAULT=NO,URI="audio/es.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aac"
360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aac"
720p/index.m3u8
`;

const PLAIN_MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:9.009,
segment0.ts
#EXTINF:9.009,
segment1.ts
#EXTINF:3.003,
segment2.ts
#EXT-X-ENDLIST
`;

const ENCRYPTED_MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="keys/key1.bin",IV=0x0123456789ABCDEF0123456789ABCDEF
#EXTINF:10.0,
segment0.ts
#EXTINF:10.0,
segment1.ts
#EXT-X-KEY:METHOD=AES-128,URI="keys/key2.bin"
#EXTINF:10.0,
segment2.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:10.0,
segment3.ts
#EXT-X-ENDLIST
`;

const FMP4_MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.0,
segment0.m4s
#EXTINF:6.0,
segment1.m4s
#EXT-X-ENDLIST
`;

describe("isMasterPlaylist", () => {
  it("distinguishes master from media playlists", () => {
    expect(isMasterPlaylist(MASTER_PLAYLIST)).toBe(true);
    expect(isMasterPlaylist(PLAIN_MEDIA_PLAYLIST)).toBe(false);
  });
});

describe("parseMasterPlaylist", () => {
  it("parses variants with bandwidth and resolution, resolving relative URLs", () => {
    const { variants } = parseMasterPlaylist(MASTER_PLAYLIST, BASE_URL);
    expect(variants).toHaveLength(2);
    expect(variants[0]).toEqual({
      url: "https://cdn.example.com/videos/360p/index.m3u8",
      bandwidth: 800000,
      resolution: { width: 640, height: 360 },
      codecs: "avc1.4d401e,mp4a.40.2",
      audioGroupId: "aac",
    });
    expect(variants[1]?.resolution).toEqual({ width: 1280, height: 720 });
  });

  it("parses audio renditions, including which is default", () => {
    const { audioRenditions } = parseMasterPlaylist(MASTER_PLAYLIST, BASE_URL);
    expect(audioRenditions).toHaveLength(2);
    expect(audioRenditions[0]).toEqual({
      groupId: "aac",
      name: "English",
      language: "en",
      isDefault: true,
      url: "https://cdn.example.com/videos/audio/en.m3u8",
    });
    expect(audioRenditions[1]?.isDefault).toBe(false);
  });

  it("does not confuse commas inside quoted CODECS values for attribute separators", () => {
    const { variants } = parseMasterPlaylist(MASTER_PLAYLIST, BASE_URL);
    expect(variants[0]?.bandwidth).toBe(800000);
    expect(variants[0]?.codecs).toContain("mp4a.40.2");
  });
});

describe("parseMediaPlaylist", () => {
  it("parses segments with durations and resolved URLs", () => {
    const playlist = parseMediaPlaylist(PLAIN_MEDIA_PLAYLIST, BASE_URL);
    expect(playlist.targetDuration).toBe(10);
    expect(playlist.segments).toHaveLength(3);
    expect(playlist.segments[0]).toEqual({
      url: "https://cdn.example.com/videos/segment0.ts",
      duration: 9.009,
      sequenceNumber: 0,
    });
    expect(playlist.segments[2]?.duration).toBe(3.003);
  });

  it("leaves unencrypted segments without encryption info", () => {
    const playlist = parseMediaPlaylist(PLAIN_MEDIA_PLAYLIST, BASE_URL);
    expect(playlist.segments.every((s) => s.encryption === undefined)).toBe(true);
    expect(playlist.unsupportedEncryption).toBeUndefined();
  });

  it("applies an EXT-X-KEY to every following segment, including key rotation and METHOD=NONE", () => {
    const playlist = parseMediaPlaylist(ENCRYPTED_MEDIA_PLAYLIST, BASE_URL);
    const [first, second, third, fourth] = playlist.segments;

    expect(first?.encryption).toEqual({
      keyUrl: "https://cdn.example.com/videos/keys/key1.bin",
      ivHex: "0x0123456789ABCDEF0123456789ABCDEF",
    });
    expect(second?.encryption).toEqual(first?.encryption);

    // rotated to a second key, which has no explicit IV
    expect(third?.encryption).toEqual({ keyUrl: "https://cdn.example.com/videos/keys/key2.bin" });

    // METHOD=NONE turns encryption back off
    expect(fourth?.encryption).toBeUndefined();
  });

  it("flags encryption methods it cannot decrypt instead of pretending they're plaintext", () => {
    const playlist = parseMediaPlaylist(
      `#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key"\n#EXTINF:10.0,\nsegment0.ts\n`,
      BASE_URL
    );
    expect(playlist.unsupportedEncryption).toBe("SAMPLE-AES");
    expect(playlist.segments[0]?.encryption).toBeUndefined();
  });

  it("parses the EXT-X-MAP init segment for fMP4 streams", () => {
    const playlist = parseMediaPlaylist(FMP4_MEDIA_PLAYLIST, BASE_URL);
    expect(playlist.initSegmentUrl).toBe("https://cdn.example.com/videos/init.mp4");
    expect(playlist.segments).toHaveLength(2);
  });

  it("numbers segments from EXT-X-MEDIA-SEQUENCE", () => {
    const playlist = parseMediaPlaylist(
      `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:42\n#EXTINF:10.0,\na.ts\n#EXTINF:10.0,\nb.ts\n`,
      BASE_URL
    );
    expect(playlist.segments.map((s) => s.sequenceNumber)).toEqual([42, 43]);
  });
});

describe("computeSegmentIv", () => {
  it("uses an explicit IV when the playlist provides one", () => {
    const iv = computeSegmentIv(7, "0x000102030405060708090A0B0C0D0E0F");
    expect([...iv]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it("derives the IV from the sequence number when none is given", () => {
    const iv = computeSegmentIv(1);
    expect([...iv]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it("writes a multi-byte sequence number big-endian", () => {
    const iv = computeSegmentIv(258);
    expect([...iv.slice(8)]).toEqual([0, 0, 0, 0, 0, 0, 1, 2]);
  });

  it("always returns 16 bytes", () => {
    expect(computeSegmentIv(0)).toHaveLength(16);
    expect(computeSegmentIv(999999, "0xABCD")).toHaveLength(16);
  });
});
