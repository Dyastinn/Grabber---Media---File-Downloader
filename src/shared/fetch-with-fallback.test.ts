import { describe, expect, it, vi } from "vitest";
import { fetchWithCredentialFallback } from "./fetch-with-fallback";

const ok = () => Promise.resolve(new Response("body", { status: 200 }));

describe("fetchWithCredentialFallback", () => {
  it("fetches with credentials first and stops there when that works", async () => {
    const impl = vi.fn(ok);
    await fetchWithCredentialFallback("https://cdn/x", impl);
    expect(impl.mock.calls).toEqual([["https://cdn/x", { credentials: "include" }]]);
  });

  it("retries without credentials only after a network-level rejection", async () => {
    const impl = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockImplementationOnce(ok);
    const response = await fetchWithCredentialFallback("https://cdn/x", impl);
    expect(response.status).toBe(200);
    expect(impl.mock.calls.map(([, init]) => init.credentials)).toEqual(["include", "omit"]);
  });

  it("does not retry on an HTTP error status (that is a response, not a rejection)", async () => {
    const impl = vi.fn(() => Promise.resolve(new Response("", { status: 403 })));
    expect((await fetchWithCredentialFallback("https://cdn/x", impl)).status).toBe(403);
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("reports the original error when both attempts fail", async () => {
    const impl = vi.fn().mockRejectedValueOnce(new TypeError("first")).mockRejectedValueOnce(new TypeError("second"));
    await expect(fetchWithCredentialFallback("https://cdn/x", impl)).rejects.toThrow("first");
  });
});
