// Pure class — no browser APIs. Tracks in-flight stream downloads so a popup
// that was closed and reopened mid-download can show where things are, rather
// than offering to start the same download again.
//
// Same shape as MediaStore (add/list/clear) so the pattern is familiar.

import type { StreamPhase, StreamProgressEntry } from "../shared/messages";

export class StreamProgressStore {
  private readonly entries = new Map<string, StreamProgressEntry>();

  /** Records progress for an in-flight download. */
  update(streamUrl: string, phase: StreamPhase, percent: number): void {
    this.entries.set(streamUrl, { streamUrl, phase, percent });
  }

  /** Marks a download finished. Kept in the list so the popup can show a done state. */
  complete(streamUrl: string): void {
    this.entries.set(streamUrl, { streamUrl, phase: "done", percent: 100 });
  }

  /** Marks a download failed, keeping the reason for the popup to display. */
  fail(streamUrl: string, error: string): void {
    this.entries.set(streamUrl, { streamUrl, phase: "error", percent: 0, error });
  }

  get(streamUrl: string): StreamProgressEntry | undefined {
    return this.entries.get(streamUrl);
  }

  list(): StreamProgressEntry[] {
    return [...this.entries.values()];
  }

  /** True while a download for this URL is still running — used to reject duplicate requests. */
  isActive(streamUrl: string): boolean {
    const entry = this.entries.get(streamUrl);
    return entry !== undefined && entry.phase !== "done" && entry.phase !== "error";
  }

  clear(streamUrl: string): void {
    this.entries.delete(streamUrl);
  }
}
