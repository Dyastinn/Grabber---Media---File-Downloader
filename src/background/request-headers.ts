// Pure logic — no chrome.* calls (a type import only). Remembers, per origin,
// the request headers a page's own player sent for manifests and segments, and
// turns them into declarativeNetRequest rules so the extension's fetches of
// the same origin carry the same headers.
//
// Why: the popup fetches a manifest, and the offscreen document fetches
// segments, from the extension's own origin. Servers that check Referer,
// Origin, an Authorization bearer or a custom token header answer 403 to
// those, while the page's player — which sent the headers — works fine.
// Replaying whatever the player sent is the only generic answer; a hostname
// list would be a maintenance treadmill.

export type HeaderMap = Record<string, string>;

/** Headers the browser manages itself, that describe THIS request, or that must never be replayed. */
const NOT_REPLAYABLE = new Set([
  "accept",
  "accept-charset",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "dnt",
  "host",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "if-unmodified-since",
  "keep-alive",
  "pragma",
  "priority",
  "proxy-authorization",
  "purpose",
  "range",
  "te",
  "transfer-encoding",
  "upgrade",
  "upgrade-insecure-requests",
  "user-agent",
  "via",
]);

/** Keeps only headers worth replaying (Referer, Origin, Authorization, custom X-* tokens…), lower-cased. */
export function replayableHeaders(headers: Array<{ name: string; value?: string }>): HeaderMap {
  const kept: HeaderMap = {};
  for (const { name, value } of headers) {
    const key = name.toLowerCase();
    if (value === undefined || NOT_REPLAYABLE.has(key) || key.startsWith("sec-")) continue;
    kept[key] = value;
  }
  return kept;
}

/** "https://cdn.example.com" for any URL on that origin; undefined for unparseable or non-http URLs. */
export function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

/**
 * Per-origin header memory. Headers accumulate per origin (latest value per
 * name) rather than replace each other: the manifest request may carry a
 * token the segment requests don't, and the segment requests must not wipe
 * it. `record` returns true only when something actually changed, so callers
 * can avoid rewriting a rule on every one of the hundreds of segment requests
 * a playing video makes.
 */
export class RequestHeaderStore {
  private readonly byOrigin = new Map<string, HeaderMap>();

  /** Every fetch-style request in every tab is recorded; keep the memory bounded (oldest origin out). */
  constructor(private readonly maxOrigins = 500) {}

  record(url: string, headers: Array<{ name: string; value?: string }>): boolean {
    const origin = originOf(url);
    if (!origin) return false;
    const seen = replayableHeaders(headers);
    if (Object.keys(seen).length === 0) return false;
    const previous = this.byOrigin.get(origin);
    const next = { ...previous, ...seen };
    if (previous && sameHeaders(previous, next)) return false;
    this.byOrigin.delete(origin); // re-insert so Map order is least-recently-updated first
    this.byOrigin.set(origin, next);
    if (this.byOrigin.size > this.maxOrigins) {
      const oldest = this.byOrigin.keys().next().value;
      if (oldest !== undefined) this.byOrigin.delete(oldest);
    }
    return true;
  }

  get(url: string): HeaderMap | undefined {
    const origin = originOf(url);
    return origin ? this.byOrigin.get(origin) : undefined;
  }
}

function sameHeaders(a: HeaderMap, b: HeaderMap): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * The headers to use when nothing was recorded for an origin — a manifest
 * found in the page DOM before the player fetched anything, say. Most
 * hotlink checks want exactly these two.
 */
export function fallbackHeaders(pageUrl: string): HeaderMap {
  const pageOrigin = originOf(pageUrl);
  return pageOrigin ? { referer: pageUrl, origin: pageOrigin } : {};
}

/**
 * A stable, positive 31-bit rule id for an origin (FNV-1a). Session rules
 * outlive a restarted service worker, so ids must not come from a counter
 * that restarts at 1.
 */
export function ruleIdFor(origin: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < origin.length; i++) {
    hash ^= origin.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 1) || 1; // never 0, never negative
}

const CANONICAL_NAMES: Record<string, string> = {
  referer: "Referer",
  origin: "Origin",
  authorization: "Authorization",
};

/**
 * A declarativeNetRequest rule that sets `headers` on every fetch/XHR-style
 * request to `origin`. Not restricted to the extension's own requests: the
 * page's requests already carry these same values, so it is a no-op there.
 */
export function buildHeaderRule(
  origin: string,
  headers: HeaderMap
): chrome.declarativeNetRequest.Rule {
  return {
    id: ruleIdFor(origin),
    priority: 1,
    action: {
      type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: Object.entries(headers).map(([name, value]) => ({
        header: CANONICAL_NAMES[name] ?? name,
        operation: "set" as chrome.declarativeNetRequest.HeaderOperation,
        value,
      })),
    },
    condition: {
      // "|" anchors the match at the start of the URL, so "https://a.example.com/"
      // can't also match "https://a.example.com.evil.net/".
      urlFilter: `|${origin}/`,
      resourceTypes: [
        "xmlhttprequest",
        "media",
        "other",
      ] as chrome.declarativeNetRequest.ResourceType[],
    },
  };
}
