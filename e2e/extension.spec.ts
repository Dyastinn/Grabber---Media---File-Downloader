// End-to-end tests: load the REAL built extension into a REAL Chromium
// instance and drive it like a user would. This is what proves the wiring
// files (background/index.ts, content/index.ts, popup/index.ts) actually work
// together — unit tests only cover the pure logic they call into.
//
// MV3 extensions need a headed (or Chrome's newer --headless=new) browser to
// load; these run headed by default. In CI, wrap with xvfb-run (see README).
import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXTENSION_PATH = process.cwd(); // manifest.json lives at the repo root and points at dist/
const FILE_PAGE_URL = "http://localhost:8765/video-page.html";
const STREAM_PAGE_URL = "http://localhost:8765/stream-page.html";

interface LoadedExtension {
  context: BrowserContext;
  extensionId: string;
  dispose: () => Promise<void>;
}

async function launchWithExtension(): Promise<LoadedExtension> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "grabber-e2e-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });

  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent("serviceworker");

  return {
    context,
    extensionId: new URL(worker.url()).host,
    dispose: async () => {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Opens the extension's real popup page, pointed at the given fixture tab.
 *
 * The popup asks for the ACTIVE tab, which is correct for a real
 * toolbar-opened popup — but in this harness the popup is itself a tab, so it
 * would find itself instead of the page under test. This test-only shim makes
 * chrome.tabs.query resolve to the fixture tab; production code in
 * src/popup/index.ts is untouched.
 */
async function openPopup(
  { context, extensionId }: LoadedExtension,
  fixtureUrl: string
): Promise<Page> {
  const popup = await context.newPage();
  await popup.addInitScript((url: string) => {
    const originalQuery = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = ((_options: unknown) =>
      originalQuery({ url })) as typeof chrome.tabs.query;
  }, fixtureUrl);
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  return popup;
}

test("detects files on a page and downloads one via the popup", async () => {
  const extension = await launchWithExtension();

  try {
    const page = await extension.context.newPage();
    await page.goto(FILE_PAGE_URL);
    // Give the content script's scan + the network watcher's header parsing a
    // moment to run and message the background worker.
    await page.waitForTimeout(1000);

    const popup = await openPopup(extension, FILE_PAGE_URL);

    await expect(popup.locator(".media-row")).toHaveCount(4, { timeout: 10_000 });

    const headings = await popup.locator("h2").allTextContents();
    expect(headings.join(" ")).toMatch(/Video/);
    expect(headings.join(" ")).toMatch(/Audio/);
    expect(headings.join(" ")).toMatch(/Document/);
    expect(headings.join(" ")).toMatch(/Archive/);

    // Downloads triggered via chrome.downloads.download() (from the background
    // service worker, not a page navigation) aren't surfaced by Playwright's
    // page-level "download" event, so we verify through the real
    // chrome.downloads API instead. Match by source URL rather than saved
    // filename: Playwright's download interception reroutes the saved file to
    // its own artifacts directory under a generated name.
    await popup.locator(".media-row", { hasText: "sample.mp4" }).getByRole("button").click();

    let matched: chrome.downloads.DownloadItem | undefined;
    await expect
      .poll(
        async () => {
          const downloads = await popup.evaluate(
            () =>
              new Promise<chrome.downloads.DownloadItem[]>((resolve) =>
                chrome.downloads.search({}, resolve)
              )
          );
          matched = downloads.find((d) => d.url.endsWith("/sample.mp4"));
          return matched?.state;
        },
        { timeout: 10_000 }
      )
      .toBe("complete");

    expect(matched?.mime).toBe("video/mp4");
  } finally {
    await extension.dispose();
  }
});

test("detects an HLS stream and offers its qualities in the popup", async () => {
  const extension = await launchWithExtension();

  try {
    const page = await extension.context.newPage();
    await page.goto(STREAM_PAGE_URL);
    await page.waitForTimeout(1000);

    const popup = await openPopup(extension, STREAM_PAGE_URL);

    // The manifest is a stream, not a file: it lands in its own group and
    // offers a quality choice instead of an immediate download.
    const streamRow = popup.locator(".media-row", { hasText: "master.m3u8" });
    await expect(streamRow).toHaveCount(1, { timeout: 10_000 });
    expect((await popup.locator("h2").allTextContents()).join(" ")).toMatch(/Video stream/);

    await streamRow.getByRole("button", { name: "Choose quality" }).click();

    // The popup fetches and parses the real master playlist off the fixture
    // server, so both variants should appear, highest quality first.
    const options = streamRow.locator(".quality-option");
    await expect(options).toHaveCount(2, { timeout: 10_000 });
    await expect(options.nth(0).locator(".quality-label")).toHaveText("720p");
    await expect(options.nth(1).locator(".quality-label")).toHaveText("360p");
  } finally {
    await extension.dispose();
  }
});
