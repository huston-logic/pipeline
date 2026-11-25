// add_task_plan: the AI builds a project's task plan from one flat list (decision 0057). Fake people only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import type { Db, TaskRow } from "../db/db.ts";
import { createTestDb } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import type { Ctx } from "./change.ts";
import type { RecordAction } from "./proposal-actions.ts";
import { applyChanges, type ProposeAnswer, proposeChanges } from "./proposals.ts";
import { addTaskPlan, checkTree } from "./task-plan.ts";
import { undoChange } from "./undo.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const DEPS = { extraOwnerEmails: [] };
const ctxFor = (db: Db, tool = "add_task_plan"): Ctx => ({ db, now: NOW, actor: "ai", tool });

async function setup(more = "", projects = 1) {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  db.exec(
    `UPDATE settings SET projects = ${projects}; ` +
      "INSERT INTO projects (id, name, contact_id, status_key, start_at) VALUES ('pj_seed01', 'Retrofit', 'ct_seed01', 'active', '2026-12-01T08:00:00.000Z'); " +
      "INSERT INTO projects (id, name, contact_id, status_key) VALUES ('pj_nodate', 'Undated', NULL, 'active'); " +
      more,
  );
  return db;
}

const tasksOf = async (db: Db, projectId: string) =>
  (await db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at, rowid").bind(projectId).all<TaskRow>()).results;

async function propose(db: Db, actions: RecordAction[]) {
  const answer = await proposeChanges(ctxFor(db, "propose_changes"), { actions }, DEPS);
  assert.equal(answer.kind, "proposal", JSON.stringify(answer));
  return answer as Extract<ProposeAnswer, { kind: "proposal" }>;
}

test("under must name an earlier task of the plan", () => {
  assert.throws(() => checkTree([{}, { under: 3 }]), /^UserError: Task 2's under must name an earlier task in this plan \(1\)\.$/);
  assert.throws(() => checkTree([{}, {}, { under: 3 }]), /Task 3's under must name an earlier task in this plan \(1 or 2\)\./);
  assert.throws(() => checkTree([{}, {}, { under: 0 }]), /Task 3's under must name an earlier task/);
  assert.throws(() => checkTree([{ under: 1 }]), /Task 1's under must name an earlier task in this plan/);
  assert.doesNotThrow(() => checkTree([{}, { under: 1 }, { under: 2 }]));
});

test("refuses due with dueDays, dueDays without a start, and too many items", async () => {
  const db = await setup();
  await assert.rejects(addTaskPlan(ctxFor(db), { project: "pj_seed01", tasks: [{ title: "A", due: "2026-12-02", dueDays: 1 }] }), /Task 1: give a due date or dueDays, not both\./);
  await assert.rejects(addTaskPlan(ctxFor(db), { project: "pj_nodate", tasks: [{ title: "A", dueDays: 1 }] }), /Give the project a start date, or give due dates\./);
  await assert.rejects(addTaskPlan(ctxFor(db), { project: "pj_seed01", tasks: [] }), /at least one task/i);
  const many = Array.from({ length: 101 }, (_, i) => ({ title: `T${i}` }));
  await assert.rejects(addTaskPlan(ctxFor(db), { project: "pj_seed01", tasks: many }), /at most 100/i);
});

test("a plan adds every task in one change, with positions, parents and due days from the start", async () => {
  const db = await setup("INSERT INTO tasks (id, contact_id, project_id, position, title) VALUES ('tk_old', 'ct_seed01', 'pj_seed01', 1, 'Existing')");
  const result = await addTaskPlan(ctxFor(db), {
    project: "Retrofit",
    tasks: [{ title: "Survey", dueDays: 3 }, { title: "Measure", under: 1, due: "2026-12-05" }, { title: "Order", dueDays: 10 }, { title: "Photos", under: 1 }],
  });
  assert.equal(result.summary.startsWith('Added 4 tasks to project "Retrofit" (Pat Example)'), true, result.summary);
  assert.equal(result.taskIds.length, 4);
  const rows = (await tasksOf(db, "pj_seed01")).filter((row) => row.id !== "tk_old");
  const [survey, measure, order, photos] = result.taskIds.map((id) => rows.find((row) => row.id === id) as TaskRow);
  assert.deepEqual([survey?.position, order?.position, measure?.position, photos?.position], [2, 3, 1, 2]);
  assert.deepEqual([survey?.parent_id, measure?.parent_id, photos?.parent_id], [null, survey?.id, survey?.id]);
  assert.equal(survey?.due_at, "2026-12-04T08:00:00.000Z");
  assert.equal(order?.due_at, "2026-12-11T08:00:00.000Z");
  assert.equal(measure?.due_at, "2026-12-05T08:00:00.000Z");
  assert.equal(survey?.contact_id, "ct_seed01");
  assert.equal(survey?.deal_id, null);
  const undone = await undoChange(ctxFor(db, "undo_change"), result.changeId);
  assert.ok(undone.summary);
  assert.deepEqual((await tasksOf(db, "pj_seed01")).map((row) => row.id), ["tk_old"]);
});

test("a plan can go under an existing open task of the project", async () => {
  const db = await setup("INSERT INTO tasks (id, contact_id, project_id, position, title) VALUES ('tk_old', 'ct_seed01', 'pj_seed01', 1, 'Existing'), ('tk_kid', 'ct_seed01', 'pj_seed01', 1, 'Kid')");
  await db.exec("UPDATE tasks SET parent_id = 'tk_old' WHERE id = 'tk_kid'");
  const result = await addTaskPlan(ctxFor(db), { project: "pj_seed01", under: "tk_old", tasks: [{ title: "Next" }, { title: "Deeper", under: 1 }] });
  const next = (await tasksOf(db, "pj_seed01")).find((row) => row.id === result.taskIds[0]);
  assert.equal(next?.parent_id, "tk_old");
  assert.equal(next?.position, 2);
  await assert.rejects(addTaskPlan(ctxFor(db), { project: "pj_nodate", under: "tk_old", tasks: [{ title: "x" }] }), /parent's project/);
});

test("dueDays across the spring daylight-saving change land on local midnight", async () => {
  const db = await setup("UPDATE projects SET start_at = '2026-03-05T08:00:00.000Z' WHERE id = 'pj_seed01'");
  const result = await addTaskPlan(ctxFor(db), { project: "pj_seed01", tasks: [{ title: "After the change", dueDays: 10 }] });
  const row = (await tasksOf(db, "pj_seed01")).find((task) => task.id === result.taskIds[0]);
  assert.equal(row?.due_at, "2026-03-15T07:00:00.000Z");
});

test("projects off refuses", async () => {
  const db = await setup("", 0);
  await assert.rejects(addTaskPlan(ctxFor(db), { project: "pj_seed01", tasks: [{ title: "A" }] }), /projects are off/i);
});

test("add_project then a plan on @1 in one proposal: indented list, due days from the planned start, apply and one undo", async () => {
  const db = await setup();
  const actions: RecordAction[] = [
    { action: "add_project", name: "Office move", startAt: "2026-12-07" },
    { action: "add_task_plan", project: "@1", tasks: [{ title: "Pack", dueDays: 2 }, { title: "Boxes", under: 1 }, { title: "Truck" }] },
  ];
  const answer = await propose(db, actions);
  const text = answer.text.split("\n");
  const at = text.findIndex((line) => line.startsWith('- Add 3 tasks to project "Office move"'));
  assert.ok(at > 0, answer.text);
  assert.deepEqual(text.slice(at + 1, at + 4), ['  - "Pack" (due Wed Dec 9)', '    - "Boxes"', '  - "Truck"']);
  const applied = await applyChanges(ctxFor(db, "apply_changes"), answer.id, DEPS);
  assert.equal(applied.applied, 2);
  const project = await db.prepare("SELECT id FROM projects WHERE name = 'Office move'").first<{ id: string }>();
  const rows = await tasksOf(db, project?.id ?? "");
  assert.deepEqual(rows.map((row) => row.title), ["Pack", "Boxes", "Truck"]);
  assert.equal(rows[0]?.due_at, "2026-12-09T08:00:00.000Z");
  assert.equal(rows[1]?.parent_id, rows[0]?.id);
  // One undo removes the project and every task.
  await undoChange(ctxFor(db, "undo_change"), applied.changeId);
  assert.deepEqual(await tasksOf(db, project?.id ?? ""), []);
});

test("a proposal holds at most 100 planned tasks across plans", async () => {
  const db = await setup();
  const fifty = Array.from({ length: 50 }, (_, i) => ({ title: `T${i}` }));
  const actions: RecordAction[] = [
    { action: "add_task_plan", project: "pj_seed01", tasks: fifty },
    { action: "add_task_plan", project: "pj_seed01", tasks: fifty },
    { action: "add_task_plan", project: "pj_seed01", tasks: [{ title: "one more" }] },
  ];
  await assert.rejects(proposeChanges(ctxFor(db, "propose_changes"), { actions }, DEPS), /A proposal holds at most 100 planned tasks; this one has 101\. Split it into two lists\./);
});
