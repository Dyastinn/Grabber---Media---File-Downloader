import { describe, expect, it } from "vitest";
import { headersFromFetchArgs } from "./fetch-headers";

describe("headersFromFetchArgs", () => {
  it("reads a plain object, an array of pairs, and a Headers instance", () => {
    expect(headersFromFetchArgs("/x", { headers: { "X-Player-Token": "t" } })).toEqual({ "x-player-token": "t" });
    expect(headersFromFetchArgs("/x", { headers: [["Authorization", "Bearer a"]] })).toEqual({ authorization: "Bearer a" });
    expect(headersFromFetchArgs("/x", { headers: new Headers({ "X-Tok": "1" }) })).toEqual({ "x-tok": "1" });
  });

  it("takes a Request object's headers, with init.headers winning", () => {
    const request = new Request("https://example.com/x", { headers: { "X-A": "req", "X-B": "req" } });
    expect(headersFromFetchArgs(request, { headers: { "X-B": "init" } })).toEqual({ "x-a": "req", "x-b": "init" });
  });

  it("returns an empty record when nothing was set", () => {
    expect(headersFromFetchArgs("/x")).toEqual({});
    expect(headersFromFetchArgs(new URL("https://example.com/x"), {})).toEqual({});
  });
});
