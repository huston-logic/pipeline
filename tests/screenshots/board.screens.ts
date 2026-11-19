// Screenshots of every board route for the owner (.owner-review/screenshots/<name>-<width>.png, git-ignored), and an
// axe scan of each with the same tags as tests/a11y/site.a11y.spec.ts. Run with `npm run screenshots` after
// `npm run build`. Outside tests/a11y on purpose: CI's a11y job runs that folder only.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { boardRoutes } from "../../src/board/routes.ts";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const OUT = ".owner-review/screenshots";
const NOT_FOUND_PATH = "/this-page-does-not-exist";

const nameOf = (path: string) =>
  path === "/" ? "today" : path === NOT_FOUND_PATH ? "not-found" : path.slice(1).replaceAll("/", "-");

for (const path of [...boardRoutes, NOT_FOUND_PATH]) {
  test(`${path}: screenshot, no axe violations, no horizontal scroll`, async ({ page }) => {
    const response = await page.goto(path, { waitUntil: "networkidle" });
    expect(response?.status(), `HTTP status for ${path}`).toBe(path === NOT_FOUND_PATH ? 404 : 200);

    const viewport = page.viewportSize() ?? { width: 0, height: 0 };

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth, `${path} is wider than the viewport`).toBeLessThanOrEqual(clientWidth);

    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    const found = results.violations.map(
      (v) => `${v.id} (${v.impact}): ${v.help}\n${v.nodes.map((n) => `    ${n.target.join(" ")}`).join("\n")}`,
    );
    expect(found, `Accessibility violations on ${path} at ${viewport.width}px`).toEqual([]);

    // The whole page as one tall screen, so the fixed tab bar and the sticky side bar sit where a person sees them
    // (a stitched full-page capture leaves the tab bar in the middle of the page).
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: viewport.width, height: Math.max(height, viewport.height) });
    await page.screenshot({ path: `${OUT}/${nameOf(path)}-${viewport.width}.png`, fullPage: true });
  });
}
