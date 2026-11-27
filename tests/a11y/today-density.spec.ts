import { expect, test } from "@playwright/test";

// Today is the owner's daily screen (run 12): it must be dense. With the demo seed, at least 12 rows are fully in view
// on a laptop and 6 on a phone, without scrolling. On a phone the fixed tab bar covers the bottom of the window, so a
// row under it does not count. Run in the desktop project only: each describe sets its own window size.
const SIZES = [
  { label: "a laptop", width: 1440, height: 900, rows: 12, touch: false },
  { label: "a phone", width: 390, height: 844, rows: 6, touch: true },
];

for (const size of SIZES) {
  test.describe(`Today on ${size.label} (${size.width} x ${size.height})`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, hasTouch: size.touch });

    test(`the first ${size.rows} rows are fully in view`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "the sizes are set here, so one project is enough");
      await page.goto("/", { waitUntil: "networkidle" });
      const inView = await page.$$eval("[data-task-row]", (rows) => {
        const nav = document.querySelector(".app-nav");
        const covered = nav !== null && getComputedStyle(nav).position === "fixed" ? nav.getBoundingClientRect().top : innerHeight;
        const floor = Math.min(innerHeight, covered);
        return rows.filter((row) => {
          const box = row.getBoundingClientRect();
          return row.checkVisibility() && box.height > 0 && box.top >= 0 && box.bottom <= floor;
        }).length;
      });
      expect(inView, `rows fully in view at ${size.width} x ${size.height}`).toBeGreaterThanOrEqual(size.rows);
    });
  });
}
