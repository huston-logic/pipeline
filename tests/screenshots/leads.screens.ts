// Lead pages in a real browser (decision 0028): Add a lead (and its refused state), a lead's page with the status
// menu, Qualify, and the Back to leads confirm page. The demo seed has no leads yet (task L8), so each project adds its
// own through Add a lead and undoes it at the end. Screenshots go to .owner-review/screenshots/ with the same axe scan
// as board.screens.ts.
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

test("Add a lead, a lead's page, Qualify, then Undo", async ({ page }, testInfo) => {
  // Each project (phone, desktop) adds its own lead, so the two runs never touch the same person.
  const name = `Lee Example ${testInfo.project.name}`;
  await page.goto("/leads/new?from=leads");
  await check(page, "lead-new");
  await page.getByRole("button", { name: "Add the lead" }).click();
  await expect(page.getByRole("alert")).toContainText("Give a name or a business");
  await check(page, "lead-new-error");

  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Business").fill(`Example Signs ${testInfo.project.name}`);
  await page.getByLabel("Phone").fill("555-0123");
  await page.getByRole("button", { name: "Add the lead" }).click();
  await expect(page.getByRole("status")).toContainText(`Added lead ${name} (New)`);
  await expect(page.getByText("Lead status: New, since")).toBeVisible();
  await check(page, "lead-page");

  const withBanner = page.url();
  await page.getByRole("link", { name: "Qualify", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Qualify ${name}`);
  await expect(page.getByLabel("Create a deal")).toBeChecked();
  await check(page, "lead-qualify");

  // Undo the lead from its banner (it removes a person, so it asks first).
  await page.goto(withBanner);
  await page.getByRole("status").getByRole("button", { name: /^Undo/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Undo this change?");
  await page.getByRole("button", { name: "Undo the change" }).click();
  await expect(page.getByRole("status")).toContainText("Undone");
});

test("Back to leads on a deal asks first; Keep the deal goes back", async ({ page }) => {
  await page.goto("/deals/dl_seed01");
  await page.getByRole("button", { name: "Back to leads" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Move back to leads?");
  await expect(page.getByLabel("Lead status")).toHaveValue("contacted");
  await check(page, "lead-return-confirm");
  await page.getByRole("link", { name: "Keep the deal" }).click();
  await expect(page).toHaveURL(/\/deals\/dl_seed01$/);
});

test("Add a deal for a new person", async ({ page }) => {
  await page.goto("/deals/new?from=pipeline");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add a deal");
  await check(page, "deal-new-person");
});
