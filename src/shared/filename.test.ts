import { describe, expect, it } from "vitest";
import { guessFilename } from "./filename";

describe("guessFilename", () => {
  it("prefers a Content-Disposition filename", () => {
    expect(
      guessFilename("https://example.com/download?id=1", 'attachment; filename="report.pdf"')
    ).toBe("report.pdf");
  });

  it("decodes a UTF-8 Content-Disposition filename", () => {
    expect(
      guessFilename("https://example.com/download", "attachment; filename*=UTF-8''movie%20clip.mp4")
    ).toBe("movie clip.mp4");
  });

  it("falls back to the last URL path segment", () => {
    expect(guessFilename("https://cdn.example.com/videos/clip.mp4")).toBe("clip.mp4");
  });

  it("decodes URL-encoded path segments", () => {
    expect(guessFilename("https://cdn.example.com/my%20video.mp4")).toBe("my video.mp4");
  });

  it("falls back to a generic name when nothing usable is found", () => {
    expect(guessFilename("https://example.com/")).toBe("download");
    expect(guessFilename("not a url")).toBe("download");
  });
});
