// Pure logic — figures out a reasonable filename to save a download as.

const CONTENT_DISPOSITION_FILENAME_RE = /filename\*?=(?:UTF-8''|")?([^";]+)"?/i;

/** Extracts a filename from a Content-Disposition header, if present. */
function filenameFromContentDisposition(header: string | undefined | null): string | undefined {
  if (!header) return undefined;
  const match = CONTENT_DISPOSITION_FILENAME_RE.exec(header);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1].trim());
  } catch {
    return match[1].trim();
  }
}

/** Extracts the last path segment from a URL, if it looks like a filename. */
function filenameFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const lastSegment = parsed.pathname.split("/").filter(Boolean).pop();
    if (!lastSegment) return undefined;
    return decodeURIComponent(lastSegment);
  } catch {
    return undefined;
  }
}

/**
 * Best-effort filename for a download: prefer an explicit Content-Disposition
 * filename, fall back to the last URL path segment, and finally a generic
 * placeholder so callers never have to handle "no filename".
 */
export function guessFilename(url: string, contentDisposition?: string | null): string {
  return (
    filenameFromContentDisposition(contentDisposition) ?? filenameFromUrl(url) ?? "download"
  );
}

// Characters that chrome.downloads.download() rejects in a filename (it
// errors with "Invalid filename" rather than substituting), plus control
// characters. Path separators are included so a title can't escape the
// downloads directory.
const UNSAFE_FILENAME_CHARS_RE = /[\\/:*?"<>|\u0000-\u001f]+/g;
const MAX_FILENAME_LENGTH = 150;

/**
 * Turns free text (a page's video title) into something safe to pass to
 * chrome.downloads.download(). Collapses whitespace, strips reserved
 * characters, and caps the length — long titles otherwise hit filesystem
 * limits once the quality suffix and extension are added.
 */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(UNSAFE_FILENAME_CHARS_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
    // A trailing dot makes Windows silently drop it (and "..." looks like a path).
    .replace(/\.+$/, "")
    .trim();
  return cleaned.slice(0, MAX_FILENAME_LENGTH).trim();
}
