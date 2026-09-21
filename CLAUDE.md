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
  - `src/background/request-headers.ts` — per-origin memory of the request headers pages send (Referer/Origin/Authorization/custom tokens), and the `declarativeNetRequest` rule that replays them
  - `src/background/diagnostics.ts` — `NetworkErrorLog` (last `webRequest.onErrorOccurred` error per URL) and `buildFetchDiagnostic`/`explain`, the human-readable reason for a failed extension fetch
  - `src/content/scan.ts` — `extractMediaItems(doc, sourceUrl)`, a pure `Document -> MediaItem[]`
  - `src/content/fetch-headers.ts` — reads the JS-set headers from `fetch(input, init)` arguments (duck-typed, cross-realm safe)
  - `src/popup/render.ts` — pure `data -> DOM node` render functions
  - `src/offscreen/decrypt.ts` — AES-128-CBC via Web Crypto
- **Wiring** (one `index.ts` per browser context, no business logic): `src/background/index.ts`, `src/content/index.ts`, `src/popup/index.ts`, `src/offscreen/index.ts`, plus `src/content/sniffer.ts` (page MAIN world, `world: "MAIN"` in the manifest — wraps the page's `fetch`/`XMLHttpRequest`, no `chrome.*` access, talks to `content/index.ts` via `window.postMessage`).

New file-type rules, parsing changes, or rendering changes belong in the pure-logic files. A new event to listen for or a new message type belongs in the relevant `index.ts` (and its shape in `shared/messages.ts`).

### Request flow
1. `content/index.ts` scans the DOM on load and on mutation (debounced), sends `MEDIA_FOUND`.
2. `background/index.ts` independently watches network responses (`chrome.webRequest.onHeadersReceived`, read-only/observational, so no MV3 blocking-webRequest restrictions). This is what catches manifests fetched by player JS, which never appear in the DOM — when their URL extension or Content-Type gives them away. It skips segment requests (`isStreamSegment`: `.ts`/`.m4s`, `video/mp2t`) so a playing stream doesn't list as thirty videos.
3. `content/sniffer.ts` catches the rest: private players often serve playlists from extension-less URLs as `text/plain`/`application/octet-stream`, so it looks at the head of every text-ish fetch/XHR response for `#EXTM3U` / `<MPD` (`sniffManifestKind`) and posts hits to the content script, which reports them as stream items. All three sources feed one per-tab `MediaStore`, cleared on top-frame navigation and tab close.
4. `popup/index.ts` asks for the active tab's list, renders it, and either downloads a file directly (`DOWNLOAD`) or, for a stream, fetches + parses the manifest to show a quality picker and then sends `DOWNLOAD_STREAM` with a fully-built plan.
5. `background/index.ts` creates the offscreen document on demand and forwards the plan as `EXECUTE_STREAM_PLAN`.
6. `offscreen/index.ts` executes it: parallel segment fetch → AES-128 decrypt → concatenate → ffmpeg remux/mux → `chrome.downloads.download` of a blob URL.

### Things that will bite you if changed carelessly

- **`DOWNLOAD_STREAM` vs `EXECUTE_STREAM_PLAN` are deliberately separate message types.** `chrome.runtime.sendMessage` broadcasts to every extension context; if the offscreen document listened for the popup's own message, an open offscreen document would start each download twice.
- **ffmpeg's core/wasm/worker files are copied into `dist/ffmpeg/` at build time and loaded via `chrome.runtime.getURL`.** MV3 forbids remote executable code and the extension CSP blocks `@ffmpeg/ffmpeg`'s default blob-URL worker. Never point these at a CDN, even though ffmpeg.wasm's own docs do.
- **The offscreen document exists because ffmpeg.wasm can't run in an MV3 service worker** (no DOM/Worker context). Don't try to move that work into the background worker.
- **The popup and the offscreen document share the same parsers.** Keep manifest parsing in `src/shared/` so the quality list and the actual download can't disagree.
- **A manifest's `Content-Length` is the playlist's size, not the video's**, so stream items intentionally carry no `size`.
- **ffmpeg assets must be the ESM builds** (`@ffmpeg/core/dist/esm`, and the ESM `worker.js` bundled by esbuild). `@ffmpeg/ffmpeg` always spawns a module worker; the UMD worker chunk's `import()` fallback is a webpack stub that fails with "Cannot find module". The manifest CSP needs `'wasm-unsafe-eval'` or the wasm won't instantiate.
- **Extension-page fetches send `credentials: "include"`** (popup manifest fetch, offscreen segment fetch). They are cross-origin to the site, so without it login-gated players 403.
- **Request headers are replayed, not guessed.** `chrome.webRequest.onSendHeaders` (with `extraHeaders`, so Referer/Origin are visible) records every fetch-style request's replayable headers per origin — ALL requests, because the playlist that needs a token is usually the one whose URL says nothing — and a `declarativeNetRequest` session rule per origin sets them on the extension's own requests **only** — `initiatorDomains: [chrome.runtime.id]` (rule id = FNV hash of the origin, so a restarted worker upserts rather than collides). A rule without that scope rewrote the page's own requests with the union of everything it had ever sent to that origin, which broke unrelated sites (e.g. a replayed `X-HTTP-Method-Override` → 405); method-override headers are additionally never replayed, and the e2e `/api/echo-token` route asserts no leak onto page requests. The webRequest observer can miss a page's very first request while the worker is still starting — typically the manifest carrying the token — so the page-world sniffer also captures the JS-set headers of each manifest request (`headersFromFetchArgs`, and a wrapped `XMLHttpRequest.setRequestHeader`) and the content script forwards them as `REQUEST_HEADERS_SEEN`; both sources feed the same `RequestHeaderStore`. `prepareFetch` layers the page-derived Referer/Origin fallback UNDER the recorded headers (the sniffer's view is JS-set headers only, so a fast page load can leave a token without a Referer), and `installHeaderRule` returns the in-flight `updateSessionRules` promise so a fetch never starts before its rule is live. Preflight (`OPTIONS`) requests and `access-control-request-*` headers are never recorded. The sniffer (document_start) queues its messages until the content script (document_idle) posts `SNIFFER_LISTENER_READY`.
- **Fetch failures are diagnosed into the page's console.** `fetch()` in extension pages only ever says "Failed to fetch"; the background worker sees the browser's real reason via `webRequest.onErrorOccurred`. The popup sends `REPORT_FETCH_FAILURE` (and the offscreen document's `STREAM_ERROR` carries `failedUrl`); the background builds a `FetchDiagnostic` (URL, network error, replayed headers, hint) and sends `DIAGNOSTIC` to the tab, whose content script `console.error`s it with a `[Grabber]` prefix — F12 on the site is where users look. The e2e stream page links a manifest on a closed port and asserts that console line (`net::ERR_CONNECTION_REFUSED`). The popup must send `PREPARE_STREAM_FETCH` before fetching a manifest, and `DOWNLOAD_STREAM` carries `sourceUrl` so the background can prepare every origin in the plan (falling back to Referer/Origin derived from the page). The e2e fixture server enforces a Referer on `/stream/*` and an `X-Player-Token` on `/api/stream/playlist`, so the e2e suite fails if replay breaks.
- **`tsconfig.json` excludes `e2e/fixtures`** because the HLS fixture segments are `.ts` files and tsc would try to compile them.
- **A `StreamDownloadPlan` must be JSON-safe.** It crosses `chrome.runtime.sendMessage` (popup → background → offscreen), which serialises a `Uint8Array` into a plain object with no `.buffer`. That is why `PlannedSegment.decryption.iv` is `ivHex` (a string), rebuilt with `hexToBytes` in the offscreen document; `stream-plan.test.ts` asserts a plan survives `JSON.parse(JSON.stringify(plan))`. Symptom when this regresses: "Cannot read properties of undefined (reading 'slice')" on encrypted streams.
- **The offscreen document has no `chrome.downloads`** (only `chrome.runtime`). It sends `SAVE_STREAM_FILE` with a blob URL; the background worker downloads it and replies when the download finishes so the blob can be revoked.
- **`MediaItem.title` and `MediaItem.qualitySources` are optional, scanner-provided metadata**: a title names the saved file instead of the URL's last segment, and `qualitySources` lets one item stand for a host's separate per-quality manifests (the popup's `hls-sources` picker context builds the quality list from it without fetching a master). `MediaItem.childUrls` lists the variant/rendition playlists an HLS master references (the sniffer parses the master body with `parseMasterPlaylist` and reports them). `MediaStore.add` merges re-adds of a URL (newest facts win, but a known title/filename and known `qualitySources`/`childUrls` are never lost) and folds any URL listed in another item's `qualitySources`/`childUrls` into that item, in either arrival order — otherwise every quality the player touches shows as its own "video.m3u8" row. Streams found by the content script (DOM scan or sniffer) are titled after the page: `pageTitle(doc)` prefers `og:title`, else `document.title` minus a short trailing " - Site Name" segment. Plain files are not, since a page can link to many.

### Testing strategy
- **Unit tests (vitest + jsdom)**: every pure-logic file has a co-located `*.test.ts`, including fixture-based HLS/DASH parsing tests (encrypted, key-rotating, fMP4, SegmentTimeline-unsupported) and AES decryption round-trips.
- **E2E (Playwright, `e2e/`)**: loads the real built extension into real headed Chromium (`launchPersistentContext` + `--load-extension`) against `e2e/fixtures/server.mjs`. Covers file detection + a real download, HLS detection + the quality picker, and a "private player" page (`sniff-page.html` + the server's `/api/stream/playlist` route: extension-less URL, `text/plain`) proving the sniffer finds the playlist and segments stay hidden. Two harness quirks worth knowing:
  - Testing an MV3 popup means navigating a tab to `popup/popup.html`, which makes that tab trivially "active" and would break the popup's real `chrome.tabs.query({active: true})`. The `openPopup` helper works around it with a test-only `chrome.tabs.query` shim via `addInitScript` — not a production change.
  - Downloads started by `chrome.downloads.download()` from the service worker don't fire Playwright's page-level `download` event, and Playwright reroutes saved files to its own artifacts dir under generated names. So tests assert via `chrome.downloads.search()` and match on **source URL**, not filename.
- **Not automated**: the segment-fetch → decrypt → ffmpeg-merge → save path. Valid fixture media is needed (ffmpeg won't remux fake bytes) and `ffmpeg` isn't installed on this machine. Verify by hand — see the checklist at the end of README.md. When debugging it, `e2e/helpers.ts` collects console output from extension pages (popup, offscreen) and the background service worker into `extension.logs` — the offscreen document is otherwise invisible.

## Scope limits (surfaced in the UI, not silent failures)

- DRM (`SAMPLE-AES`, Widevine, FairPlay) is refused by design — `parseMediaPlaylist` reports it via `unsupportedEncryption` and `planHlsDownload` turns that into a user-facing reason.
- DASH `SegmentTimeline`/`SegmentList` addressing returns `{supported: false, reason}` from `parseManifest`.
- Audio track selection is automatic (highest bitrate / default rendition); only video quality is user-facing.
- `chrome.offscreen` is Chromium-only, so stream downloads don't run on Firefox (file downloads do).
