# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm install
npm run build          # esbuild -> dist/background.js, dist/content-script.js, dist/popup.js
npm run watch            # esbuild --watch, for iterative dev
npm run typecheck         # tsc --noEmit
npm test                   # vitest run (unit tests only)
npm run test:watch          # vitest, watch mode
npm run test:e2e             # builds, then runs Playwright against the real extension in real Chromium
```

Run a single unit test file: `npx vitest run src/shared/media-types.test.ts`
Run a single e2e test by name: `npx playwright test -g "detects media"`

Loading the unpacked extension for manual testing: build first, then load this repo's **root folder** (not `dist/`) as unpacked in `chrome://extensions` / `edge://extensions`, or via `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" → select `manifest.json`. `manifest.json` lives at the root and references `dist/*.js`, so both must be loaded together.

## Architecture

Cross-browser (Chrome/Edge/Firefox 109+) Manifest V3 extension, no runtime framework, bundled with esbuild (format `iife`, one bundle per entry point — no ES modules at runtime, so `manifest.json` needs no `"type": "module"`).

**Every file is either pure logic or browser-API wiring — this split is the core convention to preserve:**
- **Pure logic** (no `chrome.*` calls, unit-tested with vitest): `src/shared/media-types.ts` (file-type classification), `src/shared/filename.ts` (filename guessing), `src/shared/messages.ts` (the discriminated-union `Message` type every context imports — one definition, no drift), `src/background/media-store.ts` (the `MediaStore` class — single owner of the per-tab `Map<url, MediaItem>`), `src/content/scan.ts` (`extractMediaItems(doc, sourceUrl)` — DOM scanning as a pure `Document -> MediaItem[]` function), `src/popup/render.ts` (pure `data -> DOM node` render functions).
- **Wiring** (one `index.ts` per browser context, no business logic — just connects real events to the pure functions above): `src/background/index.ts`, `src/content/index.ts`, `src/popup/index.ts`.

New file-type rules, new `MediaItem` fields, or rendering/grouping changes belong in the pure-logic files. A new event to listen for or a new message type belongs in the relevant `index.ts` (and its shape in `shared/messages.ts`).

### Request flow
1. `content/index.ts` scans the DOM on load and on mutation (debounced), sends found items to the background worker as a `MEDIA_FOUND` message.
2. `background/index.ts` also independently watches network responses (`chrome.webRequest.onHeadersReceived`, read-only/observational — no MV3 blocking-webRequest restrictions apply since nothing is modified), classifying by Content-Type/Content-Disposition. Both sources feed the same per-tab `MediaStore`, cleared on top-frame navigation (`webNavigation.onCommitted`) and tab close.
3. `popup/index.ts` asks the background worker for the active tab's list (`GET_MEDIA`), renders it via `render.ts`, and turns a Download click into a `DOWNLOAD` message that triggers `chrome.downloads.download`.

### Testing strategy
- **Unit tests (vitest + jsdom)**: every pure-logic file listed above has a co-located `*.test.ts`. Fast, no browser needed.
- **E2E tests (Playwright, `e2e/`)**: loads the real built extension into real headed Chromium (`chromium.launchPersistentContext` with `--load-extension`) against a small local fixture server (`e2e/fixtures/server.mjs`), and drives the real popup — this is what actually exercises the wiring files. Note: testing an MV3 popup by navigating a tab directly to `popup/popup.html` means that tab is trivially "active," which would break the popup's real `chrome.tabs.query({active: true})` call — the test works around this with a test-only `chrome.tabs.query` monkeypatch via `page.addInitScript` (see `e2e/extension.spec.ts`), not a change to production code.

## Scope note

v0.1 handles direct-file URLs only. HLS (`.m3u8`) / DASH (`.mpd`) adaptive streaming is explicitly out of scope for now (`isStreamingManifest()` in `shared/media-types.ts` filters these out) — supporting it needs segment fetching + muxing (ffmpeg.wasm or a native helper app), deferred to a future phase.
