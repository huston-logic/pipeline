import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// `npm run screenshots`: every board route at phone and desktop width, saved for the owner to look at, plus an axe
// scan with the accessibility check's tags (decision 0015). It drives the installed Google Chrome (channel "chrome"),
// so it needs no Playwright browser download. CI does not run it; `npm run test:a11y` (playwright.config.ts) is the
// required check.
if (!existsSync("out/index.html")) {
  throw new Error("No build found. Run `npm run build` before `npm run screenshots`.");
}

const baseURL = "http://localhost:4822";

export default defineConfig({
  testDir: "tests/screenshots",
  testMatch: "*.screens.ts",
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results/screenshots",
  globalTimeout: 5 * 60 * 1000,
  use: {
    baseURL,
    channel: "chrome",
    reducedMotion: "reduce",
  },
  projects: [
    { name: "phone", use: { viewport: { width: 375, height: 812 }, hasTouch: true } },
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: "npm run preview",
    url: baseURL,
    reuseExistingServer: true,
    timeout: 60_000,
    stderr: "pipe",
  },
});
