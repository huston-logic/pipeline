// Today works like a list (decision 0047): quick add, the To do and Needs a due date lists, and the GET sort and show
// form, through the Worker on the fixture seed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { auditCount, auditOf, changeIdOf, devEnv, h1Count, load, post, seededDb } from "../../tests/helpers/board.ts";
import type { TaskRow } from "../db/db.ts";
import { DEFAULT_TZ, zonedToUtc } from "../time.ts";

const taskByTitle = async (db: Awaited<ReturnType<typeof seededDb>>, title: string) =>
  db.prepare("SELECT * FROM tasks WHERE title = ?").bind(title).first<TaskRow>();

test("quick add creates a standalone task and shows Undo", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const before = await auditCount(db);
  const { res, location } = await post(env, "/tasks/quick", { title: "Order printer paper", due: "", return_to: "/" });
  assert.equal(res.status, 303);
  assert.match(location, /^\/\?change=chg_[a-z0-9]{12}$/);
  assert.equal(await auditCount(db), before + 1);
  const audit = await auditOf(db, changeIdOf(location));
  assert.equal(audit?.actor, "owner");
  assert.equal(audit?.tool, "add_task");
  const row = await taskByTitle(db, "Order printer paper");
  assert.equal(row?.deal_id, null);
  assert.equal(row?.contact_id, null);
  assert.equal(row?.due_at, null);
  const shown = (await load(env, location)).body;
  assert.match(shown, /Undo<span class="visually-hidden"> change chg_/);
  assert.match(shown, /<h2 id="undated-heading">Needs a due date<\/h2>[\s\S]*Order printer paper[\s\S]*No person or deal/);
});

test("quick add with a date", async () => {
  const db = await seededDb();
  const { res, location } = await post(devEnv(db), "/tasks/quick", { title: "Renew the van insurance", due: "2027-01-15", return_to: "/" });
  assert.equal(res.status, 303);
  assert.match(location, /^\/\?change=chg_/);
  const row = await taskByTitle(db, "Renew the van insurance");
  assert.equal(row?.deal_id, null);
  assert.ok(row?.due_at !== null && row?.due_at !== undefined);
  assert.equal(new Date(row.due_at).toISOString(), zonedToUtc("2027-01-15", DEFAULT_TZ).toISOString());
  const shown = (await load(devEnv(db), "/")).body;
  assert.match(shown, /<h2 id="todo-heading">To do<\/h2>[\s\S]*Renew the van insurance[\s\S]*No person or deal/);
});

test("empty quick add is 422 with the value kept", async () => {
  const db = await seededDb();
  const before = await auditCount(db);
  const { res, body } = await post(devEnv(db), "/tasks/quick", { title: "   ", due: "2027-01-15", return_to: "/" });
  assert.equal(res.status, 422);
  assert.equal(await auditCount(db), before);
  assert.equal(h1Count(body), 1);
  assert.match(body, /Say in a few words what to do\./);
  assert.match(body, /<input id="quick-due" name="due" type="date" value="2027-01-15"/);
});

test("Today with JavaScript off has the sort form as a GET form", async () => {
  const db = await seededDb();
  const { body } = await load(devEnv(db), "/?sort=newest&show=standalone");
  const form = /<form class="search search-filters todo-filter"[^>]*>[\s\S]*?<\/form>/.exec(body)?.[0] ?? "";
  assert.match(form, /action="\/" method="get"/);
  assert.doesNotMatch(form, /name="csrf"/);
  assert.match(form, /<select id="todo-sort" name="sort">[\s\S]*<option value="newest" selected>/);
  assert.match(form, /<select id="todo-show" name="show">[\s\S]*<option value="standalone" selected>/);
  assert.match(form, /<button class="button" type="submit">Show<\/button>/);
  assert.match(body, /<form class="quick-add" method="post" action="\/tasks\/quick" novalidate>/);
});

test("the show filter and an unknown value", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  await post(env, "/tasks/quick", { title: "Order printer paper", return_to: "/" });
  const alone = (await load(env, "/?show=standalone")).body;
  assert.match(alone, /Order printer paper/);
  const casey = /<h3 class="card-title">Send Casey the price sheet/;
  assert.doesNotMatch(alone, casey);
  const linked = (await load(env, "/?show=linked")).body;
  assert.doesNotMatch(linked, /<h3 class="card-title">Order printer paper/);
  assert.match(linked, casey);
  const fallback = (await load(env, "/?sort=bogus&show=bogus")).body;
  assert.match(fallback, /<h3 class="card-title">Order printer paper/);
  assert.match(fallback, casey);
  assert.match(fallback, /<option value="due" selected>/);
});

test("a snoozed task is not on the list", async () => {
  const db = await seededDb();
  const body = (await load(devEnv(db), "/")).body;
  assert.doesNotMatch(body, /Check in with Taylor/);
});
