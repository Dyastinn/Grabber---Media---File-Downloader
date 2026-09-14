// Pure logic — parses a DASH .mpd manifest into data. Uses DOMParser, which
// exists in real browsers and in jsdom, so this stays unit-testable.
//
// Scope (see README): only SegmentTemplate addressing with $Number$ is
// supported. SegmentTimeline / SegmentList / SegmentBase manifests are
// reported as unsupported rather than parsed into a plan that would silently
// produce a broken file.

export interface DashRepresentation {
  id: string;
  bandwidth: number;
  width?: number;
  height?: number;
  codecs?: string;
  mimeType?: string;
  /** Initialization segment — DASH is fMP4, so this is always needed before the media segments. */
  initUrl?: string;
  segmentUrls: string[];
}

export type DashParseResult =
  | { supported: true; video: DashRepresentation[]; audio: DashRepresentation[] }
  | { supported: false; reason: string };

/** Parses an ISO 8601 duration (e.g. "PT1H2M3.5S") into seconds. */
export function parseIsoDuration(value: string | null | undefined): number {
  if (!value) return 0;
  const match = /^P(?:([\d.]+)Y)?(?:([\d.]+)M)?(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/.exec(
    value
  );
  if (!match) return 0;
  const [, years, months, days, hours, minutes, seconds] = match;
  return (
    Number(years ?? 0) * 365 * 24 * 3600 +
    Number(months ?? 0) * 30 * 24 * 3600 +
    Number(days ?? 0) * 24 * 3600 +
    Number(hours ?? 0) * 3600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0)
  );
}

/** Applies DASH's $Variable$ substitutions, including $Number%05d$ zero-padding. */
export function substituteTemplate(
  template: string,
  values: { representationId: string; bandwidth: number; number?: number }
): string {
  return template
    .replace(/\$RepresentationID\$/g, values.representationId)
    .replace(/\$Bandwidth\$/g, String(values.bandwidth))
    .replace(/\$Number(?:%0(\d+)d)?\$/g, (_match, width: string | undefined) => {
      if (values.number === undefined) return "";
      return width ? String(values.number).padStart(Number(width), "0") : String(values.number);
    })
    .replace(/\$\$/g, "$");
}

function resolveUrl(uri: string, baseUrl: string): string {
  return new URL(uri, baseUrl).toString();
}

/** DASH allows a <BaseURL> child to re-root all relative URLs below it. */
function resolveBaseUrl(element: Element | Document, currentBase: string): string {
  const baseElement = [...element.children].find((child) => child.localName === "BaseURL");
  const value = baseElement?.textContent?.trim();
  return value ? resolveUrl(value, currentBase) : currentBase;
}

function findChild(element: Element, localName: string): Element | undefined {
  return [...element.children].find((child) => child.localName === localName);
}

function findDescendants(root: Element | Document, localName: string): Element[] {
  return [...root.getElementsByTagName("*")].filter((el) => el.localName === localName);
}

function numberAttribute(element: Element, name: string): number | undefined {
  const raw = element.getAttribute(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function buildRepresentation(
  representation: Element,
  segmentTemplate: Element,
  baseUrl: string,
  periodDurationSeconds: number
): DashRepresentation | null {
  const id = representation.getAttribute("id") ?? "";
  const bandwidth = numberAttribute(representation, "bandwidth") ?? 0;
  const media = segmentTemplate.getAttribute("media");
  if (!media) return null;

  const timescale = numberAttribute(segmentTemplate, "timescale") ?? 1;
  const segmentDuration = numberAttribute(segmentTemplate, "duration");
  if (!segmentDuration) return null;

  const startNumber = numberAttribute(segmentTemplate, "startNumber") ?? 1;
  const secondsPerSegment = segmentDuration / timescale;
  const segmentCount = Math.max(1, Math.ceil(periodDurationSeconds / secondsPerSegment));

  const segmentUrls: string[] = [];
  for (let i = 0; i < segmentCount; i += 1) {
    const uri = substituteTemplate(media, {
      representationId: id,
      bandwidth,
      number: startNumber + i,
    });
    segmentUrls.push(resolveUrl(uri, baseUrl));
  }

  const initialization = segmentTemplate.getAttribute("initialization");
  const initUrl = initialization
    ? resolveUrl(substituteTemplate(initialization, { representationId: id, bandwidth }), baseUrl)
    : undefined;

  const width = numberAttribute(representation, "width");
  const height = numberAttribute(representation, "height");
  const codecs = representation.getAttribute("codecs");
  const mimeType = representation.getAttribute("mimeType");

  return {
    id,
    bandwidth,
    segmentUrls,
    ...(width !== undefined && { width }),
    ...(height !== undefined && { height }),
    ...(codecs && { codecs }),
    ...(mimeType && { mimeType }),
    ...(initUrl && { initUrl }),
  };
}

export function parseManifest(xmlText: string, baseUrl: string): DashParseResult {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    return { supported: false, reason: "The DASH manifest could not be parsed." };
  }

  const mpd = doc.documentElement;
  if (!mpd || mpd.localName !== "MPD") {
    return { supported: false, reason: "The DASH manifest could not be parsed." };
  }

  if (findDescendants(doc, "SegmentTimeline").length > 0) {
    return {
      supported: false,
      reason: "This stream uses SegmentTimeline addressing, which isn't supported yet.",
    };
  }
  if (findDescendants(doc, "SegmentList").length > 0) {
    return {
      supported: false,
      reason: "This stream uses SegmentList addressing, which isn't supported yet.",
    };
  }

  const totalDuration = parseIsoDuration(mpd.getAttribute("mediaPresentationDuration"));
  const mpdBaseUrl = resolveBaseUrl(mpd, baseUrl);

  const video: DashRepresentation[] = [];
  const audio: DashRepresentation[] = [];

  for (const period of findDescendants(mpd, "Period")) {
    const periodBaseUrl = resolveBaseUrl(period, mpdBaseUrl);
    const periodDuration = parseIsoDuration(period.getAttribute("duration")) || totalDuration;

    for (const adaptationSet of [...period.children].filter((c) => c.localName === "AdaptationSet")) {
      const adaptationBaseUrl = resolveBaseUrl(adaptationSet, periodBaseUrl);
      const adaptationTemplate = findChild(adaptationSet, "SegmentTemplate");

      for (const representation of [...adaptationSet.children].filter(
        (c) => c.localName === "Representation"
      )) {
        const template = findChild(representation, "SegmentTemplate") ?? adaptationTemplate;
        if (!template) continue;

        const parsed = buildRepresentation(
          representation,
          template,
          resolveBaseUrl(representation, adaptationBaseUrl),
          periodDuration
        );
        if (!parsed) continue;

        // contentType/mimeType can live on either the AdaptationSet or the Representation.
        const kind =
          adaptationSet.getAttribute("contentType") ??
          adaptationSet.getAttribute("mimeType") ??
          parsed.mimeType ??
          "";

        if (kind.includes("video")) video.push(parsed);
        else if (kind.includes("audio")) audio.push(parsed);
      }
    }
  }

  if (video.length === 0 && audio.length === 0) {
    return {
      supported: false,
      reason: "No downloadable video or audio tracks were found in this manifest.",
    };
  }

  return { supported: true, video, audio };
}
