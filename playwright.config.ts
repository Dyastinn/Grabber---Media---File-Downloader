import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  fullyParallel: false, // one shared extension/browser context; parallel test files would race on it
  reporter: "list",
  webServer: {
    command: "node e2e/fixtures/server.mjs",
    url: "http://localhost:8765/video-page.html",
    reuseExistingServer: !process.env["CI"],
  },
});
