// Pure logic — parses HLS (.m3u8) playlist text into data. No fetching, no
// browser APIs: callers fetch the text and pass it in, which is what makes
// this testable against fixture playlists and reusable from both the popup
// (to show a quality picker) and the offscreen document (to run a download).

export interface HlsVariant {
  /** Absolute URL of this variant's media playlist. */
  url: string;
  bandwidth: number;
  resolution?: { width: number; height: number };
  codecs?: string;
  /** GROUP-ID of a separate audio rendition, when audio isn't muxed into the video segments. */
  audioGroupId?: string;
}

export interface HlsAudioRendition {
  groupId: string;
  name: string;
  /** Absolute URL. Absent means this rendition is muxed into the video segments. */
  url?: string;
  isDefault: boolean;
  language?: string;
}

export interface HlsMasterPlaylist {
  variants: HlsVariant[];
  audioRenditions: HlsAudioRendition[];
}

/** AES-128 is the only method we can decrypt; see `unsupportedEncryption`. */
export interface HlsEncryption {
  keyUrl: string;
  /** Explicit IV from the playlist, if given. Absent means "derive from sequence number". */
  ivHex?: string;
}

export interface HlsSegment {
  url: string;
  duration: number;
  sequenceNumber: number;
  /** Absent when this segment is unencrypted (no EXT-X-KEY, or METHOD=NONE). */
  encryption?: HlsEncryption;
}

export interface HlsMediaPlaylist {
  segments: HlsSegment[];
  targetDuration: number;
  /** EXT-X-MAP initialization segment — present for fMP4 (CMAF) streams. */
  initSegmentUrl?: string;
  /**
   * Set when the playlist uses an encryption METHOD we can't handle (e.g.
   * SAMPLE-AES / Widevine). Callers surface this instead of producing a file
   * that would be silently corrupt.
   */
  unsupportedEncryption?: string;
}

/**
 * Parses an HLS attribute list (`KEY=VALUE,KEY="quoted,value"`). Quoted values
 * may contain commas, so this can't just split on ",".
 */
function parseAttributes(input: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let cursor = 0;

  while (cursor < input.length) {
    const equals = input.indexOf("=", cursor);
    if (equals === -1) break;

    const key = input.slice(cursor, equals).trim();
    let value: string;

    if (input[equals + 1] === '"') {
      const closingQuote = input.indexOf('"', equals + 2);
      if (closingQuote === -1) break;
      value = input.slice(equals + 2, closingQuote);
      cursor = closingQuote + 2; // skip the quote and the comma after it
    } else {
      let end = input.indexOf(",", equals + 1);
      if (end === -1) end = input.length;
      value = input.slice(equals + 1, end).trim();
      cursor = end + 1;
    }

    attributes[key] = value;
  }

  return attributes;
}

function resolveUrl(uri: string, baseUrl: string): string {
  return new URL(uri, baseUrl).toString();
}

function parseResolution(value: string | undefined): { width: number; height: number } | undefined {
  if (!value) return undefined;
  const [width, height] = value.split("x").map(Number);
  if (!width || !height) return undefined;
  return { width, height };
}

/** True for a master playlist (one that lists variants) rather than a media playlist (one that lists segments). */
export function isMasterPlaylist(text: string): boolean {
  return text.includes("#EXT-X-STREAM-INF");
}

export function parseMasterPlaylist(text: string, baseUrl: string): HlsMasterPlaylist {
  const lines = text.split("\n").map((line) => line.trim());
  const variants: HlsVariant[] = [];
  const audioRenditions: HlsAudioRendition[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;

    if (line.startsWith("#EXT-X-MEDIA:")) {
      const attributes = parseAttributes(line.slice("#EXT-X-MEDIA:".length));
      if (attributes["TYPE"] !== "AUDIO" || !attributes["GROUP-ID"]) continue;
      audioRenditions.push({
        groupId: attributes["GROUP-ID"],
        name: attributes["NAME"] ?? attributes["GROUP-ID"],
        isDefault: attributes["DEFAULT"] === "YES",
        ...(attributes["URI"] && { url: resolveUrl(attributes["URI"], baseUrl) }),
        ...(attributes["LANGUAGE"] && { language: attributes["LANGUAGE"] }),
      });
      continue;
    }

    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      // The variant's URI is on the next non-comment line.
      const uri = lines.slice(i + 1).find((candidate) => candidate && !candidate.startsWith("#"));
      if (!uri) continue;

      const attributes = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
      const resolution = parseResolution(attributes["RESOLUTION"]);
      variants.push({
        url: resolveUrl(uri, baseUrl),
        bandwidth: Number(attributes["BANDWIDTH"] ?? 0),
        ...(resolution && { resolution }),
        ...(attributes["CODECS"] && { codecs: attributes["CODECS"] }),
        ...(attributes["AUDIO"] && { audioGroupId: attributes["AUDIO"] }),
      });
    }
  }

  return { variants, audioRenditions };
}

export function parseMediaPlaylist(text: string, baseUrl: string): HlsMediaPlaylist {
  const lines = text.split("\n").map((line) => line.trim());

  const segments: HlsSegment[] = [];
  let targetDuration = 0;
  let initSegmentUrl: string | undefined;
  let unsupportedEncryption: string | undefined;

  // Carried across lines: an EXT-X-KEY applies to every following segment
  // until the next EXT-X-KEY (key rotation), and EXTINF applies to the very
  // next URI line.
  let currentEncryption: HlsEncryption | undefined;
  let pendingDuration = 0;
  let firstSequenceNumber = 0;

  for (const line of lines) {
    if (!line) continue;

    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDuration = Number(line.slice("#EXT-X-TARGETDURATION:".length));
      continue;
    }

    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      firstSequenceNumber = Number(line.slice("#EXT-X-MEDIA-SEQUENCE:".length));
      continue;
    }

    if (line.startsWith("#EXT-X-MAP:")) {
      const attributes = parseAttributes(line.slice("#EXT-X-MAP:".length));
      if (attributes["URI"]) initSegmentUrl = resolveUrl(attributes["URI"], baseUrl);
      continue;
    }

    if (line.startsWith("#EXT-X-KEY:")) {
      const attributes = parseAttributes(line.slice("#EXT-X-KEY:".length));
      const method = attributes["METHOD"];

      if (method === "NONE") {
        currentEncryption = undefined;
      } else if (method === "AES-128" && attributes["URI"]) {
        currentEncryption = {
          keyUrl: resolveUrl(attributes["URI"], baseUrl),
          ...(attributes["IV"] && { ivHex: attributes["IV"] }),
        };
      } else if (method) {
        // e.g. SAMPLE-AES (FairPlay/Widevine) — we can detect it but not decrypt it.
        unsupportedEncryption = method;
        currentEncryption = undefined;
      }
      continue;
    }

    if (line.startsWith("#EXTINF:")) {
      pendingDuration = Number.parseFloat(line.slice("#EXTINF:".length)) || 0;
      continue;
    }

    if (line.startsWith("#")) continue;

    segments.push({
      url: resolveUrl(line, baseUrl),
      duration: pendingDuration,
      sequenceNumber: firstSequenceNumber + segments.length,
      ...(currentEncryption && { encryption: currentEncryption }),
    });
    pendingDuration = 0;
  }

  return {
    segments,
    targetDuration,
    ...(initSegmentUrl && { initSegmentUrl }),
    ...(unsupportedEncryption && { unsupportedEncryption }),
  };
}

/**
 * The 16-byte AES-CBC IV for a segment. Per the HLS spec, when EXT-X-KEY has
 * no explicit IV the segment's media sequence number is used instead, as a
 * big-endian 128-bit value.
 */
export function computeSegmentIv(sequenceNumber: number, explicitIvHex?: string): Uint8Array {
  const iv = new Uint8Array(16);

  if (explicitIvHex) {
    const hex = explicitIvHex.replace(/^0[xX]/, "").padStart(32, "0");
    for (let i = 0; i < 16; i += 1) {
      iv[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return iv;
  }

  // Big-endian sequence number in the low 8 bytes.
  let remaining = BigInt(sequenceNumber);
  for (let i = 15; i >= 8; i -= 1) {
    iv[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return iv;
}
