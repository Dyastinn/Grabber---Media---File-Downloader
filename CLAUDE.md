# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm install
npm run build          # esbuild -> dist/{background,content-script,popup,offscreen}.js + copies ffmpeg assets to dist/ffmpeg/
npm run watch            # esbuild --watch
npm run typecheck         # tsc --noEmit
npm test                   # vitest run (unit tests only)
npm run test:e2e            # builds, then runs Playwright against the real extension in real Chromium
```

Run a single unit test file: `npx vitest run src/shared/hls-playlist.test.ts`
Run a single e2e test by name: `npx playwright test -g "HLS stream"`

For manual testing, build first, then load this repo's **root folder** (not `dist/`) as unpacked in `chrome://extensions` / `edge://extensions`, or via `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" → select `manifest.json`. `manifest.json` lives at the root and references `dist/*.js`, so both must be loaded together.

## Architecture

Cross-browser (Chrome/Edge/Firefox 109+) Manifest V3 extension, no runtime framework, bundled with esbuild (format `iife`, one bundle per entry point — no ES modules at runtime, so `manifest.json` needs no `"type": "module"`).

**Every file is either pure logic or browser-API wiring — this split is the core convention to preserve:**

- **Pure logic** (no `chrome.*` calls, unit-tested with vitest):
  - `src/shared/media-types.ts` — file/stream classification (`classifyMedia` returns `{category, streamKind?}`)
  - `src/shared/filename.ts` — filename guessing
  - `src/shared/messages.ts` — the discriminated-union `Message` type every context imports
  - `src/shared/hls-playlist.ts` — M3U8 master/media playlist parsing, `EXT-X-KEY` encryption (incl. key rotation), `EXT-X-MAP`, IV derivation
  - `src/shared/dash-manifest.ts` — MPD parsing via `DOMParser`, `SegmentTemplate`/`$Number$` only
  - `src/shared/stream-plan.ts` — turns a parsed manifest + quality choice into a `StreamDownloadPlan`
  - `src/background/media-store.ts`, `src/background/stream-progress-store.ts` — per-tab items, per-stream progress
  - `src/content/scan.ts` — `extractMediaItems(doc, sourceUrl)`, a pure `Document -> MediaItem[]`
  - `src/popup/render.ts` — pure `data -> DOM node` render functions
  - `src/offscreen/decrypt.ts` — AES-128-CBC via Web Crypto
- **Wiring** (one `index.ts` per browser context, no business logic): `src/background/index.ts`, `src/content/index.ts`, `src/popup/index.ts`, `src/offscreen/index.ts`.

New file-type rules, parsing changes, or rendering changes belong in the pure-logic files. A new event to listen for or a new message type belongs in the relevant `index.ts` (and its shape in `shared/messages.ts`).

### Request flow
1. `content/index.ts` scans the DOM on load and on mutation (debounced), sends `MEDIA_FOUND`.
2. `background/index.ts` independently watches network responses (`chrome.webRequest.onHeadersReceived`, read-only/observational, so no MV3 blocking-webRequest restrictions). This is what catches manifests fetched by player JS, which never appear in the DOM. Both sources feed one per-tab `MediaStore`, cleared on top-frame navigation and tab close.
3. `popup/index.ts` asks for the active tab's list, renders it, and either downloads a file directly (`DOWNLOAD`) or, for a stream, fetches + parses the manifest to show a quality picker and then sends `DOWNLOAD_STREAM` with a fully-built plan.
4. `background/index.ts` creates the offscreen document on demand and forwards the plan as `EXECUTE_STREAM_PLAN`.
5. `offscreen/index.ts` executes it: parallel segment fetch → AES-128 decrypt → concatenate → ffmpeg remux/mux → `chrome.downloads.download` of a blob URL.

### Things that will bite you if changed carelessly

- **`DOWNLOAD_STREAM` vs `EXECUTE_STREAM_PLAN` are deliberately separate message types.** `chrome.runtime.sendMessage` broadcasts to every extension context; if the offscreen document listened for the popup's own message, an open offscreen document would start each download twice.
- **ffmpeg's core/wasm/worker files are copied into `dist/ffmpeg/` at build time and loaded via `chrome.runtime.getURL`.** MV3 forbids remote executable code and the extension CSP blocks `@ffmpeg/ffmpeg`'s default blob-URL worker. Never point these at a CDN, even though ffmpeg.wasm's own docs do.
- **The offscreen document exists because ffmpeg.wasm can't run in an MV3 service worker** (no DOM/Worker context). Don't try to move that work into the background worker.
- **The popup and the offscreen document share the same parsers.** Keep manifest parsing in `src/shared/` so the quality list and the actual download can't disagree.
- **A manifest's `Content-Length` is the playlist's size, not the video's**, so stream items intentionally carry no `size`.

### Testing strategy
- **Unit tests (vitest + jsdom)**: every pure-logic file has a co-located `*.test.ts`, including fixture-based HLS/DASH parsing tests (encrypted, key-rotating, fMP4, SegmentTimeline-unsupported) and AES decryption round-trips.
- **E2E (Playwright, `e2e/`)**: loads the real built extension into real headed Chromium (`launchPersistentContext` + `--load-extension`) against `e2e/fixtures/server.mjs`. Covers file detection + a real download, and HLS detection + the quality picker. Two harness quirks worth knowing:
  - Testing an MV3 popup means navigating a tab to `popup/popup.html`, which makes that tab trivially "active" and would break the popup's real `chrome.tabs.query({active: true})`. The `openPopup` helper works around it with a test-only `chrome.tabs.query` shim via `addInitScript` — not a production change.
  - Downloads started by `chrome.downloads.download()` from the service worker don't fire Playwright's page-level `download` event, and Playwright reroutes saved files to its own artifacts dir under generated names. So tests assert via `chrome.downloads.search()` and match on **source URL**, not filename.
- **Not automated**: the segment-fetch → decrypt → ffmpeg-merge → save path. Valid fixture media is needed (ffmpeg won't remux fake bytes) and `ffmpeg` isn't installed on this machine. Verify by hand — see the checklist at the end of README.md.

## Scope limits (surfaced in the UI, not silent failures)

- DRM (`SAMPLE-AES`, Widevine, FairPlay) is refused by design — `parseMediaPlaylist` reports it via `unsupportedEncryption` and `planHlsDownload` turns that into a user-facing reason.
- DASH `SegmentTimeline`/`SegmentList` addressing returns `{supported: false, reason}` from `parseManifest`.
- Audio track selection is automatic (highest bitrate / default rendition); only video quality is user-facing.
- `chrome.offscreen` is Chromium-only, so stream downloads don't run on Firefox (file downloads do).
