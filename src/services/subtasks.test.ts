// Sub-tasks (migration 0022, decision 0057): add_task under a parent, positions, moveTask, descendants, undo.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import type { Db, TaskRow } from "../db/db.ts";
import { createTestDb } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import type { Ctx } from "./change.ts";
import { applyChanges, proposeChanges } from "./proposals.ts";
import { descendants, moveTask, nextPosition } from "./subtasks.ts";
import { addTask, completeTask } from "./tasks.ts";
import { undoChange } from "./undo.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const ctxFor = (db: Db, tool = "add_task"): Ctx => ({ db, now: NOW, actor: "owner", tool });

async function setup() {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  db.exec(
    "UPDATE settings SET projects = 1; " +
      "INSERT INTO projects (id, name, contact_id, deal_id, status_key) VALUES " +
      "('pj_a', 'Retrofit', 'ct_seed01', NULL, 'active'), ('pj_b', 'Other job', NULL, NULL, 'active'), ('pj_old', 'Old job', NULL, NULL, 'active'); " +
      "UPDATE projects SET archived = 1 WHERE id = 'pj_old'",
  );
  return db;
}

const row = (db: Db, id: string) => db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<TaskRow>();
const top = async (db: Db, title: string, project = "pj_a") => (await addTask(ctxFor(db), { project, title })).taskId;
const sub = async (db: Db, parent: string, title: string) => (await addTask(ctxFor(db), { parent, title })).taskId;

test("a new project task goes last among its siblings, per project and per parent", async () => {
  const db = await setup();
  const a = await top(db, "A");
  const b = await top(db, "B");
  const other = await top(db, "Other", "pj_b");
  const a1 = await sub(db, a, "A1");
  const a2 = await sub(db, a, "A2");
  assert.deepEqual(await Promise.all([a, b, other, a1, a2].map(async (id) => (await row(db, id))?.position)), [1, 2, 1, 1, 2]);
  assert.equal(await nextPosition(db, "pj_a", null), 3);
  assert.equal(await nextPosition(db, "pj_a", a), 3);
  assert.equal(await nextPosition(db, "pj_a", b), 1);
});

test("a sub-task gets the parent's project and person and no deal, at any depth", async () => {
  const db = await setup();
  const a = await top(db, "A");
  const a1 = await sub(db, a, "A1");
  const a11 = await sub(db, a1, "A11");
  const a111 = await sub(db, a11, "A111");
  const made = await row(db, a111);
  assert.deepEqual([made?.project_id, made?.contact_id, made?.deal_id, made?.parent_id], ["pj_a", "ct_seed01", null, a11]);
  assert.match((await addTask(ctxFor(db), { parent: a, title: "Plain" })).summary, /^Added task "Plain" for "Retrofit"/);
  const internal = await top(db, "Internal", "pj_b");
  const child = await row(db, await sub(db, internal, "Child"));
  assert.deepEqual([child?.project_id, child?.contact_id, child?.deal_id], ["pj_b", null, null]);
});

test("a parent must be an open task on a live project, and the project and person given must match", async () => {
  const db = await setup();
  const a = await top(db, "A");
  const plain = (await addTask(ctxFor(db), { title: "Buy ink" })).taskId;
  await assert.rejects(addTask(ctxFor(db), { parent: plain, title: "x" }), /^UserError: Sub-tasks go under a project's task\. Give a task that is on a project\.$/);
  await assert.rejects(addTask(ctxFor(db), { parent: "tk_nope", title: "x" }), /No task "tk_nope"/);
  await assert.rejects(addTask(ctxFor(db), { parent: a, project: "pj_b", title: "x" }), /parent's project/);
  await assert.rejects(addTask(ctxFor(db), { parent: a, dealId: "dl_seed07", title: "x" }), /not both/);
  await assert.rejects(addTask(ctxFor(db), { parent: a, contactId: "ct_seed07", title: "x" }), /belongs to/);
  assert.equal((await addTask(ctxFor(db), { parent: a, project: "Retrofit", title: "ok" })).taskId.startsWith("tk_"), true);
  await completeTask(ctxFor(db, "complete_task"), a, { subTasks: "leave" });
  await assert.rejects(addTask(ctxFor(db), { parent: a, title: "x" }), /is already done/);
  const b = await top(db, "B");
  db.exec("UPDATE projects SET archived = 1 WHERE id = 'pj_a'");
  await assert.rejects(addTask(ctxFor(db), { parent: b, title: "x" }), /archived/);
});

test("moveTask swaps with the neighbouring sibling, and refuses at the ends", async () => {
  const db = await setup();
  const a = await top(db, "A");
  const b = await top(db, "B");
  const c = await top(db, "C");
  const moved = await moveTask(ctxFor(db, "move_task"), c, "up");
  assert.match(moved.summary, /^Moved task "C" up \(change chg_[a-z0-9]{12}\)$/);
  assert.deepEqual(await Promise.all([a, b, c].map(async (id) => (await row(db, id))?.position)), [1, 3, 2]);
  await undoChange(ctxFor(db, "undo_change"), moved.changeId);
  assert.deepEqual(await Promise.all([a, b, c].map(async (id) => (await row(db, id))?.position)), [1, 2, 3]);
  await moveTask(ctxFor(db, "move_task"), c, "up");
  await assert.rejects(moveTask(ctxFor(db, "move_task"), a, "up"), /already first/);
  await assert.rejects(moveTask(ctxFor(db, "move_task"), b, "down"), /already last/);
  await moveTask(ctxFor(db, "move_task"), a, "down");
  assert.deepEqual(await Promise.all([a, b, c].map(async (id) => (await row(db, id))?.position)), [2, 3, 1]);
  const plain = (await addTask(ctxFor(db), { title: "Buy ink" })).taskId;
  await assert.rejects(moveTask(ctxFor(db, "move_task"), plain, "up"), /project/);
});

test("descendants lists every level in tree order", async () => {
  const db = await setup();
  const a = await top(db, "A");
  const z = await top(db, "Z");
  const a1 = await sub(db, a, "A1");
  const a2 = await sub(db, a, "A2");
  const a11 = await sub(db, a1, "A11");
  await sub(db, z, "Z1");
  assert.deepEqual((await descendants(db, a)).map((t) => t.id), [a1, a11, a2]);
  assert.deepEqual(await descendants(db, a2), []);
});

test("descendants ends on bad data: a cycle or a task under itself lists each task once", async () => {
  const db = await setup();
  const a = await top(db, "A");
  const a1 = await sub(db, a, "A1");
  const a11 = await sub(db, a1, "A11");
  db.exec(`UPDATE tasks SET parent_id = '${a11}' WHERE id = '${a}'`);
  assert.deepEqual((await descendants(db, a)).map((t) => t.id), [a1, a11]);
  db.exec(`UPDATE tasks SET parent_id = '${a1}' WHERE id = '${a1}'`);
  assert.deepEqual((await descendants(db, a1)).map((t) => t.id), [a11, a]);
});

test("undoing the change that added a parent is refused while a sub-task points at it", async () => {
  const db = await setup();
  const parent = await addTask(ctxFor(db), { project: "pj_a", title: "A" });
  await sub(db, parent.taskId, "A1");
  await assert.rejects(undoChange(ctxFor(db, "undo_change"), parent.changeId), /1 sub-task/);
});

test("two add_task actions under one parent in a proposal get positions 1 and 2", async () => {
  const db = await setup();
  const a = await top(db, "A");
  const ctx = { ...ctxFor(db, "propose_changes"), actor: "ai" as const };
  const answer = await proposeChanges(
    ctx,
    {
      actions: [
        { action: "add_task", parent: a, title: "First" },
        { action: "add_task", parent: a, title: "Second" },
        { action: "add_task", project: "pj_a", title: "Top level" },
      ],
    },
    { extraOwnerEmails: [] },
  );
  assert.equal(answer.kind, "proposal");
  if (answer.kind !== "proposal") return;
  assert.match(answer.text, /under task "A"/);
  await applyChanges({ ...ctx, tool: "apply_changes" }, answer.id, { extraOwnerEmails: [] });
  const made = (await db.prepare("SELECT title, parent_id, position FROM tasks WHERE title IN ('First', 'Second', 'Top level') ORDER BY title").all<{ title: string; parent_id: string | null; position: number }>()).results;
  assert.deepEqual(made.map((t) => [t.title, t.parent_id === a, t.position]), [["First", true, 1], ["Second", true, 2], ["Top level", false, 2]]);
});

test("completing a parent with open sub-tasks asks first; complete finishes them all in one change and one undo; leave finishes only the task", async () => {
  const db = await setup();
  const a = await top(db, "A");
  const a1 = await sub(db, a, "A1");
  const a11 = await sub(db, a1, "A11");
  const a2 = await sub(db, a, "A2");
  await completeTask(ctxFor(db, "complete_task"), a2);
  await assert.rejects(
    completeTask(ctxFor(db, "complete_task"), a),
    /^UserError: Task "A" for "Retrofit" \(Pat Example\) has 2 open sub-tasks\. Send subTasks "complete" to finish them too, or "leave" to keep them open\.$/,
  );
  const left = await completeTask(ctxFor(db, "complete_task"), a, { subTasks: "leave" });
  assert.equal((await row(db, a))?.done_at !== null, true);
  assert.equal((await row(db, a1))?.done_at, null);
  await undoChange(ctxFor(db, "undo_change"), left.changeId);
  const all = await completeTask(ctxFor(db, "complete_task"), a, { subTasks: "complete" });
  assert.match(all.summary, /^Completed task "A" for "Retrofit" \(Pat Example\) and 2 sub-tasks \(change /);
  assert.deepEqual(await Promise.all([a, a1, a11].map(async (id) => (await row(db, id))?.done_at === NOW.toISOString())), [true, true, true]);
  await undoChange(ctxFor(db, "undo_change"), all.changeId);
  assert.deepEqual(await Promise.all([a, a1, a11].map(async (id) => (await row(db, id))?.done_at)), [null, null, null]);
});

test("one open sub-task reads in the singular; a task with none needs no subTasks", async () => {
  const db = await setup();
  const a = await top(db, "A");
  await sub(db, a, "A1");
  await assert.rejects(completeTask(ctxFor(db, "complete_task"), a), /has 1 open sub-task\. Send/);
  assert.match((await completeTask(ctxFor(db, "complete_task"), a, { subTasks: "complete" })).summary, /and 1 sub-task \(change/);
  const b = await top(db, "B");
  assert.match((await completeTask(ctxFor(db, "complete_task"), b, { subTasks: "complete" })).summary, /^Completed task "B" for "Retrofit" \(Pat Example\) \(change/);
});

test("a proposal to complete a parent with subTasks shows every sub-task as done", async () => {
  const db = await setup();
  const a = await top(db, "A");
  await sub(db, a, "A1");
  const ctx = { ...ctxFor(db, "propose_changes"), actor: "ai" as const };
  const answer = await proposeChanges(ctx, { actions: [{ action: "complete_task", task: a, subTasks: "complete" }] }, { extraOwnerEmails: [] });
  assert.equal(answer.kind, "proposal");
  if (answer.kind !== "proposal") return;
  assert.match(answer.text, /Task "A1"/);
  assert.match(answer.text, /done/);
  await applyChanges({ ...ctx, tool: "apply_changes" }, answer.id, { extraOwnerEmails: [] });
  assert.equal((await row(db, a))?.done_at !== null && (await db.prepare("SELECT done_at FROM tasks WHERE title = 'A1'").first<string>("done_at")) !== null, true);
});

test("while projects are off, completing a task asks nothing about sub-tasks", async () => {
  const db = await setup();
  const a = await top(db, "A");
  await sub(db, a, "A1");
  await db.prepare("UPDATE settings SET projects = 0").run();
  assert.match((await completeTask(ctxFor(db, "complete_task"), a)).summary, /^Completed /);
});
