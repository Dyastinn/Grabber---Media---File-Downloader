import { describe, expect, it } from "vitest";
import { parseIsoDuration, parseManifest, substituteTemplate } from "./dash-manifest";

const BASE_URL = "https://cdn.example.com/dash/manifest.mpd";

const SEGMENT_TEMPLATE_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT12S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v0" bandwidth="800000" width="640" height="360" codecs="avc1.4d401e">
        <SegmentTemplate media="video/$RepresentationID$/seg_$Number$.m4s"
                         initialization="video/$RepresentationID$/init.mp4"
                         startNumber="1" duration="4" timescale="1"/>
      </Representation>
      <Representation id="v1" bandwidth="2400000" width="1280" height="720" codecs="avc1.4d401f">
        <SegmentTemplate media="video/$RepresentationID$/seg_$Number$.m4s"
                         initialization="video/$RepresentationID$/init.mp4"
                         startNumber="1" duration="4" timescale="1"/>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4">
      <Representation id="a0" bandwidth="128000" codecs="mp4a.40.2">
        <SegmentTemplate media="audio/$RepresentationID$/seg_$Number$.m4s"
                         initialization="audio/$RepresentationID$/init.mp4"
                         startNumber="1" duration="4" timescale="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const SEGMENT_TIMELINE_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT12S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v0" bandwidth="800000">
        <SegmentTemplate media="seg_$Number$.m4s" initialization="init.mp4">
          <SegmentTimeline>
            <S t="0" d="48000" r="2"/>
          </SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

describe("parseIsoDuration", () => {
  it("parses hours, minutes and fractional seconds", () => {
    expect(parseIsoDuration("PT30S")).toBe(30);
    expect(parseIsoDuration("PT1M30S")).toBe(90);
    expect(parseIsoDuration("PT1H2M3.5S")).toBe(3723.5);
  });

  it("returns 0 for missing or unparseable values", () => {
    expect(parseIsoDuration(null)).toBe(0);
    expect(parseIsoDuration("nonsense")).toBe(0);
  });
});

describe("substituteTemplate", () => {
  it("substitutes RepresentationID, Bandwidth and Number", () => {
    expect(
      substituteTemplate("$RepresentationID$/$Bandwidth$/seg_$Number$.m4s", {
        representationId: "v0",
        bandwidth: 800000,
        number: 3,
      })
    ).toBe("v0/800000/seg_3.m4s");
  });

  it("honours zero-padding in $Number%05d$", () => {
    expect(
      substituteTemplate("seg_$Number%05d$.m4s", { representationId: "v0", bandwidth: 0, number: 7 })
    ).toBe("seg_00007.m4s");
  });

  it("leaves Number out when building an initialization URL", () => {
    expect(
      substituteTemplate("$RepresentationID$/init.mp4", { representationId: "v0", bandwidth: 0 })
    ).toBe("v0/init.mp4");
  });
});

describe("parseManifest", () => {
  it("parses video and audio representations with resolved segment URLs", () => {
    const result = parseManifest(SEGMENT_TEMPLATE_MANIFEST, BASE_URL);
    expect(result.supported).toBe(true);
    if (!result.supported) return;

    expect(result.video).toHaveLength(2);
    expect(result.audio).toHaveLength(1);

    const [low, high] = result.video;
    expect(low).toMatchObject({ id: "v0", bandwidth: 800000, width: 640, height: 360 });
    expect(high).toMatchObject({ id: "v1", bandwidth: 2400000, width: 1280, height: 720 });

    // 12s total / 4s per segment = 3 segments, numbered from startNumber=1
    expect(low?.segmentUrls).toEqual([
      "https://cdn.example.com/dash/video/v0/seg_1.m4s",
      "https://cdn.example.com/dash/video/v0/seg_2.m4s",
      "https://cdn.example.com/dash/video/v0/seg_3.m4s",
    ]);
    expect(low?.initUrl).toBe("https://cdn.example.com/dash/video/v0/init.mp4");
  });

  it("separates audio tracks from video tracks", () => {
    const result = parseManifest(SEGMENT_TEMPLATE_MANIFEST, BASE_URL);
    if (!result.supported) throw new Error("expected supported manifest");
    expect(result.audio[0]).toMatchObject({ id: "a0", bandwidth: 128000 });
    expect(result.audio[0]?.segmentUrls[0]).toBe("https://cdn.example.com/dash/audio/a0/seg_1.m4s");
  });

  it("reports SegmentTimeline manifests as unsupported instead of guessing", () => {
    const result = parseManifest(SEGMENT_TIMELINE_MANIFEST, BASE_URL);
    expect(result.supported).toBe(false);
    if (result.supported) return;
    expect(result.reason).toMatch(/SegmentTimeline/);
  });

  it("reports unparseable manifests as unsupported", () => {
    const result = parseManifest("not xml at all", BASE_URL);
    expect(result.supported).toBe(false);
  });

  it("honours a <BaseURL> element when resolving segment URLs", () => {
    const manifest = SEGMENT_TEMPLATE_MANIFEST.replace(
      "<Period>",
      "<BaseURL>https://other.example.com/cdn/</BaseURL><Period>"
    );
    const result = parseManifest(manifest, BASE_URL);
    if (!result.supported) throw new Error("expected supported manifest");
    expect(result.video[0]?.segmentUrls[0]).toBe("https://other.example.com/cdn/video/v0/seg_1.m4s");
  });
});
