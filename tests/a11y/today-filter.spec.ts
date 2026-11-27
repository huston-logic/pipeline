import { expect, test } from "@playwright/test";

// Choosing a sort or filter on Today applies at once (live.js): the list changes without a reload, a half-typed
// to-do stays in its box, and the corner says how many to-dos are now shown.
test("choosing Sort changes the list in place, keeps the typed title and announces the count", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "one project is enough");
  await page.goto("/", { waitUntil: "networkidle" });
  await page.evaluate(() => {
    (window as unknown as { __marker?: number }).__marker = 1;
  });
  await page.locator("#quick-title").fill("Half-typed to-do");
  await page.locator("#todo-show").selectOption("standalone");
  await expect(page.locator(".corner-notice")).toContainText(/^Showing \d+ to-dos?\.$/);
  await expect(page).toHaveURL(/show=standalone/);
  await expect(page.locator("#quick-title")).toHaveValue("Half-typed to-do");
  expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker), "no reload").toBe(1);
  await expect(page.locator("#todo-show")).toBeFocused();
});
