# Grabber — Media & File Downloader

A browser extension (Chrome, Edge, Firefox) that scans the current page for downloadable media and files — video, audio, images, documents, archives — and for adaptive video streams (HLS/DASH), which it can download and merge into a single playable MP4. Think of it as a lightweight IDM.

## What it supports

**Direct files** — anything with a stable URL and a recognizable extension or Content-Type (mp4, webm, mp3, pdf, zip, jpg, …). Detected from both the page DOM and from actual network responses, then handed to the browser's own download manager.

**Video streams** — HLS (`.m3u8`) and DASH (`.mpd`). These aren't single files: the video is split into many segments, often with audio delivered as a separate track. The extension fetches every segment, decrypts them where needed, and merges everything into one MP4 using ffmpeg compiled to WebAssembly — all inside the browser, with no companion app to install.

- You pick the quality first: the popup reads the manifest and lists the available video variants (resolution/bitrate). Audio tracks are selected automatically (highest bitrate / the stream's default).
- **AES-128 encrypted HLS is supported**, including key rotation mid-playlist and the spec's implicit "IV derived from the segment sequence number" rule.
- Downloads keep running if you close the popup, and you get a notification when one finishes. Reopening the popup shows the current progress rather than starting over.

### Known limits

These surface in the popup as a clear "not supported" message rather than producing a silently broken file:

- **DRM-protected streams** (`SAMPLE-AES`, Widevine, FairPlay) can't be downloaded. This is encryption the extension has no key for, by design — not a gap to be filled in later.
- **DASH manifests using `SegmentTimeline` or `SegmentList`** addressing. Only the common `SegmentTemplate` + `$Number$` form is handled so far.
- **Manual audio-track selection** — if a stream offers several audio languages, the default one is used.

## How a request flows through the system

1. **Content script** (`src/content/`) scans the page's DOM for `<video>`, `<audio>`, `<source>` and `<a>` elements pointing at recognized file types or stream manifests, re-scanning on DOM changes (for players that load in after the page does). It messages what it finds to the background service worker.
2. **Background service worker** (`src/background/`) also watches network responses directly (`chrome.webRequest.onHeadersReceived`, read-only), so it catches things the DOM scan misses — most importantly the manifest requests a player makes via JavaScript, which never appear as a `src` attribute. It keeps a per-tab list, cleared when that tab navigates.
3. **Popup** (`src/popup/` + `popup/popup.html`) shows what the current tab found. A file downloads immediately; a stream first gets its manifest fetched and parsed to offer a quality picker.
4. **Offscreen document** (`src/offscreen/` + `offscreen/offscreen.html`) does the heavy lifting for streams: fetching segments in parallel, AES-128 decryption, and the ffmpeg merge. It's a hidden page the background worker creates on demand — see below for why it has to exist.

### Why there's an offscreen document

ffmpeg.wasm needs a real DOM/Worker context, which an MV3 background service worker doesn't provide. Chrome's answer to exactly this problem is the **offscreen document**: a hidden extension page the service worker creates when it needs one. All the stream download work happens there, and it reports progress back by message.

### Why ffmpeg's files are copied into `dist/`

Manifest V3 forbids extensions from loading executable code from a remote origin, and the extension CSP also blocks the blob-URL worker `@ffmpeg/ffmpeg` creates by default. So the build copies `ffmpeg-core.js`, `ffmpeg-core.wasm` and the library's worker chunk into `dist/ffmpeg/`, and they're loaded from `chrome-extension://` URLs. **Do not replace these with a CDN URL** (as ffmpeg.wasm's own quickstart does) — it will break the extension.

### Where to add code

Every file is either:

- **Pure logic** — takes data, returns data, no `chrome.*` calls, unit-tested. That's everything in `src/shared/` (file classification, filename guessing, HLS/DASH parsing, download planning), plus `src/background/media-store.ts`, `src/background/stream-progress-store.ts`, `src/content/scan.ts`, `src/popup/render.ts`, and `src/offscreen/decrypt.ts`. New file-type rules, parsing changes, or rendering changes go here.
- **Browser-API wiring** — the `index.ts` in each of `src/background/`, `src/content/`, `src/popup/`, `src/offscreen/`. These connect real `chrome.*` events to the pure functions and hold no business logic. A new event to listen for or a new message type goes here (message shapes live in `src/shared/messages.ts`).

Notably, the popup and the offscreen document parse manifests with the *same* pure modules, so the quality list you pick from and the download that runs can never disagree about a stream.

## Development

```sh
npm install
npm run build       # one-shot build -> dist/
npm run watch        # rebuild on save
npm run typecheck     # tsc --noEmit
npm test               # unit tests (vitest)
npm run test:e2e        # builds, then runs Playwright against a real extension in real Chromium
```

### Loading the unpacked extension

After `npm run build` (which generates `dist/`, referenced by `manifest.json` at the repo root):

- **Chrome / Edge**: open `chrome://extensions` (or `edge://extensions`), enable Developer mode, click "Load unpacked", select this repo's root folder.
- **Firefox**: open `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on", select `manifest.json` in this repo's root. (Temporary add-ons are removed when Firefox closes.)

Note that stream downloading relies on `chrome.offscreen`, which is Chromium-only; on Firefox the file-download half works and stream downloads will not start.

### Testing

- **Unit tests** cover all the pure logic, including fixture-based tests for HLS playlist parsing (encrypted, key-rotating, and fMP4 playlists), DASH manifest parsing, download planning, and AES-128 decryption round-trips.
- **E2E tests** load the real built extension in real Chromium against a local fixture server (`e2e/fixtures/server.mjs`) and drive the real popup: detecting files and downloading one, and detecting an HLS stream and rendering its quality picker.
- **Not covered by automated tests**: the final segment-fetch → decrypt → ffmpeg-merge → save pipeline. Exercising it needs genuinely valid media segments as fixtures (ffmpeg refuses to remux fake bytes), which needs `ffmpeg` installed to generate. Verify that path by hand against a real stream, per the checklist below.

MV3 extension testing requires a headed (or `--headless=new`) Chromium — a Chrome/Playwright constraint, not something this project controls. In CI, run under `xvfb-run`.

### Manual check for stream downloads

1. Load the extension unpacked, open a page with a real HLS stream.
2. Click the toolbar icon — the manifest should appear under "Video stream".
3. Click "Choose quality", pick a variant, and watch the progress bar move through fetching → merging → saving.
4. Confirm the resulting `.mp4` in your Downloads folder plays with both video and audio.
5. Repeat with an AES-128 encrypted stream to confirm the output isn't garbled.
