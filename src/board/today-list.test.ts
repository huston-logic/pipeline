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
  assert.match(shown, /<h2 id="today-undated">No due date<\/h2>[\s\S]*<span class="task-title">Order printer paper/);
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
  assert.match(shown, /<h2 id="today-upcoming">Upcoming<\/h2>[\s\S]*<span class="task-title">Renew the van insurance/);
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
  // Closed as sent, so nothing moves after the first paint; from 40rem the stylesheet shows its content (no script).
  const tools = /<details class="today-tools" id="today-tools">[\s\S]*?<\/details>/.exec(body)?.[0] ?? "";
  assert.match(tools, /<summary>Sort and filter<\/summary>/);
  assert.doesNotMatch(body, /data-close-narrow/);
  const form = /<form class="today-filter"[^>]*>[\s\S]*?<\/form>/.exec(tools)?.[0] ?? "";
  assert.match(form, /action="\/" method="get"[^>]* data-autosubmit>/);
  assert.doesNotMatch(form, /name="csrf"/);
  assert.match(form, /<label for="todo-sort">Sort<\/label>\s*<select id="todo-sort" name="sort">[\s\S]*<option value="newest" selected>/);
  assert.match(form, /<label for="todo-show">Show<\/label>\s*<select id="todo-show" name="show">[\s\S]*<option value="standalone" selected>/);
  assert.match(form, /<button class="button button-small" type="submit" data-autosubmit-hide>Show to-dos<\/button>/);
  assert.match(body, /<form class="quick-add" method="post" action="\/tasks\/quick" data-live data-after="quick-title" novalidate>/);
});

test("the show filter and an unknown value", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  await post(env, "/tasks/quick", { title: "Order printer paper", return_to: "/" });
  const alone = (await load(env, "/?show=standalone")).body;
  assert.match(alone, /Order printer paper/);
  const casey = /<span class="task-title">Send Casey the price sheet/;
  assert.doesNotMatch(alone, casey);
  const linked = (await load(env, "/?show=linked")).body;
  assert.doesNotMatch(linked, /<span class="task-title">Order printer paper/);
  assert.match(linked, casey);
  const fallback = (await load(env, "/?sort=bogus&show=bogus")).body;
  assert.match(fallback, /<span class="task-title">Order printer paper/);
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

const padRows = (body: string) => body.match(/<span class="task-title">Pad /g)?.length;

test("the list shows at most 200 dated to-dos, overdue first, with a Showing line", async () => {
  const db = await seededDb();
  addStandalone(db, 262, true);
  const body = (await load(devEnv(db), "/?show=standalone")).body;
  assert.equal(padRows(body), 200);
  assert.match(body, /<span class="task-title">Pad overdue<\/span>/, "the overdue task is not cut");
  assert.match(body, /<p class="stage-more">Showing 200 of 263 to-dos\.<\/p>/);
});

test("Today shows at most 200 tasks in all and reads few more, however many are open", async () => {
  const db = await seededDb();
  addStandalone(db, 600, true);
  let read = 0;
  const execute = db.execute.bind(db);
  db.execute = (statement) => {
    const out = execute(statement);
    if (/^SELECT t\.\*/.test(statement.sql)) read += out.rows.length;
    return out;
  };
  const body = (await load(devEnv(db), "/")).body;
  assert.equal(padRows(body), 197, "200 dated: three seeded tasks, the overdue pad and 196 more pads");
  assert.match(body, /<p class="stage-more">Showing 200 of 605 to-dos\.<\/p>/, "never more than 200 shown");
  assert.ok(read <= 201, `read ${read} task rows`);
});

test("no Showing line at 200 or fewer", async () => {
  const db = await seededDb();
  addStandalone(db, 200, false);
  const body = (await load(devEnv(db), "/?show=standalone")).body;
  assert.equal(padRows(body), 200);
  assert.doesNotMatch(body, /Showing \d+ of/);
});

test("Today has no Latest brief block and no second column", async () => {
  const body = (await load(devEnv(await seededDb()), "/")).body;
  assert.doesNotMatch(body, /Latest brief|brief-heading|today-columns|today-glance/);
  assert.match(body, /<div role="group" aria-labelledby="stage-counts-name"><span class="visually-hidden" id="stage-counts-name">Open deals by stage<\/span><dl class="stage-counts">[\s\S]*<a href="\/pipeline#stage-1">New inquiry<\/a><\/dt><dd>2<\/dd>/);
});

test("the add form has its own region that a filter leaves alone, the list says its count, and the add buttons close the page", async () => {
  const body = (await load(devEnv(await seededDb()), "/")).body;
  assert.match(body, /<div data-region="today-add" data-keep>\n<form class="quick-add"/);
  assert.match(body, /<div data-region="today-list" data-count-text="\d+ to-dos?">/);
  assert.ok(body.indexOf("today-foot") > body.indexOf("today-list"), "buttons after the list");
  assert.doesNotMatch(body.slice(0, body.indexOf("today-list")), /today-actions/, "none in the head");
  assert.match(body, /<div class="today-foot"><p class="page-action today-actions">/);
});

test("Overdue is in words on every overdue row, and who a row is for is said in full when it is open", async () => {
  const db = await seededDb();
  await db.prepare("UPDATE deals SET next_step = 'Send the quote', next_at = ? WHERE id = 'dl_seed01'").bind("2020-01-01T17:00:00.000Z").run();
  const body = (await load(devEnv(db), "/")).body;
  const overdue = body.slice(body.indexOf('id="today-overdue"'), body.indexOf('id="today-today"'));
  const rows = overdue.split('<li class="task-row').slice(1);
  assert.ok(rows.length > 0);
  for (const row of rows) assert.match(row.split("</summary>")[0] ?? "", /<span class="task-late">Overdue<\/span>/);
  assert.match(body, /<p class="task-for">For Pat Example<\/p>\n<p>Next step: Send the quote/);
  assert.match(body, /<p class="task-for">For /, "a task shows its person or deal in full when opened");
});

test("the groups are plain h2s in order, and an empty one is left out", async () => {
  const body = (await load(devEnv(await seededDb()), "/")).body;
  const names = [...body.matchAll(/<h2 id="today-\w+">([^<]*)<\/h2>/g)].map((m) => m[1]);
  const order = ["Overdue", "Today", "Upcoming", "No due date"];
  assert.deepEqual(names, order.filter((name) => names.includes(name)));
  assert.ok(names.includes("Overdue") && names.includes("No due date"));
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

test("a project is one row with its tasks inside it; an outside name is labelled", async () => {
  const db = await seededDb();
  await db.prepare("UPDATE settings SET projects = 1").run();
  const ctx = (tool: string) => ({ db, now: new Date(), actor: "owner" as const, tool });
  const project = await addProject(ctx("add_project"), { contact: "ct_seed01", name: "Retrofit" });
  const parent = await addTask(ctx("add_task"), { project: project.projectId, title: "Order anchors" });
  await addTask(ctx("add_task"), { parent: parent.taskId, title: "Pick supplier" });
  const env = devEnv(db);
  const shown = (await load(env, "/")).body;
  const row = shown.slice(shown.indexOf(`<li class="task-row project-row" data-task-row id="p-${project.projectId}">`));
  assert.ok(row.length > 0 && shown.includes(`id="p-${project.projectId}"`));
  assert.match(row, /<span class="task-title">Retrofit<\/span>/);
  assert.match(row, /<span class="task-belongs"><span class="visually-hidden">, <\/span>1 task, 0 overdue<\/span>/);
  assert.match(row, /<span class="task-title">Order anchors<\/span>[\s\S]*1 open sub-task/);
  assert.match(row, /Pick supplier/, "the sub-task is under its parent");
  assert.match(row, new RegExp(`<a href="/projects/${project.projectId}">Open the project</a>`));
  assert.equal(shown.match(/<span class="task-title">Order anchors/g)?.length, 1, "no row of its own outside the project");
  await db.prepare("UPDATE projects SET untrusted_fields = '[\"name\"]' WHERE id = ?").bind(project.projectId).run();
  const outside = (await load(env, "/")).body;
  assert.match(outside, /<span class="task-title"><span class="outside">From outside<\/span> <span class="outside-value">Retrofit<\/span><\/span>/);
});

test("a deal due is a row with an empty Done cell, its next step and a link to the deal", async () => {
  const db = await seededDb();
  await db.prepare("UPDATE deals SET next_step = 'Send the quote', next_at = ? WHERE id = 'dl_seed01'").bind("2020-01-01T17:00:00.000Z").run();
  const body = (await load(devEnv(db), "/")).body;
  const row = /<li class="task-row next-step-row"[\s\S]*?<\/li>/.exec(body)?.[0] ?? "";
  assert.match(row, /<span class="task-done-cell" aria-hidden="true"><\/span>/);
  assert.doesNotMatch(row, /task-done-box/, "a deal has no Done box");
  assert.match(row, /Next step: Send the quote/);
  assert.match(row, /<a href="\/deals\/dl_seed01">Open the deal<\/a>/);
  assert.match(row, /Overdue/);
});
