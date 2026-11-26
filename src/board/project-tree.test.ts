// The project page's task tree (decision 0057): nested lists to three levels, "N of M done", Add a sub-task under
// levels 1 and 2, Move up and down as one change, the note for deeper levels, a done subtree in Done, the 500-task cap.
import assert from "node:assert/strict";
import { test } from "node:test";
import { auditCount, auditOf, changeIdOf, devEnv, load, post } from "../../tests/helpers/board.ts";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import { addTask, completeTask } from "../services/tasks.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const ctxFor = (db: SqliteD1, tool: string) => ({ db, now: NOW, actor: "owner" as const, tool });
const PAGE = "/projects/pj_retro";

async function projectDb(): Promise<SqliteD1> {
  const db = await timeDb(NOW);
  db.exec("UPDATE settings SET projects = 1");
  db.exec(`INSERT INTO projects (id, name, contact_id, status_key, created_at, updated_at) VALUES
    ('pj_retro', 'Retrofit', 'ct_seed01', 'active', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')`);
  return db;
}

async function add(db: SqliteD1, title: string, parent?: string): Promise<string> {
  const input = parent === undefined ? { project: "pj_retro", title } : { parent, title };
  return (await addTask(ctxFor(db, "add_task"), input)).taskId;
}

/** A task below the third level, as an older project may still have one (the services no longer make them). */
async function older(db: SqliteD1, title: string, parent: string): Promise<string> {
  const id = `tk_${title.toLowerCase()}`;
  await db
    .prepare("INSERT INTO tasks (id, contact_id, project_id, parent_id, position, title) VALUES (?, 'ct_seed01', 'pj_retro', ?, 1, ?)")
    .bind(id, parent, title)
    .run();
  return id;
}

const section = (body: string, from: string, to: string) => body.slice(body.indexOf(from), body.indexOf(to));

test("tasks nest to three levels, and a parent says how many of its sub-tasks are done", async () => {
  const db = await projectDb();
  const top = await add(db, "Build deck");
  const subs: string[] = [];
  for (const name of ["Footings", "Frame", "Boards", "Rails", "Stain"]) subs.push(await add(db, name, top));
  await add(db, "Dig holes", subs[0] ?? "");
  await completeTask(ctxFor(db, "complete_task"), subs[3] ?? "");
  await completeTask(ctxFor(db, "complete_task"), subs[4] ?? "");
  const { body } = await load(devEnv(db), PAGE);
  assert.match(body, /2 of 5 done/);
  assert.match(body, /<ul class="task-tree"[^]*Build deck[^]*<ul class="task-tree"[^]*Footings[^]*<ul class="task-tree"[^]*Dig holes/);
  assert.match(body, /Rails[^]*Done/);
});

test("Add a sub-task is offered under levels 1 and 2 only, and calls add_task with the parent", async () => {
  const db = await projectDb();
  const one = await add(db, "Level one");
  const two = await add(db, "Level two", one);
  const three = await add(db, "Level three", two);
  const { body } = await load(devEnv(db), PAGE);
  assert.match(body, new RegExp(`action="/tasks/${one}/subtasks"`));
  assert.match(body, new RegExp(`action="/tasks/${two}/subtasks"`));
  assert.doesNotMatch(body, new RegExp(`/tasks/${three}/subtasks`));
  assert.match(body, /<fieldset class="field field-when">\s*<legend>Add a sub-task<\/legend>/);
  const added = await post(devEnv(db), `/tasks/${two}/subtasks`, { title: "Another", return_to: PAGE });
  assert.equal(added.res.status, 303);
  assert.match(added.location, /^\/projects\/pj_retro\?change=chg_[a-z0-9]{12}$/);
  const audit = await auditOf(db, changeIdOf(added.location));
  assert.deepEqual([audit?.actor, audit?.tool], ["owner", "add_task"]);
  const row = await db.prepare("SELECT parent_id FROM tasks WHERE title = 'Another'").first<{ parent_id: string }>();
  assert.equal(row?.parent_id, two);
  const refused = await post(devEnv(db), `/tasks/${two}/subtasks`, { title: "", return_to: PAGE });
  assert.equal(refused.res.status, 422);
  const stray = await post(devEnv(db), `/tasks/tk_nope/subtasks`, { title: "x", return_to: PAGE });
  assert.equal(stray.res.status, 404);
});

test("Move up and Move down swap two siblings in one change; the ends have only one", async () => {
  const db = await projectDb();
  const a = await add(db, "Alpha");
  const b = await add(db, "Bravo");
  const c = await add(db, "Charlie");
  const { body } = await load(devEnv(db), PAGE);
  const buttons = (id: string) => new RegExp(`action="/tasks/${id}/move"[^]*?</form>`).exec(body)?.[0] ?? "";
  assert.deepEqual([buttons(a).includes('value="up"'), buttons(a).includes('value="down"')], [false, true]);
  assert.deepEqual([buttons(b).includes('value="up"'), buttons(b).includes('value="down"')], [true, true]);
  assert.deepEqual([buttons(c).includes('value="up"'), buttons(c).includes('value="down"')], [true, false]);
  const before = await auditCount(db);
  const moved = await post(devEnv(db), `/tasks/${b}/move`, { dir: "up", return_to: PAGE });
  assert.equal(moved.res.status, 303);
  assert.match(moved.location, /^\/projects\/pj_retro\?change=chg_[a-z0-9]{12}$/);
  assert.equal(await auditCount(db), before + 1);
  assert.equal((await auditOf(db, changeIdOf(moved.location)))?.tool, "move_task");
  const page = (await load(devEnv(db), PAGE)).body;
  assert.ok(page.indexOf("Bravo") < page.indexOf("Alpha"));
  const refused = await post(devEnv(db), `/tasks/${b}/move`, { dir: "up", return_to: PAGE });
  assert.equal(refused.res.status, 422);
  assert.match(refused.body, /already first/);
  assert.equal((await post(devEnv(db), `/tasks/${b}/move`, { dir: "sideways", return_to: PAGE })).res.status, 422);
});

test("a top-level move skips a hidden done sibling, so the visible order changes", async () => {
  const db = await projectDb();
  await add(db, "Alpha");
  const gone = await add(db, "Gone");
  const b = await add(db, "Bravo");
  await completeTask(ctxFor(db, "complete_task"), gone);
  const before = (await load(devEnv(db), PAGE)).body;
  assert.ok(before.indexOf("Alpha") < before.indexOf("Bravo"));
  const moved = await post(devEnv(db), `/tasks/${b}/move`, { dir: "up", return_to: PAGE });
  assert.equal(moved.res.status, 303);
  const open = (await load(devEnv(db), PAGE)).body;
  const shown = section(open, "Open tasks</h2>", "Done</h2>");
  assert.ok(shown.indexOf("Bravo") < shown.indexOf("Alpha"));
  const again = await post(devEnv(db), `/tasks/${b}/move`, { dir: "up", return_to: PAGE });
  assert.equal(again.res.status, 422);
});

test("a third-level task with tasks below says how many levels it hides", async () => {
  const db = await projectDb();
  const one = await add(db, "L1");
  const two = await add(db, "L2", one);
  const three = await add(db, "L3", two);
  const four = await older(db, "L4", three);
  await older(db, "L5", four);
  const { body } = await load(devEnv(db), PAGE);
  assert.match(body, /Has 2 more levels below\. Your AI app can show them\./);
  assert.doesNotMatch(body, />L4</);
  const single = await projectDb();
  const s1 = await add(single, "S1");
  const s2 = await add(single, "S2", s1);
  const s3 = await add(single, "S3", s2);
  await older(single, "S4", s3);
  assert.match((await load(devEnv(single), PAGE)).body, /Has 1 more level below\./);
  const flat = await projectDb();
  await add(flat, "Only");
  assert.doesNotMatch((await load(devEnv(flat), PAGE)).body, /more levels below/);
});

test("a done top-level task goes to Done with its subtree, and done sub-tasks stay under open parents", async () => {
  const db = await projectDb();
  const old = await add(db, "Old job");
  await add(db, "Old step", old);
  const live = await add(db, "Live job");
  const step = await add(db, "Finished step", live);
  await completeTask(ctxFor(db, "complete_task"), step);
  await completeTask(ctxFor(db, "complete_task"), old, { subTasks: "complete" });
  const { body } = await load(devEnv(db), PAGE);
  const open = section(body, "Open tasks</h2>", "Done</h2>");
  const done = section(body, "Done</h2>", "Notes</h2>");
  assert.match(open, /Live job[^]*Finished step/);
  assert.doesNotMatch(open, /Old job|Old step/);
  assert.match(done, /Old job[^]*Old step/);
  assert.doesNotMatch(done, /Live job/);
});

test("more than 500 tasks show the first 500 and say so", async () => {
  const db = await projectDb();
  await add(db, "First");
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500)
    INSERT INTO tasks (id, contact_id, title, project_id, position) SELECT 'tk_bulk' || i, 'ct_seed01', 'Bulk ' || i, 'pj_retro', i + 1 FROM n`);
  const { body } = await load(devEnv(db), PAGE);
  assert.match(body, /Showing the first 500 tasks\./);
  const small = await projectDb();
  await add(small, "One");
  assert.doesNotMatch((await load(devEnv(small), PAGE)).body, /Showing the first 500/);
});
