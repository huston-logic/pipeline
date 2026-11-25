import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ctx } from "./change.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import { getTemplate, listTemplates } from "./template-read.ts";
import { addTemplate, archiveTemplateTask, updateTemplate } from "./templates.ts";
import { addWorkType } from "./work-types.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");

async function setup() {
  const db = await openTestDb();
  await db.prepare("UPDATE settings SET projects = 1, time_tracking = 1").run();
  const ctx = (tool: string): Ctx => ({ db, now: NOW, actor: "owner", tool });
  return { db, ctx };
}

test("listTemplates gives name, description, live task count and archived; hides archived by default", async () => {
  const { db, ctx } = await setup();
  const launch = await addTemplate(ctx("add_template"), { name: "Launch", description: "Steps", tasks: [{ title: "A" }, { title: "B" }, { title: "C" }] });
  const audit = await addTemplate(ctx("add_template"), { name: "Audit" });
  await archiveTemplateTask(ctx("archive_template_task"), launch.taskIds[2] ?? "");
  await updateTemplate(ctx("update_template"), audit.templateId, { archived: true });

  assert.deepEqual(await listTemplates(db), [{ id: launch.templateId, name: "Launch", description: "Steps", taskCount: 2, archived: false }]);
  assert.deepEqual((await listTemplates(db, { includeArchived: true })).map((t) => [t.name, t.taskCount, t.archived]), [
    ["Audit", 0, true],
    ["Launch", 2, false],
  ]);
});

test("getTemplate lists live tasks as a tree with depth, due days and work type name", async () => {
  const { db, ctx } = await setup();
  const wt = await addWorkType(ctx("add_work_type"), { name: "Design" });
  const made = await addTemplate(ctx("add_template"), {
    name: "Launch",
    tasks: [{ title: "Plan", dueDays: 0 }, { title: "Draft", under: 1, dueDays: 7, workType: "Design" }, { title: "Ship" }, { title: "Old" }],
  });
  await archiveTemplateTask(ctx("archive_template_task"), made.taskIds[3] ?? "");
  const view = await getTemplate(db, "Launch");
  assert.equal(view.id, made.templateId);
  assert.deepEqual(
    view.tasks.map((t) => [t.title, t.depth, t.dueDays, t.workType]),
    [["Plan", 0, 0, null], ["Draft", 1, 7, "Design"], ["Ship", 0, null, null]],
  );
  assert.equal(view.tasks[1]?.workTypeId, wt.workTypeId);
  await assert.rejects(getTemplate(db, "Nope"), /No template matches "Nope"/);
});

test("the reads refuse while projects are off", async () => {
  const db = await openTestDb();
  await assert.rejects(listTemplates(db), /Projects are off/);
  await assert.rejects(getTemplate(db, "x"), /Projects are off/);
});
