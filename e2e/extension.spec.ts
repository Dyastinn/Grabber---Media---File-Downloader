// End-to-end tests: load the REAL built extension into a REAL Chromium
// instance and drive it like a user would. This is what proves the wiring
// files (background/index.ts, content/index.ts, popup/index.ts) actually work
// together — unit tests only cover the pure logic they call into.
//
// MV3 extensions need a headed (or Chrome's newer --headless=new) browser to
// load; these run headed by default. In CI, wrap with xvfb-run (see README).
import { test, expect } from "@playwright/test";
import { launchWithExtension, openPopup, searchDownloads } from "./helpers";

const FILE_PAGE_URL = "http://localhost:8765/video-page.html";
const STREAM_PAGE_URL = "http://localhost:8765/stream-page.html";
const SNIFF_PAGE_URL = "http://localhost:8765/sniff-page.html";

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

    // Match by source URL rather than saved filename: Playwright's download
    // interception reroutes the saved file to its own artifacts directory
    // under a generated name.
    await popup.locator(".media-row", { hasText: "sample.mp4" }).getByRole("button").click();

    let matched: chrome.downloads.DownloadItem | undefined;
    await expect
      .poll(
        async () => {
          const downloads = await searchDownloads(popup);
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
    // Named after the page title, not the manifest's generic "master.m3u8".
    // (Both manifests on the page get that name; pick by URL.)
    const streamRow = popup.locator(`.media-row[data-url="http://localhost:8765/stream/master.m3u8"]`);
    await expect(streamRow).toHaveCount(1, { timeout: 10_000 });
    await expect(streamRow.locator(".media-filename")).toHaveText("Fixture stream page.m3u8");
    expect((await popup.locator("h2").allTextContents()).join(" ")).toMatch(/Video stream/);

    await streamRow.getByRole("button", { name: "Choose quality" }).click();

    // The popup fetches and parses the real master playlist off the fixture
    // server, so both variants should appear, highest quality first.
    const options = streamRow.locator(".quality-option");
    await expect(options).toHaveCount(2, { timeout: 10_000 });
    await expect(options.nth(0).locator(".quality-label")).toHaveText("720p");
    await expect(options.nth(1).locator(".quality-label")).toHaveText("360p");

    // A manifest the popup can't fetch: the row explains, and — because the
    // popup's own console vanishes with it — the reason, including the
    // browser's real network error, is logged into the PAGE's console.
    const pageErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });
    const deadRow = popup.locator(`.media-row[data-url="http://localhost:8766/dead.m3u8"]`);
    await deadRow.getByRole("button", { name: "Choose quality" }).click();
    await expect(deadRow.locator(".row-notice")).toHaveText(/Couldn't reach localhost:8766/, { timeout: 10_000 });
    await expect
      .poll(() => pageErrors.find((text) => text.includes("[Grabber]")), { timeout: 10_000 })
      .toMatch(/localhost:8766.*net::ERR_CONNECTION_REFUSED.*isn't reachable/s);
  } finally {
    await extension.dispose();
  }
});

test("recognises a playlist served from an extension-less text/plain URL, and hides its segments", async () => {
  const extension = await launchWithExtension();

  try {
    const page = await extension.context.newPage();
    await page.goto(SNIFF_PAGE_URL);
    await expect(page.locator("body")).toHaveAttribute("data-playlist-loaded", "yes");
    await page.waitForTimeout(1000);

    const popup = await openPopup(extension, SNIFF_PAGE_URL);

    // Nothing about "/api/stream/playlist?video=42" or "text/plain" says
    // "HLS"; only the page-world sniffer's look at the body does. The row is
    // named after the page (site suffix stripped), not "playlist".
    const streamRow = popup.locator(".media-row", { hasText: "Fixture private-player page.m3u8" });
    await expect(streamRow).toHaveCount(1, { timeout: 10_000 });
    await expect(streamRow.getByRole("button", { name: "Choose quality" })).toBeVisible();

    // The variant playlist the player fetched is part of that stream, not a second row.
    await expect(popup.locator(".media-row")).toHaveCount(1);

    // The player's two .ts segment requests must not appear as "Video" rows.
    await expect(popup.locator(".media-row", { hasText: ".ts" })).toHaveCount(0);
    expect((await popup.locator("h2").allTextContents()).join(" ")).not.toMatch(/Video \(/);

    // And the sniffed URL is a real, parseable manifest: the picker works —
    // which needs the extension's fetch to replay the page's X-Player-Token.
    await streamRow.getByRole("button", { name: "Choose quality" }).click();
    await expect(streamRow.locator(".quality-option")).toHaveCount(2, { timeout: 10_000 });

    // That replay must be confined to the extension's own requests: the page's
    // requests to other endpoints on the same origin must not grow the token.
    // (Regression: a rule that modified page requests too broke unrelated sites.)
    const leaked = await page.evaluate(() => (window as unknown as { echoToken: () => Promise<string | null> }).echoToken());
    expect(leaked).toBeNull();
  } finally {
    await extension.dispose();
  }
});
