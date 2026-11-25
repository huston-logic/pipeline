import assert from "node:assert/strict";
import { test } from "node:test";
import { devEnv, load } from "../../tests/helpers/board.ts";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import { boardRoutes, LIGHTHOUSE_MAX_ROUTES, lighthouseRoutes, moreItems, moreItemsFor } from "./routes.ts";

test("Time is in More only when time tracking is on", async () => {
  assert.ok(!moreItems.some((item) => item.href === "/time"), "the fixed list has no Time");
  const time = { timeTracking: true, campaigns: false };
  const none = { timeTracking: false, campaigns: false };
  assert.ok(moreItemsFor(time).some((item) => item.href === "/time" && item.label === "Time"));
  assert.ok(!moreItemsFor(none).some((item) => item.href === "/time"));
  assert.deepEqual(moreItemsFor(none), moreItems);
  assert.deepEqual(moreItemsFor(time).filter((item) => item.href !== "/time"), moreItems);

  const on = await timeDb(new Date());
  const off = await timeDb(new Date(), { on: false });
  const more = (await load(devEnv(on), "/more")).body;
  assert.match(more, /<a class="card card-link" href="\/time">[\s\S]*?<span class="card-title">Time<\/span>/);
  assert.doesNotMatch((await load(devEnv(off), "/more")).body, /href="\/time"/);
  // The side bar lists it too, and /time marks More as its section.
  const page = (await load(devEnv(on), "/time")).body;
  assert.match(page, /<li><a href="\/time" aria-current="page">/);
  assert.match(page, /<a href="\/more" aria-current="true">/);
  assert.doesNotMatch((await load(devEnv(off), "/")).body, /<li><a href="\/time"/);
  assert.match((await load(devEnv(on), "/")).body, /<li><a href="\/time">/);
  // The form pages are in the same section.
  assert.match((await load(devEnv(on), "/time/new")).body, /<a href="\/more" aria-current="true">/);
});

test("the time pages are in boardRoutes and /time takes a Lighthouse slot", () => {
  for (const path of ["/time", "/time?week=2026-11-16", "/time/new", "/time/te_seed01/edit"]) assert.ok(boardRoutes.includes(path), path);
  assert.ok(lighthouseRoutes.includes("/time"));
  assert.ok(!lighthouseRoutes.includes("/time/new"), "form pages are boardRoutes only");
});

test("Lighthouse scores at most 22 pages, each one a board page, none twice", () => {
  assert.ok(
    lighthouseRoutes.length <= LIGHTHOUSE_MAX_ROUTES,
    `lighthouseRoutes has ${lighthouseRoutes.length} pages; keep it at ${LIGHTHOUSE_MAX_ROUTES} or fewer by swapping one out.`,
  );
  assert.equal(LIGHTHOUSE_MAX_ROUTES, 22);
  assert.equal(new Set(lighthouseRoutes).size, lighthouseRoutes.length);
  for (const route of lighthouseRoutes) assert.ok(boardRoutes.includes(route), `${route} is not in boardRoutes`);
});
