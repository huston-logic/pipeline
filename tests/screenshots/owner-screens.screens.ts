// The owner's design-review screens, at a phone and a desktop width, each as a viewport shot and a full-page shot in
// .owner-review/screens/ (git-ignored). Run with `npx playwright test -c playwright.screenshots.config.ts
// tests/screenshots/owner-screens.screens.ts` after `npm run build`. One serial test: the timer step must come last.
import { test } from "@playwright/test";

const OUT = ".owner-review/screens";
const WIDTHS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
];
// Today's to-do rows. The current markup is `ul.cards > li.card`; later markup uses `[data-task-row]`. Both are counted.
const TASK_ROW_SELECTORS = ["main ul.cards > li.card", "[data-task-row]"];

const SCREENS = [
  { name: "today", path: "/" },
  { name: "deals", path: "/pipeline" },
  { name: "people", path: "/contacts" },
  { name: "project", path: "/projects/pj_seed03" },
];

test.describe.configure({ mode: "serial" });

test("owner screens", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  test.setTimeout(120_000);

  const shoot = async (name: string, width: number) => {
    await page.screenshot({ path: `${OUT}/${name}-${width}.png` });
    await page.screenshot({ path: `${OUT}/${name}-${width}-full.png`, fullPage: true });
  };

  for (const size of WIDTHS) {
    await page.setViewportSize(size);
    for (const screen of SCREENS) {
      await page.goto(screen.path, { waitUntil: "networkidle" });
      if (screen.name === "today") {
        for (const selector of TASK_ROW_SELECTORS) {
          const inside = await page.$$eval(
            selector,
            (items, height) => items.filter((item) => item.getBoundingClientRect().bottom <= height).length,
            size.height,
          );
          const total = await page.locator(selector).count();
          console.log(`today ${size.width}x${size.height}: ${inside} of ${total} rows fully in view (${selector})`);
        }
      }
      await shoot(screen.name, size.width);
    }
  }

  // Last: a running timer changes every page. Start one, then shoot its Stop page at both widths.
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^Start timer/ }).first().click();
  await page.waitForLoadState("networkidle");
  for (const size of WIDTHS) {
    await page.setViewportSize(size);
    await page.goto("/timer/stop", { waitUntil: "networkidle" });
    await shoot("timer-stop", size.width);
  }
});
