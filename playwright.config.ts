import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// The accessibility check scans the board as the Worker draws it: `npm run preview` runs `wrangler dev --local` on
// port 4822 with a fresh local state folder, serving out/ through the ASSETS binding.
if (!existsSync("out/index.html")) {
  throw new Error("No build found. Run `npm run build` before `npm run test:a11y`.");
}

const baseURL = "http://localhost:4822";

export default defineConfig({
  testDir: "tests/a11y",
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  // The whole suite's wall-clock budget. Every board route is scanned top and bottom on desktop and mobile, plus a
  // horizontal-scroll check on mobile, one test at a time in CI, so it grows with boardRoutes: about 280 tests took
  // 5 minutes in run 6. 12 minutes stays inside the a11y job's 15-minute timeout in .github/workflows/ci.yml.
  globalTimeout: 12 * 60 * 1000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    reducedMotion: "reduce",
  },
  projects: [
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1280, height: 720 } } },
    { name: "mobile", use: { browserName: "chromium", viewport: { width: 375, height: 812 }, hasTouch: true } },
  ],
  webServer: {
    command: "npm run preview",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    // wrangler dev needs a few seconds to start workerd, longer on a cold CI runner.
    timeout: 60_000,
    stderr: "pipe",
  },
});
