// Pure-ish helper (takes fetch as a parameter, so it is unit-testable without
// a browser). Both the popup and the offscreen document fetch stream URLs
// with it.
//
// Extension pages fetch cross-origin with cookies (login-gated players need
// them). With "Site access: On all sites" Chrome exempts those requests from
// CORS; with any narrower setting it does not, and then a credentialed
// request against a CDN answering `Access-Control-Allow-Origin: *` is
// rejected at network level (net::ERR_FAILED) — while the same request
// without cookies is fine, and such CDNs don't want cookies anyway. So: try
// with credentials, and on a network-level rejection try once without.

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export async function fetchWithCredentialFallback(
  url: string,
  fetchImpl: FetchLike = (u, init) => fetch(u, init)
): Promise<Response> {
  try {
    return await fetchImpl(url, { credentials: "include" });
  } catch (error) {
    try {
      return await fetchImpl(url, { credentials: "omit" });
    } catch {
      throw error; // report the original failure, not the retry's
    }
  }
}
