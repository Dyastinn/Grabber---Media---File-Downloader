// End-to-end test: loads the REAL built extension into a REAL Chromium
// instance and drives it like a user would. This is what proves the wiring
// files (background/index.ts, content/index.ts, popup/index.ts) actually
// work together — unit tests only cover the pure logic they call into.
//
// MV3 extensions need a headed (or Chrome's newer --headless=new) browser to
// load; this test runs headed by default; in CI, wrap it with xvfb-run
// (see README).
import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXTENSION_PATH = process.cwd(); // manifest.json lives at the repo root and points at dist/
const FIXTURE_URL = "http://localhost:8765/video-page.html";

test("detects media on a page and downloads a file via the popup", async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "grabber-e2e-"));

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });

  try {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;

    const fixturePage = await context.newPage();
    await fixturePage.goto(FIXTURE_URL);
    // Give the content script's scan + the network watcher's header parsing
    // a moment to run and message the background worker.
    await fixturePage.waitForTimeout(1000);

    const popupPage = await context.newPage();
    // The real popup asks for the ACTIVE tab, which is correct for a real
    // toolbar-opened popup — but here the popup is itself a tab, so it would
    // be "active" instead of the fixture page. This test-only shim makes
    // chrome.tabs.query resolve to the fixture tab instead; production code
    // in src/popup/index.ts is untouched.
    await popupPage.addInitScript((fixtureUrl: string) => {
      const originalQuery = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = ((_options: unknown) =>
        originalQuery({ url: fixtureUrl })) as typeof chrome.tabs.query;
    }, FIXTURE_URL);

    await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);

    await expect(popupPage.locator(".media-row")).toHaveCount(4, { timeout: 10_000 });

    const headings = await popupPage.locator("h2").allTextContents();
    expect(headings.join(" ")).toMatch(/Video/);
    expect(headings.join(" ")).toMatch(/Audio/);
    expect(headings.join(" ")).toMatch(/Document/);
    expect(headings.join(" ")).toMatch(/Archive/);

    // Downloads triggered via chrome.downloads.download() (called from the
    // background service worker, not from a page navigation/click) aren't
    // surfaced by Playwright's page-level "download" event, so we verify
    // through the real chrome.downloads API instead — still a real download,
    // just observed the way the extension itself would observe it. Match by
    // source URL rather than saved filename: Playwright's own download
    // interception reroutes the actual saved file to its own artifacts
    // directory under a generated name, so `filename` won't be "sample.mp4".
    const videoRow = popupPage.locator(".media-row", { hasText: "sample.mp4" });
    await videoRow.getByRole("button", { name: "Download" }).click();

    let matchedDownload: chrome.downloads.DownloadItem | undefined;
    await expect
      .poll(
        async () => {
          const downloads = await popupPage.evaluate(
            () => new Promise<chrome.downloads.DownloadItem[]>((resolve) => chrome.downloads.search({}, resolve))
          );
          matchedDownload = downloads.find((d) => d.url.endsWith("/sample.mp4"));
          return matchedDownload?.state;
        },
        { timeout: 10_000 }
      )
      .toBe("complete");

    expect(matchedDownload?.mime).toBe("video/mp4");
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
