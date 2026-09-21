// Pure logic — no chrome.* calls. Reads the request headers a page passed to
// fetch()/XMLHttpRequest, so the sniffer can report them alongside a manifest
// it recognised. These are the JS-set headers (Authorization, custom tokens…)
// — the browser-managed ones (Referer, Origin, Cookie) never appear here.

export type HeaderRecord = Record<string, string>;

function fromHeadersInit(init: HeadersInit | undefined, into: HeaderRecord): void {
  if (!init) return;
  // Duck-typed rather than `instanceof Headers`: a Headers object from another
  // realm (an iframe, or a Request built by a library) fails instanceof.
  if (!Array.isArray(init) && typeof (init as Headers).forEach === "function") {
    (init as Headers).forEach((value, name) => {
      into[name.toLowerCase()] = value;
    });
    return;
  }
  const entries = Array.isArray(init) ? init : Object.entries(init);
  for (const [name, value] of entries) {
    if (typeof name === "string" && typeof value === "string") into[name.toLowerCase()] = value;
  }
}

/**
 * The headers a fetch(input, init) call will send, lower-cased. `init.headers`
 * wins over a Request object's own headers, as in the Fetch spec.
 */
export function headersFromFetchArgs(input: RequestInfo | URL, init?: RequestInit): HeaderRecord {
  const headers: HeaderRecord = {};
  if (typeof input === "object" && "headers" in input) fromHeadersInit(input.headers, headers); // a Request
  fromHeadersInit(init?.headers, headers);
  return headers;
}
