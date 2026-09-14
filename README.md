# Grabber — Media & File Downloader

A browser extension (Chrome, Edge, Firefox) that scans the current page for downloadable media/files (video, audio, images, documents, archives) and lets you pick what to download — like a lightweight IDM.

## Current scope (v0.1)

Detects and downloads **direct files** — anything with a stable URL and a recognizable extension or Content-Type (mp4, webm, mp3, pdf, zip, jpg, etc.).

**Not yet supported:** HLS (`.m3u8`) or DASH (`.mpd`) adaptive streaming — the format most modern video-streaming sites actually use. Those aren't single files; downloading them means fetching and muxing many segments (via ffmpeg.wasm or a native helper app), which is a deliberately separate, larger piece of future work. Pages that only serve video this way will show nothing in the popup for now.

## How a request flows through the system

1. **Content script** (`src/content/`) scans the page's DOM for `<video>`, `<audio>`, `<source>`, and `<a>` elements pointing at recognized file types, and re-scans on DOM changes (for players that load in after the page does). It messages anything it finds to the background service worker.
2. **Background service worker** (`src/background/`) also watches network responses directly (`chrome.webRequest.onHeadersReceived`, read-only), so it catches files the DOM scan might miss (e.g. a direct link click, or a src set via JS without ever appearing as a static attribute). It keeps a list of found items per browser tab, cleared whenever that tab navigates to a new page.
3. **Popup** (`src/popup/` + `popup/popup.html`) is what you see when you click the toolbar icon: it asks the background worker "what has this tab found?", renders the results grouped by category, and turns a "Download" click into a `chrome.downloads.download(...)` call (routed through the background worker).

### Where to add code

Every file in this codebase is either:
- **Pure logic** — takes data, returns data, no `chrome.*` calls, unit-tested. This is `src/shared/*`, `src/background/media-store.ts`, `src/content/scan.ts`, `src/popup/render.ts`. If you're adding a new file-type rule, a new field on a media item, or changing how items get grouped/rendered — it goes here.
- **Browser-API wiring** — the `index.ts` in each of `src/background/`, `src/content/`, `src/popup/`. These connect real `chrome.*` events to the pure functions above and contain no business logic of their own. If you're adding a new event to listen for or a new message type, it goes here (and its shape goes in `src/shared/messages.ts`).

## Development

```sh
npm install
npm run build       # one-shot build -> dist/
npm run watch        # rebuild on save, for iterative dev
npm run typecheck     # tsc --noEmit
npm test               # unit tests (vitest) — shared/, media-store, scan, render
npm run test:e2e        # builds, then runs Playwright against a real extension in real Chromium
```

### Loading the unpacked extension

After `npm run build` (this generates `dist/background.js`, `dist/content-script.js`, `dist/popup.js` — `manifest.json` at the repo root references these):

- **Chrome / Edge**: open `chrome://extensions` (or `edge://extensions`), enable Developer mode, click "Load unpacked", select this repo's root folder.
- **Firefox**: open `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on", select `manifest.json` in this repo's root. (Temporary add-ons are removed when Firefox closes — reload after each restart during development.)

### Running the e2e tests

`npm run test:e2e` builds the extension, starts a small local static server serving `e2e/fixtures/*`, launches a real (headed) Chromium with the extension loaded, opens the fixture page, opens the extension's real popup, and clicks a real Download button — asserting a real file download happens.

MV3 extensions require a headed browser (or Chrome's newer `--headless=new`) to load at all — this is a Chrome/Playwright constraint, not something this project controls. In CI, run it under `xvfb-run` (e.g. `xvfb-run npm run test:e2e` on Linux runners).
