import { describe, expect, it } from "vitest";
import type { DashRepresentation } from "./dash-manifest";
import type { HlsAudioRendition, HlsMediaPlaylist, HlsVariant } from "./hls-playlist";
import {
  countPlannedFetches,
  describeQuality,
  pickAudioRendition,
  pickHighestBandwidth,
  planDashDownload,
  planHlsDownload,
  suggestStreamFilename,
} from "./stream-plan";

const MANIFEST_URL = "https://cdn.example.com/my-video/master.m3u8";

const VARIANT: HlsVariant = {
  url: "https://cdn.example.com/my-video/720p/index.m3u8",
  bandwidth: 2400000,
  resolution: { width: 1280, height: 720 },
};

function mediaPlaylist(overrides: Partial<HlsMediaPlaylist> = {}): HlsMediaPlaylist {
  return {
    targetDuration: 10,
    segments: [
      { url: "https://cdn.example.com/my-video/720p/seg0.ts", duration: 10, sequenceNumber: 0 },
      { url: "https://cdn.example.com/my-video/720p/seg1.ts", duration: 10, sequenceNumber: 1 },
    ],
    ...overrides,
  };
}

describe("pickHighestBandwidth", () => {
  it("returns the highest-bandwidth item", () => {
    expect(pickHighestBandwidth([{ bandwidth: 100 }, { bandwidth: 900 }, { bandwidth: 500 }])).toEqual({
      bandwidth: 900,
    });
  });

  it("returns undefined for an empty list", () => {
    expect(pickHighestBandwidth([])).toBeUndefined();
  });
});

describe("pickAudioRendition", () => {
  const renditions: HlsAudioRendition[] = [
    { groupId: "aac", name: "English", isDefault: false, url: "https://example.com/en.m3u8" },
    { groupId: "aac", name: "Spanish", isDefault: true, url: "https://example.com/es.m3u8" },
    { groupId: "other", name: "Other", isDefault: true, url: "https://example.com/other.m3u8" },
  ];

  it("prefers the DEFAULT=YES rendition within the variant's group", () => {
    expect(pickAudioRendition(renditions, "aac")?.name).toBe("Spanish");
  });

  it("falls back to the first rendition in the group when none is default", () => {
    const noDefault = renditions.map((r) => ({ ...r, isDefault: false }));
    expect(pickAudioRendition(noDefault, "aac")?.name).toBe("English");
  });

  it("returns undefined when the variant has no audio group (audio is muxed in)", () => {
    expect(pickAudioRendition(renditions, undefined)).toBeUndefined();
  });

  it("ignores renditions with no URI, which are muxed into the video segments", () => {
    const muxedIn: HlsAudioRendition[] = [{ groupId: "aac", name: "English", isDefault: true }];
    expect(pickAudioRendition(muxedIn, "aac")).toBeUndefined();
  });
});

describe("describeQuality", () => {
  it("prefers resolution height", () => {
    expect(describeQuality(720, 2400000)).toBe("720p");
  });

  it("falls back to bitrate when there's no resolution (e.g. audio-only)", () => {
    expect(describeQuality(undefined, 128000)).toBe("128 kbps");
  });
});

describe("suggestStreamFilename", () => {
  it("uses the containing directory when the manifest has a generic name", () => {
    expect(suggestStreamFilename(MANIFEST_URL, "720p")).toBe("my-video-720p.mp4");
  });

  it("uses the manifest's own name when it is meaningful", () => {
    expect(suggestStreamFilename("https://cdn.example.com/x/holiday-clip.m3u8", "1080p")).toBe(
      "holiday-clip-1080p.mp4"
    );
  });

  it("falls back to a generic name for unparseable URLs", () => {
    expect(suggestStreamFilename("not a url", "720p")).toBe("stream-720p.mp4");
  });

  it("prefers a page-provided title, sanitised for the filesystem", () => {
    expect(suggestStreamFilename(MANIFEST_URL, "720p", "Clip: part 1/2")).toBe(
      "Clip part 1 2-720p.mp4"
    );
  });

  it("ignores a title that sanitises to nothing", () => {
    expect(suggestStreamFilename(MANIFEST_URL, "720p", "???")).toBe("my-video-720p.mp4");
  });
});

describe("planHlsDownload", () => {
  it("plans a plain video-only stream", () => {
    const result = planHlsDownload({
      manifestUrl: MANIFEST_URL,
      variant: VARIANT,
      videoPlaylist: mediaPlaylist(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.kind).toBe("hls");
    expect(result.plan.video.segments).toHaveLength(2);
    expect(result.plan.video.segments[0]?.decryption).toBeUndefined();
    expect(result.plan.audio).toBeUndefined();
    expect(result.plan.suggestedFilename).toBe("my-video-720p.mp4");
  });

  it("includes the fMP4 init segment when present", () => {
    const result = planHlsDownload({
      manifestUrl: MANIFEST_URL,
      variant: VARIANT,
      videoPlaylist: mediaPlaylist({ initSegmentUrl: "https://cdn.example.com/my-video/init.mp4" }),
    });
    if (!result.ok) throw new Error("expected a plan");
    expect(result.plan.video.initUrl).toBe("https://cdn.example.com/my-video/init.mp4");
  });

  it("attaches key URL and derived IV to encrypted segments", () => {
    const encrypted = mediaPlaylist({
      segments: [
        {
          url: "https://cdn.example.com/my-video/720p/seg0.ts",
          duration: 10,
          sequenceNumber: 5,
          encryption: { keyUrl: "https://cdn.example.com/key.bin" },
        },
      ],
    });

    const result = planHlsDownload({
      manifestUrl: MANIFEST_URL,
      variant: VARIANT,
      videoPlaylist: encrypted,
    });
    if (!result.ok) throw new Error("expected a plan");

    const decryption = result.plan.video.segments[0]?.decryption;
    expect(decryption?.keyUrl).toBe("https://cdn.example.com/key.bin");
    // no explicit IV in the playlist -> derived from sequence number 5
    expect([...(decryption?.iv ?? [])].slice(8)).toEqual([0, 0, 0, 0, 0, 0, 0, 5]);
  });

  it("plans a separate audio track when the variant references one", () => {
    const result = planHlsDownload({
      manifestUrl: MANIFEST_URL,
      variant: VARIANT,
      videoPlaylist: mediaPlaylist(),
      audioPlaylist: mediaPlaylist({
        segments: [
          { url: "https://cdn.example.com/my-video/audio/seg0.m4s", duration: 10, sequenceNumber: 0 },
        ],
      }),
    });
    if (!result.ok) throw new Error("expected a plan");
    expect(result.plan.audio?.segments).toHaveLength(1);
  });

  it("refuses streams using encryption it cannot decrypt", () => {
    const result = planHlsDownload({
      manifestUrl: MANIFEST_URL,
      variant: VARIANT,
      videoPlaylist: mediaPlaylist({ unsupportedEncryption: "SAMPLE-AES" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/SAMPLE-AES/);
  });

  it("refuses a playlist with no segments", () => {
    const result = planHlsDownload({
      manifestUrl: MANIFEST_URL,
      variant: VARIANT,
      videoPlaylist: mediaPlaylist({ segments: [] }),
    });
    expect(result.ok).toBe(false);
  });
});

describe("planDashDownload", () => {
  const video: DashRepresentation = {
    id: "v0",
    bandwidth: 2400000,
    width: 1280,
    height: 720,
    initUrl: "https://cdn.example.com/dash/video/init.mp4",
    segmentUrls: [
      "https://cdn.example.com/dash/video/seg_1.m4s",
      "https://cdn.example.com/dash/video/seg_2.m4s",
    ],
  };

  const audio: DashRepresentation = {
    id: "a0",
    bandwidth: 128000,
    initUrl: "https://cdn.example.com/dash/audio/init.mp4",
    segmentUrls: ["https://cdn.example.com/dash/audio/seg_1.m4s"],
  };

  it("plans video and audio tracks together", () => {
    const result = planDashDownload({
      manifestUrl: "https://cdn.example.com/dash/manifest.mpd",
      video,
      audio,
    });
    if (!result.ok) throw new Error("expected a plan");

    expect(result.plan.kind).toBe("dash");
    expect(result.plan.video.initUrl).toBe("https://cdn.example.com/dash/video/init.mp4");
    expect(result.plan.video.segments).toHaveLength(2);
    expect(result.plan.audio?.segments).toHaveLength(1);
    expect(result.plan.suggestedFilename).toBe("dash-720p.mp4");
  });

  it("refuses a representation with no segments", () => {
    const result = planDashDownload({
      manifestUrl: "https://cdn.example.com/dash/manifest.mpd",
      video: { ...video, segmentUrls: [] },
    });
    expect(result.ok).toBe(false);
  });
});

describe("countPlannedFetches", () => {
  it("counts segments plus init segments across both tracks", () => {
    const result = planDashDownload({
      manifestUrl: "https://cdn.example.com/dash/manifest.mpd",
      video: {
        id: "v0",
        bandwidth: 1,
        initUrl: "https://example.com/vinit.mp4",
        segmentUrls: ["https://example.com/v1.m4s", "https://example.com/v2.m4s"],
      },
      audio: {
        id: "a0",
        bandwidth: 1,
        initUrl: "https://example.com/ainit.mp4",
        segmentUrls: ["https://example.com/a1.m4s"],
      },
    });
    if (!result.ok) throw new Error("expected a plan");
    expect(countPlannedFetches(result.plan)).toBe(5);
  });
});
