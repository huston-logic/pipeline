// Today works like a list (decision 0047): quick add, the To do and Needs a due date lists, and the GET sort and show
// form, through the Worker on the fixture seed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { auditCount, auditOf, changeIdOf, devEnv, h1Count, load, post, seededDb } from "../../tests/helpers/board.ts";
import type { TaskRow } from "../db/db.ts";
import { addProject } from "../services/projects.ts";
import { addTask } from "../services/tasks.ts";
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
  assert.match(body, /Give the task a title\./);
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
  assert.match(form, /<button class="button" type="submit">Show to-dos<\/button>/);
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

const TASK_COLUMNS = "id, deal_id, contact_id, title, due_at, done_at, snoozed_until, source, untrusted_fields, version, created_at, updated_at";

/** `count` standalone tasks due on later days (plus one overdue one, made last), straight into the table. */
function addStandalone(db: Awaited<ReturnType<typeof seededDb>>, count: number, overdue: boolean) {
  const row = (id: string, title: string, due: string) =>
    `('tk_pad${id}', NULL, NULL, '${title}', '${due}', NULL, NULL, 'owner', '[]', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
  const rows = Array.from({ length: count }, (_, i) => row(String(i).padStart(3, "0"), `Pad task ${i}`, `2031-01-${String((i % 28) + 1).padStart(2, "0")}T17:00:00.000Z`));
  if (overdue) rows.push(row("zzz", "Pad overdue", "2020-01-01T17:00:00.000Z"));
  db.exec(`INSERT INTO tasks (${TASK_COLUMNS}) VALUES ${rows.join(",")}`);
}

test("each list shows at most 50, overdue first, with a Showing line", async () => {
  const db = await seededDb();
  addStandalone(db, 62, true);
  const body = (await load(devEnv(db), "/?show=standalone")).body;
  assert.equal(body.match(/<h3 class="card-title">Pad /g)?.length, 50);
  assert.match(body, /<h3 class="card-title">Pad overdue<\/h3>/, "the overdue task is not cut");
  assert.match(body, /<p class="stage-more">Showing 50 of 63 to-dos\.<\/p>/);
});

test("Today reads at most 50 tasks a list from the database, however many are open", async () => {
  const db = await seededDb();
  addStandalone(db, 300, true);
  let read = 0;
  const execute = db.execute.bind(db);
  db.execute = (statement) => {
    const out = execute(statement);
    if (/^SELECT t\.\*/.test(statement.sql)) read += out.rows.length;
    return out;
  };
  const body = (await load(devEnv(db), "/")).body;
  assert.equal(body.match(/<h3 class="card-title">Pad /g)?.length, 47, "50 in To do: the overdue pad, three seeded tasks, 46 more pads");
  assert.match(body, /<p class="stage-more">Showing 50 of \d+ to-dos\.<\/p>/);
  assert.ok(read <= 100, `read ${read} task rows`);
});

test("no Showing line at 50 or fewer", async () => {
  const db = await seededDb();
  addStandalone(db, 50, false);
  const body = (await load(devEnv(db), "/?show=standalone")).body;
  assert.equal(body.match(/<h3 class="card-title">Pad /g)?.length, 50);
  assert.doesNotMatch(body, /Showing \d+ of/);
});

test("the quick-add title is required in words, the date is optional", async () => {
  const body = (await load(devEnv(await seededDb()), "/")).body;
  assert.match(body, /<label for="quick-title">Title <span class="field-required">\(required\)<\/span><\/label>/);
  assert.match(body, /<label for="quick-due">Due<\/label>/);
});

test("Done in a non-default view comes back to that same address", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const page = await load(env, "/?sort=newest");
  const { location } = await post(env, "/tasks/tk_seed02/complete", { return_to: "/?sort=newest" }, { cookie: page.cookie, token: page.token });
  assert.match(location, /^\/\?sort=newest&change=chg_/);
});

test("a sub-task on Today says what it is under; an outside parent title is 'a task'", async () => {
  const db = await seededDb();
  await db.prepare("UPDATE settings SET projects = 1").run();
  const ctx = (tool: string) => ({ db, now: new Date(), actor: "owner" as const, tool });
  const project = await addProject(ctx("add_project"), { contact: "ct_seed01", name: "Retrofit" });
  const parent = await addTask(ctx("add_task"), { project: project.projectId, title: "Order anchors" });
  await addTask(ctx("add_task"), { parent: parent.taskId, title: "Pick supplier" });
  const env = devEnv(db);
  const shown = (await load(env, "/")).body;
  assert.match(shown, /Pick supplier[\s\S]*?<dt>Under<\/dt>\s*<dd>Order anchors<\/dd>/);
  await db.prepare("UPDATE tasks SET untrusted_fields = '[\"title\"]' WHERE id = ?").bind(parent.taskId).run();
  const outside = (await load(env, "/")).body;
  assert.match(outside, /Pick supplier[\s\S]*?<dt>Under<\/dt>\s*<dd>a task<\/dd>/);
  assert.doesNotMatch(outside.slice(outside.indexOf("Pick supplier")), /Under<\/dt>\s*<dd>Order anchors/);
});
