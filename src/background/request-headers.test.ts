import { describe, expect, it } from "vitest";
import {
  buildHeaderRule,
  fallbackHeaders,
  originOf,
  replayableHeaders,
  RequestHeaderStore,
  ruleIdFor,
} from "./request-headers";

describe("replayableHeaders", () => {
  it("keeps hotlink/auth-relevant headers, lower-cased", () => {
    expect(
      replayableHeaders([
        { name: "Referer", value: "https://site.example/watch/1" },
        { name: "Origin", value: "https://site.example" },
        { name: "Authorization", value: "Bearer abc" },
        { name: "X-Playback-Token", value: "t0k3n" },
      ])
    ).toEqual({
      referer: "https://site.example/watch/1",
      origin: "https://site.example",
      authorization: "Bearer abc",
      "x-playback-token": "t0k3n",
    });
  });

  it("drops browser-managed, request-specific and sec-* headers", () => {
    expect(
      replayableHeaders([
        { name: "Accept", value: "*/*" },
        { name: "Range", value: "bytes=0-1023" },
        { name: "Cookie", value: "session=1" },
        { name: "User-Agent", value: "UA" },
        { name: "Sec-Fetch-Mode", value: "cors" },
        { name: "Content-Length", value: "0" },
        { name: "Nameless" },
      ])
    ).toEqual({});
  });
});

describe("originOf", () => {
  it("returns the scheme+host origin for http(s) URLs only", () => {
    expect(originOf("https://cdn.example.com:8443/a/b.m3u8?x=1")).toBe("https://cdn.example.com:8443");
    expect(originOf("blob:https://site.example/uuid")).toBeUndefined();
    expect(originOf("not a url")).toBeUndefined();
  });
});

describe("RequestHeaderStore", () => {
  it("records per origin and reports whether anything changed", () => {
    const store = new RequestHeaderStore();
    const headers = [{ name: "Referer", value: "https://site.example/" }];

    expect(store.record("https://cdn.example.com/seg1.ts", headers)).toBe(true);
    expect(store.record("https://cdn.example.com/seg2.ts", headers)).toBe(false); // same origin, same headers
    expect(store.record("https://cdn.example.com/seg3.ts", [{ name: "Referer", value: "https://site.example/other" }])).toBe(true);

    expect(store.get("https://cdn.example.com/master.m3u8")).toEqual({ referer: "https://site.example/other" });
    expect(store.get("https://elsewhere.example.com/x")).toBeUndefined();
  });

  it("accumulates headers per origin so segment requests don't wipe a token the manifest request carried", () => {
    const store = new RequestHeaderStore();
    store.record("https://cdn.example.com/playlist", [
      { name: "Referer", value: "https://site.example/" },
      { name: "X-Player-Token", value: "abc" },
    ]);
    expect(store.record("https://cdn.example.com/seg1.ts", [{ name: "Referer", value: "https://site.example/" }])).toBe(false);
    expect(store.get("https://cdn.example.com/seg1.ts")).toEqual({
      referer: "https://site.example/",
      "x-player-token": "abc",
    });
  });

  it("evicts the least recently updated origin once the cap is reached", () => {
    const store = new RequestHeaderStore(2);
    const referer = [{ name: "Referer", value: "https://site.example/" }];
    store.record("https://a.example.com/x", referer);
    store.record("https://b.example.com/x", referer);
    store.record("https://c.example.com/x", referer);
    expect(store.get("https://a.example.com/x")).toBeUndefined();
    expect(store.get("https://b.example.com/x")).toBeDefined();
    expect(store.get("https://c.example.com/x")).toBeDefined();
  });

  it("ignores requests with nothing replayable rather than storing an empty map", () => {
    const store = new RequestHeaderStore();
    expect(store.record("https://cdn.example.com/a", [{ name: "Accept", value: "*/*" }])).toBe(false);
    expect(store.get("https://cdn.example.com/a")).toBeUndefined();
  });
});

describe("fallbackHeaders", () => {
  it("derives Referer and Origin from the page URL", () => {
    expect(fallbackHeaders("https://site.example/watch/1?x=y")).toEqual({
      referer: "https://site.example/watch/1?x=y",
      origin: "https://site.example",
    });
    expect(fallbackHeaders("about:blank")).toEqual({});
  });
});

describe("ruleIdFor", () => {
  it("is stable, positive and distinct across origins", () => {
    const a = ruleIdFor("https://a.example.com");
    expect(a).toBe(ruleIdFor("https://a.example.com"));
    expect(a).toBeGreaterThan(0);
    expect(a).not.toBe(ruleIdFor("https://b.example.com"));
    expect(ruleIdFor("")).toBeGreaterThan(0);
  });
});

describe("buildHeaderRule", () => {
  it("sets each header on fetch-style requests to the origin, anchored at the URL start", () => {
    const rule = buildHeaderRule("https://cdn.example.com", {
      referer: "https://site.example/",
      "x-token": "abc",
    });
    expect(rule.id).toBe(ruleIdFor("https://cdn.example.com"));
    expect(rule.condition.urlFilter).toBe("|https://cdn.example.com/");
    expect(rule.condition.resourceTypes).toEqual(["xmlhttprequest", "media", "other"]);
    expect(rule.action.type).toBe("modifyHeaders");
    expect(rule.action.requestHeaders).toEqual([
      { header: "Referer", operation: "set", value: "https://site.example/" },
      { header: "x-token", operation: "set", value: "abc" },
    ]);
  });
});
