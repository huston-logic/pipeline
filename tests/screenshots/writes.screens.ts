// The board's write path in a real browser (decisions 0014, 0017): the change banner, a card's Move to disclosure,
// the confirm page for Won, a refused move, and drag and drop with /board.js. Screenshots go to
// .owner-review/screenshots/ like board.screens.ts, and each state gets the same axe scan. The demo seed is shared by
// both projects, so only the desktop drag test writes, and it undoes its own move.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";

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
  // One tall screen, as in board.screens.ts, so the side bar and tab bar sit where a person sees them; then back.
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: viewport.width, height: Math.max(height, viewport.height) });
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await page.screenshot({ path: `${OUT}/${name}-${viewport.width}.png`, fullPage: true });
  await page.setViewportSize(viewport);
}

/** A drag the way a hand does it: press, move a little, move over the target in steps, release. (Locator.dragTo moves
 * too fast for Chrome to start a native drag.) */
async function drag(page: Page, from: Locator, to: Locator) {
  const source = await from.boundingBox();
  const target = await to.boundingBox();
  if (!source || !target) throw new Error("The card or the stage is not on screen.");
  await page.mouse.move(source.x + 40, source.y + 40);
  await page.mouse.down();
  await page.mouse.move(source.x + 60, source.y + 60, { steps: 5 });
  await page.mouse.move(target.x + target.width / 2, target.y + Math.min(target.height / 2, 60), { steps: 10 });
  await page.mouse.up();
}

test("the change banner, with its Undo button", async ({ page }) => {
  // A seeded change by the AI that undo can still reverse (decision 0016).
  await page.goto("/pipeline?change=chg_seed00000012");
  await expect(page.getByRole("status")).toContainText("Added:");
  await expect(page.getByRole("button", { name: "Undo change chg_seed00000012" })).toBeVisible();
  await check(page, "write-banner");
});

test("a card's Move to disclosure opens a labelled select; Won asks first; Cancel goes back", async ({ page }) => {
  await page.goto("/pipeline");
  const summary = page.locator("details.move-details summary").first();
  await summary.click();
  const select = page.locator("details.move-details[open] select");
  await expect(select).toBeVisible();
  await check(page, "write-move-open");
  await select.selectOption("won");
  await page.locator("details.move-details[open] button[type=submit]").click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("as Won?");
  await check(page, "write-confirm");
  await page.getByRole("link", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/\/pipeline$/);
});

test("a refused move shows the reason and the form again", async ({ page }) => {
  await page.goto("/pipeline");
  // The last card: the drag test (running beside this one) moves the first.
  await page.locator("details.move-details summary").last().click();
  // The deal's own stage is selected: moving there changes nothing, so the server refuses.
  await page.locator("details.move-details[open] button[type=submit]").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("The deal wasn't moved");
  await check(page, "write-refused");
});

test("drag a card to the next column: it moves, the banner shows, and Undo puts it back", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Drag and drop is for a mouse; phones use the Move to form.");
  await page.goto("/pipeline");
  const card = page.locator("[data-board] .deal-card").first();
  const dealId = (await card.getAttribute("data-deal")) ?? "";
  const from = (await card.getAttribute("data-stage")) ?? "";
  await expect(card).toHaveAttribute("draggable", "true");
  const stages = await page.locator("[data-board] [data-drop-stage]").evaluateAll((columns) =>
    columns.map((column) => column.getAttribute("data-drop-stage") ?? ""),
  );
  const to = stages[stages.indexOf(from) + 1] ?? "";
  await drag(page, card, page.locator(`[data-board] [data-drop-stage="${to}"]`));
  await expect(page).toHaveURL(/\/pipeline\?change=chg_/);
  await expect(page.locator(`[data-deal="${dealId}"]`)).toHaveAttribute("data-stage", to);
  await check(page, "write-after-drag");
  // The change banner is in the status corner now, not under the heading.
  await page.locator(".corner-notice").getByRole("button", { name: /^Undo/ }).click();
  await expect(page.locator(".corner-notice")).toContainText("Undone");
  // The Undo is in place (decision 0062) and the page refreshes whole, with no reload.
  await expect(page.locator(`[data-deal="${dealId}"]`)).toHaveAttribute("data-stage", from);

  // Dropping on Won goes through the same confirm step as the form.
  await drag(page, page.locator(`[data-deal="${dealId}"]`), page.locator('.closed [data-drop-stage="won"]'));
  await expect(page.getByRole("heading", { level: 1 })).toContainText("as Won?");
});

test("an Undo that would remove records asks first; Cancel goes back", async ({ page }) => {
  // The seeded change that added a task: undoing it would remove the task.
  await page.goto("/changes");
  await page.getByRole("button", { name: "Undo change chg_seed00000012" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Undo this change?");
  await expect(page.locator(".lede")).toContainText("It removes 1 task.");
  await check(page, "write-undo-confirm");
  await page.getByRole("link", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/\/changes$/);
});
