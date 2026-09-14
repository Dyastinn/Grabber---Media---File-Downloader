// Shared harness for the e2e specs: launch real Chromium with the real built
// extension, and open the extension's real popup pointed at a given tab.
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXTENSION_PATH = process.cwd(); // manifest.json lives at the repo root and points at dist/

export interface LoadedExtension {
  context: BrowserContext;
  extensionId: string;
  /**
   * Console output and uncaught errors from every extension page (popup,
   * offscreen document), oldest first. The offscreen document is invisible
   * to a user and to the popup's error row, so this is the only place a
   * failure inside the stream pipeline shows up with any detail.
   */
  logs: string[];
  dispose: () => Promise<void>;
}

export async function launchWithExtension(): Promise<LoadedExtension> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "grabber-e2e-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });

  const logs: string[] = [];
  context.on("page", (page) => {
    const label = (): string => new URL(page.url()).pathname;
    page.on("console", (message) => {
      if (page.url().startsWith("chrome-extension://")) {
        logs.push(`[${message.type()}] ${label()}: ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => {
      if (page.url().startsWith("chrome-extension://")) logs.push(`[pageerror] ${label()}: ${error.message}`);
    });
  });

  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent("serviceworker");

  return {
    context,
    extensionId: new URL(worker.url()).host,
    logs,
    dispose: async () => {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Opens the extension's real popup page, pointed at the given tab URL.
 *
 * The popup asks for the ACTIVE tab, which is correct for a real
 * toolbar-opened popup — but in this harness the popup is itself a tab, so it
 * would find itself instead of the page under test. This test-only shim makes
 * chrome.tabs.query resolve to that tab; production code in
 * src/popup/index.ts is untouched.
 */
export async function openPopup(
  { context, extensionId }: LoadedExtension,
  pageUrl: string
): Promise<Page> {
  const popup = await context.newPage();
  await popup.addInitScript((url: string) => {
    const originalQuery = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = ((_options: unknown) =>
      originalQuery({ url })) as typeof chrome.tabs.query;
  }, pageUrl);
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  return popup;
}

/**
 * Downloads started by chrome.downloads.download() (from the service worker,
 * not a page navigation) aren't surfaced by Playwright's page-level
 * "download" event, so specs check the real chrome.downloads API instead.
 */
export async function searchDownloads(popup: Page): Promise<chrome.downloads.DownloadItem[]> {
  return popup.evaluate(
    () =>
      new Promise<chrome.downloads.DownloadItem[]>((resolve) =>
        chrome.downloads.search({}, resolve)
      )
  );
}
