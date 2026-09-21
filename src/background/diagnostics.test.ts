import { describe, expect, it } from "vitest";
import { buildFetchDiagnostic, explain, NetworkErrorLog } from "./diagnostics";

describe("NetworkErrorLog", () => {
  it("keeps the latest error per URL and evicts the oldest past the cap", () => {
    const log = new NetworkErrorLog(2);
    log.record("https://a/1", "net::ERR_A");
    log.record("https://a/2", "net::ERR_B");
    log.record("https://a/1", "net::ERR_A2");
    log.record("https://a/3", "net::ERR_C");
    expect(log.get("https://a/1")).toBe("net::ERR_A2"); // refreshed, so not evicted
    expect(log.get("https://a/2")).toBeUndefined();
    expect(log.get("https://a/3")).toBe("net::ERR_C");
  });
});

describe("explain", () => {
  it("names a blocker for ERR_BLOCKED_BY_CLIENT", () => {
    expect(explain("Failed to fetch", "net::ERR_BLOCKED_BY_CLIENT", undefined)).toMatch(/another extension/);
  });

  it("distinguishes unreachable hosts from refusals", () => {
    expect(explain("Failed to fetch", "net::ERR_CONNECTION_REFUSED", undefined)).toMatch(/isn't reachable/);
    expect(explain("HTTP 403", undefined, undefined)).toMatch(/play the video first/);
    expect(explain("HTTP 403", undefined, { referer: "x", "x-token": "y" })).toMatch(/referer, x-token/);
  });

  it("points ERR_FAILED at the site-access setting", () => {
    expect(explain("Failed to fetch", "net::ERR_FAILED", undefined)).toMatch(/Site access/);
  });

  it("falls back to pointing at the Network tab", () => {
    expect(explain("Failed to fetch", undefined, undefined)).toMatch(/Network tab/);
  });
});

describe("buildFetchDiagnostic", () => {
  it("assembles host, optional fields and hint", () => {
    const diagnostic = buildFetchDiagnostic({
      url: "https://cdn.example.com/v/master.m3u8?e=1",
      stage: "manifest",
      error: "Failed to fetch",
      networkError: "net::ERR_BLOCKED_BY_CLIENT",
      replayedHeaders: {},
    });
    expect(diagnostic).toEqual({
      url: "https://cdn.example.com/v/master.m3u8?e=1",
      host: "cdn.example.com",
      stage: "manifest",
      error: "Failed to fetch",
      networkError: "net::ERR_BLOCKED_BY_CLIENT",
      hint: expect.stringMatching(/blocked/),
    });
  });
});
