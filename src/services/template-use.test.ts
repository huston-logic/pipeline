// Using templates: add_project {template} copies a template's tasks, and the three template record actions go through
// proposals (decision 0057 and its templates amendment). Fake people only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { WORK_TYPES_SQL } from "../../tests/helpers/time-seed.ts";
import type { Db, TaskRow } from "../db/db.ts";
import { createTestDb } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import type { Ctx } from "./change.ts";
import type { RecordAction } from "./proposal-actions.ts";
import { addProject } from "./projects.ts";
import { applyChanges, type ProposeAnswer, proposeChanges } from "./proposals.ts";
import { updateTemplate } from "./templates.ts";
import { undoChange } from "./undo.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const DEPS = { extraOwnerEmails: [] };
const ctxFor = (db: Db, tool = "add_project"): Ctx => ({ db, now: NOW, actor: "ai", tool });

const KIT =
  "INSERT INTO project_templates (id, name) VALUES ('tp_kit', 'Kitchen kit'); " +
  "INSERT INTO template_tasks (id, template_id, parent_id, position, title, due_days, work_type_id) VALUES " +
  "('tt_a', 'tp_kit', NULL, 1, 'Survey', 3, 'wt_design'), ('tt_b', 'tp_kit', 'tt_a', 1, 'Measure', NULL, NULL), " +
  "('tt_c', 'tp_kit', NULL, 2, 'Order', 0, NULL)";

async function setup(more = "", projects = 1) {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  db.exec(`UPDATE settings SET projects = ${projects}, time_tracking = 1; ${WORK_TYPES_SQL}; ${KIT}; ${more}`);
  return db;
}

const tasksOf = async (db: Db, projectId: string) =>
  (await db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY title").bind(projectId).all<TaskRow>()).results;

async function propose(db: Db, actions: RecordAction[]) {
  const answer = await proposeChanges(ctxFor(db, "propose_changes"), { actions }, DEPS);
  assert.equal(answer.kind, "proposal", JSON.stringify(answer));
  return answer as Extract<ProposeAnswer, { kind: "proposal" }>;
}

test("add_project with a template copies the tree, order, work types and dates, and starts today", async () => {
  const db = await setup("UPDATE tasks SET project_id = NULL WHERE 0");
  const result = await addProject(ctxFor(db), { name: "Kitchen job", template: "Kitchen kit" });
  assert.match(result.summary, /copied 3 tasks from template "Kitchen kit", starting today/);
  const project = await db.prepare("SELECT * FROM projects WHERE id = ?").bind(result.projectId).first<{ start_at: string }>();
  assert.equal(project?.start_at, "2026-11-19T08:00:00.000Z");
  const rows = await tasksOf(db, result.projectId);
  const by = new Map(rows.map((row) => [row.title, row]));
  assert.equal(by.get("Survey")?.due_at, "2026-11-22T08:00:00.000Z");
  assert.equal(by.get("Order")?.due_at, "2026-11-19T08:00:00.000Z");
  assert.equal(by.get("Measure")?.due_at, null);
  assert.equal(by.get("Survey")?.work_type_id, "wt_design");
  assert.equal(by.get("Measure")?.parent_id, by.get("Survey")?.id);
  assert.deepEqual([by.get("Survey")?.position, by.get("Order")?.position, by.get("Measure")?.position], [1, 2, 1]);
});

test("a given start is kept, and a template edited later leaves the project alone", async () => {
  const db = await setup();
  const result = await addProject(ctxFor(db), { name: "Kitchen job", template: "tp_kit", startAt: "2026-12-01" });
  assert.doesNotMatch(result.summary, /starting today/);
  assert.equal((await tasksOf(db, result.projectId)).find((row) => row.title === "Survey")?.due_at, "2026-12-04T08:00:00.000Z");
  await updateTemplate(ctxFor(db, "update_template"), "tp_kit", { tasks: [{ title: "Different" }] });
  assert.deepEqual((await tasksOf(db, result.projectId)).map((row) => row.title), ["Measure", "Order", "Survey"]);
});

test("a proposal shows the copied tasks indented under the project, applies and undoes in one change", async () => {
  const db = await setup();
  const answer = await propose(db, [{ action: "add_project", name: "Kitchen job", template: "Kitchen kit" }]);
  const lines = answer.text.split("\n");
  const at = lines.findIndex((line) => line.startsWith('- Project "Kitchen job"'));
  assert.ok(at > 0, answer.text);
  assert.deepEqual(lines.slice(at + 1, at + 4), ['  - "Survey" (due Sun Nov 22; Design)', '    - "Measure"', '  - "Order" (due Thu Nov 19)']);
  const applied = await applyChanges(ctxFor(db, "apply_changes"), answer.id, DEPS);
  assert.equal(applied.applied, 1);
  const project = await db.prepare("SELECT id FROM projects WHERE name = 'Kitchen job'").first<{ id: string }>();
  assert.equal((await tasksOf(db, project?.id ?? "")).length, 3);
  await undoChange(ctxFor(db, "undo_change"), applied.changeId);
  assert.deepEqual(await tasksOf(db, project?.id ?? ""), []);
});

test("apply refuses when the template was edited after the list was made", async () => {
  const db = await setup();
  const answer = await propose(db, [{ action: "add_project", name: "Kitchen job", template: "Kitchen kit" }]);
  await updateTemplate(ctxFor(db, "update_template"), "tp_kit", { tasks: [{ title: "Different" }] });
  await assert.rejects(applyChanges(ctxFor(db, "apply_changes"), answer.id, DEPS), /changed since|no longer|Ask for a new list/i);
});

test("template tasks count toward the 100 a proposal holds", async () => {
  const db = await setup();
  const rows = Array.from({ length: 60 }, (_, i) => `('tt_big${i}', 'tp_big', NULL, ${i + 1}, 'Step ${i}')`).join(", ");
  db.exec(`INSERT INTO project_templates (id, name) VALUES ('tp_big', 'Big kit'); INSERT INTO template_tasks (id, template_id, parent_id, position, title) VALUES ${rows}`);
  const fifty = Array.from({ length: 50 }, (_, i) => ({ title: `T${i}` }));
  await assert.rejects(
    proposeChanges(ctxFor(db, "propose_changes"), { actions: [{ action: "add_project", name: "Big job", template: "tp_big" }, { action: "add_task_plan", project: "@1", tasks: fifty }] }, DEPS),
    /at most 100 planned tasks; this one has 110/,
  );
});

test("a task plan's workType is written and shown, and refused while time tracking is off", async () => {
  const db = await setup("INSERT INTO projects (id, name, contact_id, status_key) VALUES ('pj_x', 'Retrofit', 'ct_seed01', 'active')");
  const answer = await propose(db, [{ action: "add_task_plan", project: "pj_x", tasks: [{ title: "Draw", workType: "Design" }] }]);
  assert.match(answer.text, /"Draw" \(Design\)/);
  await applyChanges(ctxFor(db, "apply_changes"), answer.id, DEPS);
  assert.equal((await tasksOf(db, "pj_x"))[0]?.work_type_id, "wt_design");
  db.exec("UPDATE settings SET time_tracking = 0");
  await assert.rejects(proposeChanges(ctxFor(db, "propose_changes"), { actions: [{ action: "add_task_plan", project: "pj_x", tasks: [{ title: "Draw", workType: "Design" }] }] }, DEPS), /time tracking/i);
});

test("add_template, update_template and save_project_as_template propose, apply and undo as one change", async () => {
  const db = await setup("INSERT INTO projects (id, name, contact_id, status_key, start_at) VALUES ('pj_x', 'Retrofit', 'ct_seed01', 'active', '2026-12-01T08:00:00.000Z'); INSERT INTO tasks (id, contact_id, project_id, position, title, due_at, work_type_id) VALUES ('tk_x', 'ct_seed01', 'pj_x', 1, 'Survey', '2026-12-04T08:00:00.000Z', 'wt_design')");
  const added = await propose(db, [{ action: "add_template", name: "Retrofit kit", tasks: [{ title: "Survey", dueDays: 2 }, { title: "Photos", under: 1, workType: "Design" }] }]);
  assert.match(added.text, /- Template "Retrofit kit"\n {2}- "Survey" \(due 2 days after the start\)\n {4}- "Photos" \(Design\)/);
  const first = await applyChanges(ctxFor(db, "apply_changes"), added.id, DEPS);
  const edited = await propose(db, [{ action: "update_template", template: "Retrofit kit", tasks: [{ title: "Fresh" }] }]);
  assert.match(edited.text, /removes 2 tasks/);
  assert.match(edited.text, /- "Fresh"/);
  const second = await applyChanges(ctxFor(db, "apply_changes"), edited.id, DEPS);
  await undoChange(ctxFor(db, "undo_change"), second.changeId);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM template_tasks WHERE template_id IN (SELECT id FROM project_templates WHERE name = 'Retrofit kit') AND archived = 0").first<{ n: number }>())?.n, 2);
  const saved = await propose(db, [{ action: "save_project_as_template", project: "Retrofit", name: "Saved kit" }]);
  assert.match(saved.text, /- Template "Saved kit"\n {2}- "Survey" \(due 3 days after the start; Design\)/);
  const third = await applyChanges(ctxFor(db, "apply_changes"), saved.id, DEPS);
  await undoChange(ctxFor(db, "undo_change"), third.changeId);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM project_templates WHERE name = 'Saved kit'").first<{ n: number }>())?.n, 0);
  assert.ok(first.changeId);
});

test("every template action refuses while projects are off", async () => {
  const db = await setup("", 0);
  for (const action of [
    { action: "add_template", name: "X", tasks: [{ title: "A" }] },
    { action: "update_template", template: "tp_kit", name: "Y" },
    { action: "save_project_as_template", project: "pj_x", name: "Z" },
    { action: "add_project", name: "W", template: "tp_kit" },
  ] as RecordAction[]) {
    await assert.rejects(proposeChanges(ctxFor(db, "propose_changes"), { actions: [action] }, DEPS), /projects are off/i, action.action);
  }
});
