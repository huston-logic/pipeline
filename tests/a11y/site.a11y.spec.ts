import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { boardRoutes, publicRoutes } from "../../src/board/routes.ts";
import { KNOWN_ISSUES } from "./known-issues.ts";

// WCAG 2.0, 2.1 and 2.2 levels A and AA (axe tags are not cumulative), plus axe's best-practice rules
// (one <h1>, landmarks, heading order), which AGENTS.md already requires.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

const NOT_FOUND_PATH = "/this-page-does-not-exist";

const pages = [...boardRoutes, ...publicRoutes, NOT_FOUND_PATH];

type Violation = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"][number];

function isKnown(rule: string, target: string): boolean {
  return KNOWN_ISSUES.some((k) => k.rule === rule && k.selector === target);
}

// Scroll to the bottom (and let two frames pass) before the scrolled scan, so the footer is checked in place too.
async function scrollToBottom(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        window.scrollTo(0, document.documentElement.scrollHeight);
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function scan(page: Page, { scrolled = false } = {}) {
  if (scrolled) await scrollToBottom(page);
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const matched = new Set<number>();
  const violations: Violation[] = [];
  for (const violation of results.violations) {
    const nodes = violation.nodes.filter((node) => {
      const target = node.target.join(" ");
      const index = KNOWN_ISSUES.findIndex((k) => k.rule === violation.id && k.selector === target);
      if (index >= 0) matched.add(index);
      return !isKnown(violation.id, target);
    });
    if (nodes.length > 0) violations.push({ ...violation, nodes });
  }
  return { violations, matched, needsReview: results.incomplete.length };
}

function describeViolations(violations: Violation[]): string {
  return violations
    .map((v) => {
      const nodes = v.nodes.map((n) => `    ${n.target.join(" ")}\n      ${n.html.slice(0, 120)}`).join("\n");
      return `${v.id} (${v.impact}): ${v.help}\n  ${v.helpUrl}\n${nodes}`;
    })
    .join("\n\n");
}

async function expectNoViolations(page: Page, label: string, options?: Parameters<typeof scan>[1]) {
  const { violations, needsReview } = await scan(page, options);
  if (needsReview > 0) console.log(`${label}: ${needsReview} rule(s) need manual review (not failures)`);
  expect(violations, `Accessibility violations on ${label}:\n\n${describeViolations(violations)}\n`).toEqual([]);
}

// Each page is scanned twice: once at the top (every rule) and once scrolled to the bottom.
for (const path of pages) {
  test(`${path} has no accessibility violations (top of page)`, async ({ page }) => {
    const response = await page.goto(path, { waitUntil: "networkidle" });
    expect(response?.status(), `Unexpected HTTP status for ${path}`).toBe(path === NOT_FOUND_PATH ? 404 : 200);
    await expectNoViolations(page, `${path} (top of page)`);
  });

  test(`${path} has no accessibility violations (scrolled to the bottom)`, async ({ page }) => {
    await page.goto(path, { waitUntil: "networkidle" });
    await expectNoViolations(page, `${path} (scrolled to the bottom)`, { scrolled: true });
  });

  // WCAG 1.4.10 Reflow: at phone width the page scrolls only up and down.
  test(`${path} has no horizontal scroll`, async ({ page }) => {
    await page.goto(path, { waitUntil: "networkidle" });
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth, `${path} is wider than the viewport`).toBeLessThanOrEqual(clientWidth);
  });
}

test("known issues are still needed", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Checked once, at desktop width.");
  test.skip(KNOWN_ISSUES.length === 0, "No known issues recorded.");
  const matched = new Set<number>();
  for (const path of pages) {
    await page.goto(path, { waitUntil: "networkidle" });
    (await scan(page)).matched.forEach((i) => matched.add(i));
    (await scan(page, { scrolled: true })).matched.forEach((i) => matched.add(i));
  }
  const stale = KNOWN_ISSUES.filter((_, i) => !matched.has(i)).map((k) => `${k.rule} on ${k.selector}`);
  expect(stale, "These entries in tests/a11y/known-issues.ts no longer match anything. Delete them.").toEqual([]);
});
