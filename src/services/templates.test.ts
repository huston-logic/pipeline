import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db, TemplateTaskRow } from "../db/db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import { racing } from "../../tests/helpers/race-db.ts";
import type { Ctx } from "./change.ts";
import { startTimer } from "./timer.ts";
import { undoChange } from "./undo.ts";
import {
  addTemplate,
  addTemplateTask,
  archiveTemplateTask,
  duplicateTemplate,
  moveTemplateTask,
  updateTemplate,
  updateTemplateTask,
} from "./templates.ts";
import { addWorkType } from "./work-types.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const ctxFor = (db: Db, tool = "add_template"): Ctx => ({ db, now: NOW, actor: "owner", tool });

async function setup(options: { projects?: boolean; time?: boolean } = {}) {
  const db = await openTestDb();
  if (options.projects !== false) await db.prepare("UPDATE settings SET projects = 1").run();
  if (options.time === true) await db.prepare("UPDATE settings SET time_tracking = 1").run();
  return db;
}

/** Task titles in tree order with their depth, e.g. "Plan", "-Draft". */
async function outline(db: Db, templateId: string): Promise<string[]> {
  const rows = (await db.prepare("SELECT * FROM template_tasks WHERE template_id = ? AND archived = 0").bind(templateId).all<TemplateTaskRow>()).results;
  const out: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const row of rows.filter((r) => r.parent_id === parent).sort((a, b) => a.position - b.position)) {
      out.push(`${"-".repeat(depth)}${row.title}`);
      walk(row.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

const names = (...titles: string[]) => titles.map((title) => ({ title }));

test("every template service refuses while projects are off", async () => {
  const db = await setup({ projects: false });
  const off = /Projects are off/;
  await assert.rejects(addTemplate(ctxFor(db), { name: "Launch" }), off);
  await assert.rejects(updateTemplate(ctxFor(db), "tp_aaaaaaaaaaaa", { name: "x" }), off);
  await assert.rejects(addTemplateTask(ctxFor(db), "tp_aaaaaaaaaaaa", { title: "x" }), off);
  await assert.rejects(updateTemplateTask(ctxFor(db), "tt_aaaaaaaaaaaa", { title: "x" }), off);
  await assert.rejects(moveTemplateTask(ctxFor(db), "tt_aaaaaaaaaaaa", "up"), off);
  await assert.rejects(archiveTemplateTask(ctxFor(db), "tt_aaaaaaaaaaaa"), off);
  await assert.rejects(duplicateTemplate(ctxFor(db), "tp_aaaaaaaaaaaa"), off);
});

test("addTemplate writes the template and its flat task list as a tree in one change, and undo removes it", async () => {
  const db = await setup();
  const result = await addTemplate(ctxFor(db), {
    name: "Website launch",
    description: "Standard steps",
    tasks: [{ title: "Plan", dueDays: 0 }, { title: "Draft", under: 1, dueDays: 7 }, { title: "Review", under: 1 }, { title: "Ship", dueDays: 30 }],
  });
  assert.match(result.templateId, /^tp_[a-z2-7]{12}$/);
  assert.match(result.taskIds[0] ?? "", /^tt_[a-z2-7]{12}$/);
  assert.equal(result.summary, `Added template "Website launch" with 4 tasks (change ${result.changeId})`);
  assert.deepEqual(await outline(db, result.templateId), ["Plan", "-Draft", "-Review", "Ship"]);
  const draft = await db.prepare("SELECT due_days, position FROM template_tasks WHERE id = ?").bind(result.taskIds[1]).first();
  assert.deepEqual({ ...draft }, { due_days: 7, position: 1 });

  await undoChange(ctxFor(db, "undo_change"), result.changeId);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM project_templates").first<number>("n")), 0);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM template_tasks").first<number>("n")), 0);
});

test("addTemplate refuses a bad tree, a bad due days and over 100 tasks", async () => {
  const db = await setup();
  await assert.rejects(addTemplate(ctxFor(db), { name: "A", tasks: [{ title: "x", under: 1 }] }), /under must name an earlier task/);
  await assert.rejects(addTemplate(ctxFor(db), { name: "A", tasks: [{ title: "x", dueDays: 3651 }] }), /dueDays/);
  await assert.rejects(addTemplate(ctxFor(db), { name: "A", tasks: [{ title: "x", dueDays: -1 }] }), /dueDays/);
  await assert.rejects(addTemplate(ctxFor(db), { name: "A\nB" }), /one line/);
  const many = Array.from({ length: 101 }, (_, i) => ({ title: `t${i}` }));
  await assert.rejects(addTemplate(ctxFor(db), { name: "Big", tasks: many }), /at most 100 tasks/);
  assert.equal(await db.prepare("SELECT count(*) AS n FROM project_templates").first<number>("n"), 0);
});

test("a live template name is unique ignoring case; an archived name can be reused, and restoring checks it", async () => {
  const db = await setup();
  const first = await addTemplate(ctxFor(db), { name: "Launch" });
  await assert.rejects(addTemplate(ctxFor(db), { name: "launch" }), /already a template called "launch"/);
  const other = await addTemplate(ctxFor(db), { name: "Audit" });
  await assert.rejects(updateTemplate(ctxFor(db), other.templateId, { name: "LAUNCH" }), /already a template/);
  await updateTemplate(ctxFor(db), first.templateId, { archived: true });
  const again = await addTemplate(ctxFor(db), { name: "Launch" });
  await assert.rejects(updateTemplate(ctxFor(db), first.templateId, { archived: false }), /already a template/);
  const renamed = await updateTemplate(ctxFor(db), "Launch", { name: "Launch v2", description: "New" });
  assert.equal(renamed.templateId, again.templateId);
  assert.match(renamed.summary, /^Updated template "Launch v2": renamed from "Launch", description changed/);
  await assert.rejects(updateTemplate(ctxFor(db), again.templateId, { name: "Launch v2" }), /Nothing to change/);
});

test("a template holds at most 100 live tasks; archiving makes room", async () => {
  const db = await setup();
  const made = await addTemplate(ctxFor(db), { name: "Full", tasks: Array.from({ length: 100 }, (_, i) => ({ title: `t${i}` })) });
  await assert.rejects(addTemplateTask(ctxFor(db), made.templateId, { title: "one more" }), /at most 100 tasks/);
  await archiveTemplateTask(ctxFor(db), made.taskIds[0] ?? "");
  const added = await addTemplateTask(ctxFor(db), made.templateId, { title: "one more" });
  assert.equal((await outline(db, made.templateId)).at(-1), "one more");
  assert.ok(added.taskId);
});

test("addTemplateTask appends last among its siblings, at the top or under a parent", async () => {
  const db = await setup();
  const made = await addTemplate(ctxFor(db), { name: "T", tasks: [{ title: "A" }, { title: "B", under: 1 }] });
  await addTemplateTask(ctxFor(db), "T", { title: "C" });
  await addTemplateTask(ctxFor(db), made.templateId, { title: "D", parent: made.taskIds[0] ?? "" });
  assert.deepEqual(await outline(db, made.templateId), ["A", "-B", "-D", "C"]);
  await assert.rejects(addTemplateTask(ctxFor(db), made.templateId, { title: "E", parent: "tt_nothere" }), /No task "tt_nothere"/);
});

test("updateTemplateTask sets and clears due days and the work type; a work type needs time tracking", async () => {
  const db = await setup();
  const made = await addTemplate(ctxFor(db), { name: "T", tasks: [{ title: "A", dueDays: 3 }] });
  const id = made.taskIds[0] ?? "";
  await assert.rejects(updateTemplateTask(ctxFor(db), id, { workType: "Design" }), /Time tracking is off/);
  const cleared = await updateTemplateTask(ctxFor(db), id, { dueDays: null, title: "A2" });
  assert.match(cleared.summary, /^Updated "A2" in template "T": renamed from "A", no due date/);
  await assert.rejects(updateTemplateTask(ctxFor(db), id, { dueDays: 4000 }), /dueDays/);

  await db.prepare("UPDATE settings SET time_tracking = 1").run();
  const wt = await addWorkType(ctxFor(db, "add_work_type"), { name: "Design" });
  await updateTemplateTask(ctxFor(db), id, { workType: "Design" });
  assert.equal(await db.prepare("SELECT work_type_id FROM template_tasks WHERE id = ?").bind(id).first("work_type_id"), wt.workTypeId);
  await updateTemplateTask(ctxFor(db), id, { workType: null });
  assert.equal(await db.prepare("SELECT work_type_id FROM template_tasks WHERE id = ?").bind(id).first("work_type_id"), null);
  await assert.rejects(updateTemplateTask(ctxFor(db), id, { workType: "Nope" }), /no work type/i);
});

test("a work type with a template task pointing at it cannot be undone away", async () => {
  const db = await setup({ time: true });
  const wt = await addWorkType(ctxFor(db, "add_work_type"), { name: "Design" });
  const made = await addTemplate(ctxFor(db), { name: "T", tasks: [{ title: "A", workType: wt.workTypeId }] });
  await assert.rejects(undoChange(ctxFor(db, "undo_change"), wt.changeId), /template task/);
  await undoChange(ctxFor(db, "undo_change"), made.changeId);
  await undoChange(ctxFor(db, "undo_change"), wt.changeId);
});

test("moveTemplateTask up and down swap siblings and refuse at the edges", async () => {
  const db = await setup();
  const made = await addTemplate(ctxFor(db), { name: "T", tasks: names("A", "B", "C") });
  const [a = "", b = "", c = ""] = made.taskIds;
  await assert.rejects(moveTemplateTask(ctxFor(db), a, "up"), /already first/);
  await assert.rejects(moveTemplateTask(ctxFor(db), c, "down"), /already last/);
  await moveTemplateTask(ctxFor(db), b, "up");
  assert.deepEqual(await outline(db, made.templateId), ["B", "A", "C"]);
  await moveTemplateTask(ctxFor(db), b, "down");
  assert.deepEqual(await outline(db, made.templateId), ["A", "B", "C"]);
});

test("moveTemplateTask in goes last under the task above; out goes right after its parent", async () => {
  const db = await setup();
  const made = await addTemplate(ctxFor(db), {
    name: "T",
    tasks: [{ title: "A" }, { title: "A1", under: 1 }, { title: "B" }, { title: "C" }],
  });
  const [a = "", a1 = "", b = "", c = ""] = made.taskIds;
  await assert.rejects(moveTemplateTask(ctxFor(db), a, "in"), /no task above/);
  await assert.rejects(moveTemplateTask(ctxFor(db), a, "out"), /already at the top level/);
  const moved = await moveTemplateTask(ctxFor(db), b, "in");
  assert.match(moved.summary, /^Moved "B" under "A"/);
  assert.deepEqual(await outline(db, made.templateId), ["A", "-A1", "-B", "C"]);
  await moveTemplateTask(ctxFor(db), a1, "out");
  assert.deepEqual(await outline(db, made.templateId), ["A", "-B", "A1", "C"]);
  await moveTemplateTask(ctxFor(db), b, "out");
  assert.deepEqual(await outline(db, made.templateId), ["A", "B", "A1", "C"]);
  assert.ok(c);
});

test("moveTemplateTask in refuses when the task and its sub-tree would end deeper than level 3", async () => {
  const db = await setup();
  const made = await addTemplate(ctxFor(db), {
    name: "T",
    tasks: [{ title: "A" }, { title: "A1", under: 1 }, { title: "B" }, { title: "B1", under: 3 }, { title: "B11", under: 4 }],
  });
  const [, a1 = "", b = ""] = made.taskIds;
  // B (with B1 and B11, three levels) under A would make B11 level 4.
  await assert.rejects(moveTemplateTask(ctxFor(db), b, "in"), /three levels deep/);
  assert.deepEqual(await outline(db, made.templateId), ["A", "-A1", "B", "-B1", "--B11"]);
  assert.ok(a1);
});

test("a template task keeps its description", async () => {
  const db = await setup();
  const made = await addTemplate(ctxFor(db), { name: "T", tasks: [{ title: "A", description: "  Do this.\nThen that.  " }] });
  assert.equal(await db.prepare("SELECT description FROM template_tasks WHERE id = ?").bind(made.taskIds[0]).first("description"), "Do this.\nThen that.");
});

test("a move is one change and undo puts the tree back", async () => {
  const db = await setup();
  const made = await addTemplate(ctxFor(db), { name: "T", tasks: [{ title: "A" }, { title: "A1", under: 1 }, { title: "B" }, { title: "C" }] });
  const out = await moveTemplateTask(ctxFor(db), made.taskIds[1] ?? "", "out");
  assert.deepEqual(await outline(db, made.templateId), ["A", "A1", "B", "C"]);
  await undoChange(ctxFor(db, "undo_change"), out.changeId);
  assert.deepEqual(await outline(db, made.templateId), ["A", "-A1", "B", "C"]);
});

test("archiveTemplateTask archives the task and its whole subtree in one change, undone together", async () => {
  const db = await setup();
  const made = await addTemplate(ctxFor(db), {
    name: "T",
    tasks: [{ title: "A" }, { title: "A1", under: 1 }, { title: "A1a", under: 2 }, { title: "B" }],
  });
  const result = await archiveTemplateTask(ctxFor(db), made.taskIds[0] ?? "");
  assert.equal(result.summary, `Archived "A" and 2 tasks under it from template "T" (change ${result.changeId})`);
  assert.deepEqual(await outline(db, made.templateId), ["B"]);
  await undoChange(ctxFor(db, "undo_change"), result.changeId);
  assert.deepEqual(await outline(db, made.templateId), ["A", "-A1", "--A1a", "B"]);
});

test("duplicateTemplate copies the live tree under a unique name", async () => {
  const db = await setup();
  const made = await addTemplate(ctxFor(db), { name: "Launch", description: "Steps", tasks: [{ title: "A", dueDays: 2 }, { title: "A1", under: 1 }, { title: "Gone" }] });
  await archiveTemplateTask(ctxFor(db), made.taskIds[2] ?? "");
  const copy = await duplicateTemplate(ctxFor(db), "Launch");
  const second = await duplicateTemplate(ctxFor(db), made.templateId);
  assert.equal((await db.prepare("SELECT name FROM project_templates WHERE id = ?").bind(copy.templateId).first("name")), "Launch (copy)");
  assert.equal((await db.prepare("SELECT name FROM project_templates WHERE id = ?").bind(second.templateId).first("name")), "Launch (copy 2)");
  assert.deepEqual(await outline(db, copy.templateId), ["A", "-A1"]);
  assert.equal(copy.taskIds.length, 2);
  assert.ok(copy.taskIds.every((id) => !made.taskIds.includes(id)));
  const row = await db.prepare("SELECT description FROM project_templates WHERE id = ?").bind(copy.templateId).first("description");
  assert.equal(row, "Steps");
  const named = await duplicateTemplate(ctxFor(db), made.templateId, "Fresh");
  assert.match(named.summary, /^Copied template "Launch" as template "Fresh" with 2 tasks/);
  await assert.rejects(duplicateTemplate(ctxFor(db), made.templateId, "launch"), /already a template/);
});

test("a template with tasks cannot lose its template while tasks remain, and a parent keeps its child", async () => {
  const db = await setup();
  const made = await addTemplate(ctxFor(db), { name: "T" });
  const parent = await addTemplateTask(ctxFor(db), made.templateId, { title: "A" });
  const child = await addTemplateTask(ctxFor(db), made.templateId, { title: "A1", parent: parent.taskId });
  await assert.rejects(undoChange(ctxFor(db, "undo_change"), made.changeId), /template task/);
  await assert.rejects(undoChange(ctxFor(db, "undo_change"), parent.changeId), /sub-task/);
  await undoChange(ctxFor(db, "undo_change"), child.changeId);
  await undoChange(ctxFor(db, "undo_change"), parent.changeId);
  await undoChange(ctxFor(db, "undo_change"), made.changeId);
});

test("a timer started on a task defaults to the task's work type, unless one is given", async () => {
  const db = await setup({ time: true });
  const design = await addWorkType(ctxFor(db, "add_work_type"), { name: "Design" });
  await addWorkType(ctxFor(db, "add_work_type"), { name: "Build" });
  await db.prepare("INSERT INTO tasks (id, title, work_type_id) VALUES ('tk_wt', 'Mockups', ?)").bind(design.workTypeId).run();
  const started = await startTimer(ctxFor(db, "start_timer"), { task: "tk_wt" });
  assert.equal(await db.prepare("SELECT work_type_id FROM time_entries WHERE id = ?").bind(started.entryId).first("work_type_id"), design.workTypeId);
  await db.prepare("DELETE FROM time_entries").run();
  const given = await startTimer(ctxFor(db, "start_timer"), { task: "tk_wt", workType: "Build" });
  const build = await db.prepare("SELECT work_type_id FROM time_entries WHERE id = ?").bind(given.entryId).first<string>("work_type_id");
  assert.notEqual(build, design.workTypeId);
});

test("undo of an archive or rename is refused plainly when a live template has the name now", async () => {
  const db = await setup();
  const first = await addTemplate(ctxFor(db), { name: "Launch" });
  const archived = await updateTemplate(ctxFor(db), first.templateId, { archived: true });
  await addTemplate(ctxFor(db), { name: "launch" });
  await assert.rejects(undoChange(ctxFor(db, "undo_change"), archived.changeId), /a template it would restore has the same name now\. Rename that one first/);

  const other = await addTemplate(ctxFor(db), { name: "Audit" });
  const renamed = await updateTemplate(ctxFor(db), other.templateId, { name: "Review" });
  await addTemplate(ctxFor(db), { name: "audit" });
  await assert.rejects(undoChange(ctxFor(db, "undo_change"), renamed.changeId), /a template it would restore has the same name now/);
});

test("a lost race on the live name is the same refusal as the name check", async () => {
  const db = await setup();
  const rival = () => addTemplate(ctxFor(db), { name: "Launch" });
  await assert.rejects(addTemplate(ctxFor(racing(db, rival)), { name: "launch" }), /already a template called "launch"/);

  const mine = await addTemplate(ctxFor(db), { name: "Audit" });
  const rival2 = () => addTemplate(ctxFor(db), { name: "Review" });
  await assert.rejects(updateTemplate(ctxFor(racing(db, rival2)), mine.templateId, { name: "review" }), /already a template called "review"/);
});

test("a 100-task template of long titles is one bulk change that undoes whole", async () => {
  const db = await setup();
  const tasks = Array.from({ length: 100 }, (_, i) => ({ title: `${i}`.padEnd(200, "x"), dueDays: 5 }));
  const made = await addTemplate(ctxFor(db), { name: "Big", tasks });
  assert.ok(((await db.prepare("SELECT parts FROM audit_log WHERE id = ?").bind(made.changeId).first<number>("parts")) ?? 0) > 0);
  const copy = await duplicateTemplate(ctxFor(db), "Big");
  assert.equal(copy.taskIds.length, 100);
  const archived = await archiveTemplateTask(ctxFor(db), made.taskIds[0] ?? "");
  assert.equal(archived.archivedIds.length, 1);
  await undoChange(ctxFor(db, "undo_change"), copy.changeId);
  assert.equal(await db.prepare("SELECT count(*) AS n FROM template_tasks").first<number>("n"), 100);
});

test("a work type named by many tasks is looked up once", async () => {
  const db = await setup({ time: true });
  await addWorkType(ctxFor(db, "add_work_type"), { name: "Design" });
  let reads = 0;
  const counting = { ...db, prepare: (sql: string) => { if (sql.includes("work_types")) reads++; return db.prepare(sql); }, batch: db.batch.bind(db) } as Db;
  await addTemplate(ctxFor(counting), { name: "T", tasks: Array.from({ length: 30 }, (_, i) => ({ title: `t${i}`, workType: "Design" })) });
  assert.ok(reads < 10, `work_types read ${reads} times`);
});
