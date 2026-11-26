import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// One-tap actions happen in place (run 12, decision 0062): with scripts on, Done, Start timer, Stop and Undo never
// reload the page; with scripts off each is a plain form post that lands on the same page. Each test puts back what
// it changed (Undo after Done, a discarded timer).
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

const notice = (page: Page) => page.locator(".corner-notice");
const chip = (page: Page) => page.locator(".corner-chip");
const press = (page: Page, name: RegExp) => page.getByRole("button", { name }).first();
const mark = (page: Page) => page.evaluate(() => (window as unknown as { __marker?: number }).__marker);

async function expectClean(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), label).toEqual([]);
}

// A timer an earlier, interrupted run left on a reused local database would hide every Start timer button.
async function discardStrayTimer(page: Page) {
  await page.goto("/", { waitUntil: "networkidle" });
  if ((await chip(page).count()) === 0) return;
  await chip(page).getByRole("button", { name: /^Undo/ }).click();
  const confirm = page.getByRole("button", { name: "Discard timer" });
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await page.goto("/", { waitUntil: "networkidle" });
}

test.describe.serial("with scripts on", () => {
  test("Done, Start timer, Stop and Undo change the page in place", async ({ page }) => {
    await discardStrayTimer(page);
    await page.evaluate(() => {
      (window as unknown as { __marker?: number }).__marker = 1;
    });
    const inPlace = async () => {
      expect(await mark(page), "the page was not reloaded").toBe(1);
      expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(1);
    };

    await press(page, /^Done/).click();
    await expect(notice(page)).toContainText("Done");
    await inPlace();
    await notice(page).getByRole("button", { name: /^Undo/ }).click();
    await expect(notice(page)).toContainText("Undone");
    await inPlace();

    await press(page, /^Start timer/).click();
    await expect(chip(page)).toBeVisible();
    await inPlace();
    await expectClean(page, "timer running");

    await chip(page).getByRole("button", { name: /^Stop/ }).click();
    await expect(notice(page)).toContainText("Time logged");
    await inPlace();
    await expectClean(page, "time logged");

    await notice(page).getByRole("button", { name: /^Undo/ }).click();
    await expect(chip(page)).toBeVisible();
    await chip(page).getByRole("button", { name: /^Undo/ }).click();
    await expect(chip(page)).toHaveCount(0);
    await inPlace();
  });
});

test.describe.serial("with scripts off", () => {
  test.use({ javaScriptEnabled: false });

  test("each action is a plain form post that lands back on the same page", async ({ page }) => {
    await page.goto("/");
    await press(page, /^Done/).click();
    await expect(page).toHaveURL(/\/\?change=chg_/);
    await expect(notice(page)).toContainText("Done");
    await notice(page).getByRole("button", { name: /^Undo/ }).click();
    await expect(notice(page)).toContainText("Undone");

    await press(page, /^Start timer/).click();
    await expect(chip(page)).toContainText("since");
    await chip(page).getByRole("button", { name: /^Stop/ }).click();
    await expect(notice(page)).toContainText("Time logged");
    await notice(page).getByRole("button", { name: /^Undo/ }).click();
    await expect(chip(page)).toBeVisible();
    await chip(page).getByRole("button", { name: /^Undo/ }).click();
    await expect(chip(page)).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/");
  });
});
