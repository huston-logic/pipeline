// The board's editing forms in a real browser (decision 0018): the open Add a task, Log and Snooze forms, and the
// refused states (an error summary with the values kept). Nothing here writes: every post is one the server refuses.
// Screenshots go to .owner-review/screenshots/ and each state gets the same axe scan as board.screens.ts.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const OUT = ".owner-review/screenshots";

async function check(page: Page, name: string) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${name} is wider than the viewport`).toBeLessThanOrEqual(clientWidth);
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const found = results.violations.map((v) => `${v.id}: ${v.help}\n${v.nodes.map((n) => `    ${n.target.join(" ")}`).join("\n")}`);
  expect(found, `Accessibility violations on ${name}`).toEqual([]);
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: viewport.width, height: Math.max(height, viewport.height) });
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await page.screenshot({ path: `${OUT}/${name}-${viewport.width}.png`, fullPage: true });
  await page.setViewportSize(viewport);
}

test("the deal page with Add a task, Log and a task's Snooze open", async ({ page }) => {
  await page.goto("/deals/dl_seed01");
  await page.getByText("Add a task", { exact: true }).click();
  await page.getByText("Log a call, email or note", { exact: true }).click();
  const snooze = page.locator("details.task-snooze summary").first();
  if ((await snooze.count()) > 0) await snooze.click();
  await expect(page.locator('form[action="/deals/dl_seed01/tasks"] input[name="title"]')).toBeVisible();
  await check(page, "edit-deal-forms");
});

test("a refused New lead: the error summary, each field's message and the values kept", async ({ page }) => {
  await page.goto("/leads/new?from=pipeline");
  await check(page, "edit-lead-new");
  await page.getByLabel("Name (required)").fill("Lee Example");
  await page.getByLabel("Email").fill("lee@example.com");
  await page.getByLabel("Value").fill("about 2k");
  await page.getByRole("button", { name: "Add the lead" }).click();
  await expect(page.getByRole("alert")).toContainText("Give a number of 0 or more");
  await expect(page.getByLabel("Email")).toHaveValue("lee@example.com");
  await check(page, "edit-lead-error");
});

test("Edit contact with outside values, and saving it unchanged is refused", async ({ page }) => {
  await page.goto("/contacts/ct_seed02/edit");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("alert")).toContainText("Nothing to save");
  await check(page, "edit-contact-error");
});

test("a refused log: Nothing was logged, with the form again", async ({ page }) => {
  await page.goto("/deals/dl_seed01");
  await page.getByText("Log a call, email or note", { exact: true }).click();
  await page.getByRole("button", { name: "Log it" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nothing was logged");
  await check(page, "edit-log-error");
});
