import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditRow, Db, TaskRow } from "../db/db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import type { Ctx } from "./change.ts";
import { addDeal } from "./add-deal.ts";
import { whatsDue } from "./read.ts";
import { addTask, completeTask, snoozeTask } from "./tasks.ts";
import { undoChange } from "./undo.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const ctxFor = (db: Db, tool = "add_task", now = NOW): Ctx => ({ db, now, actor: "ai", tool });

async function setup() {
  const db = await openTestDb();
  const lead = await addDeal(ctxFor(db, "add_deal"), { name: "Pat Example", dealTitle: "Website refresh" });
  return { db, ...lead };
}

const task = async (db: Db, id: string) => {
  const row = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<TaskRow>();
  assert.ok(row);
  return row;
};

test("addTask on a deal stores the task with its due time in the owner's timezone", async () => {
  const { db, dealId, contactId } = await setup();
  const result = await addTask(ctxFor(db), { dealId: "Website refresh", title: "Call Pat back", dueAt: "2026-11-19T14:00" });

  assert.equal(
    result.summary,
    `Added task "Call Pat back" for "Website refresh" (Pat Example), due Thu Nov 19, 2:00 PM (change ${result.changeId})`,
  );
  const row = await task(db, result.taskId);
  assert.match(row.id, /^tk_[a-z2-7]{12}$/);
  assert.equal(row.deal_id, dealId);
  assert.equal(row.contact_id, contactId);
  assert.equal(row.due_at, "2026-11-19T22:00:00.000Z");
  assert.equal(row.done_at, null);
  assert.equal(row.snoozed_until, null);
  assert.equal(row.source, "owner");

  const audit = await db.prepare("SELECT * FROM audit_log WHERE id = ?").bind(result.changeId).first<AuditRow>();
  assert.equal(audit?.tool, "add_task");
  assert.equal(audit?.target_table, "tasks");
});

test("addTask for a contact only, without a due date", async () => {
  const { db, contactId } = await setup();
  const result = await addTask(ctxFor(db), { contactId, title: "Find the business card" });
  assert.equal(result.summary, `Added task "Find the business card" for Pat Example (change ${result.changeId})`);
  const row = await task(db, result.taskId);
  assert.equal(row.deal_id, null);
  assert.equal(row.contact_id, contactId);
  assert.equal(row.due_at, null);
});

test("addTask refuses a blank title, a bad date and a missing target", async () => {
  const { db, dealId } = await setup();
  await assert.rejects(addTask(ctxFor(db), { dealId, title: " " }), /title/);
  await assert.rejects(addTask(ctxFor(db), { dealId, title: "x", dueAt: "soon" }), /YYYY-MM-DD/);
  await assert.rejects(addTask(ctxFor(db), { title: "x" }), /deal or a contact/);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM tasks").first<{ n: number }>())?.n, 0);
});

test("completeTask sets done_at, names the task and its deal, and refuses a second time", async () => {
  const { db } = await setup();
  const added = await addTask(ctxFor(db), { dealId: "Website refresh", title: "Call Pat back" });
  const later = new Date("2026-11-20T17:00:00.000Z");

  const done = await completeTask(ctxFor(db, "complete_task", later), added.taskId);

  assert.equal(done.summary, `Completed task "Call Pat back" for "Website refresh" (Pat Example) (change ${done.changeId})`);
  const row = await task(db, added.taskId);
  assert.equal(row.done_at, later.toISOString());
  assert.equal(row.version, 2);
  await assert.rejects(
    completeTask(ctxFor(db, "complete_task", later), added.taskId),
    /^UserError: Task "Call Pat back" is already done \(Fri Nov 20, 9:00 AM\)\. Nothing to do\.$/,
  );
  await assert.rejects(completeTask(ctxFor(db, "complete_task"), "tk_nothing"), /No task "tk_nothing".*whats_due/);
  await assert.rejects(completeTask(ctxFor(db, "complete_task"), " "), /Say which task/);
});

test("completeTask names an outside title by id and a contact-only task by the contact", async () => {
  const { db, contactId } = await setup();
  const added = await addTask(ctxFor(db), { contactId, title: "Reply to the form message" });
  await db.prepare("UPDATE tasks SET untrusted_fields = '[\"title\"]' WHERE id = ?").bind(added.taskId).run();
  const done = await completeTask(ctxFor(db, "complete_task"), added.taskId);
  assert.equal(done.summary, `Completed task ${added.taskId} for Pat Example (change ${done.changeId})`);
});

test("snoozeTask sets snoozed_until in the owner's timezone, must be in the future, and hides the task from whats_due until then", async () => {
  const { db } = await setup();
  const added = await addTask(ctxFor(db), { dealId: "Website refresh", title: "Call Pat back", dueAt: "2026-11-18T09:00" });
  assert.deepEqual((await whatsDue(db, NOW, "America/Los_Angeles")).overdueTasks.map((t) => t.id), [added.taskId]);

  const snoozed = await snoozeTask(ctxFor(db, "snooze_task"), added.taskId, "2026-11-20T09:00");

  assert.equal(
    snoozed.summary,
    `Snoozed task "Call Pat back" for "Website refresh" (Pat Example) until Fri Nov 20, 9:00 AM (change ${snoozed.changeId})`,
  );
  assert.equal((await task(db, added.taskId)).snoozed_until, "2026-11-20T17:00:00.000Z");
  assert.deepEqual((await whatsDue(db, NOW, "America/Los_Angeles")).overdueTasks, [], "hidden while snoozed");
  const after = new Date("2026-11-20T17:00:00.000Z");
  assert.deepEqual((await whatsDue(db, after, "America/Los_Angeles")).overdueTasks.map((t) => t.id), [added.taskId]);

  await assert.rejects(snoozeTask(ctxFor(db, "snooze_task"), added.taskId, "2026-11-19T10:00"), /in the future/);
  await assert.rejects(snoozeTask(ctxFor(db, "snooze_task"), added.taskId, "later"), /YYYY-MM-DD/);
  await assert.rejects(snoozeTask(ctxFor(db, "snooze_task"), added.taskId, "2026-11-20T09:00"), /already snoozed until/);
  await completeTask(ctxFor(db, "complete_task"), added.taskId);
  await assert.rejects(snoozeTask(ctxFor(db, "snooze_task"), added.taskId, "2026-11-22"), /already done/);
});

test("completing and snoozing a task are each undoable", async () => {
  const { db } = await setup();
  const added = await addTask(ctxFor(db), { dealId: "Website refresh", title: "Call Pat back" });
  const later = new Date("2026-11-19T19:00:00.000Z");

  const snoozed = await snoozeTask(ctxFor(db, "snooze_task"), added.taskId, "2026-11-21");
  const undoneSnooze = await undoChange(ctxFor(db, "undo_change", later), snoozed.changeId);
  assert.match(undoneSnooze.summary, /^Undid chg_[a-z2-7]{12}: Put back the earlier snooze on task "Call Pat back"/);
  assert.equal((await task(db, added.taskId)).snoozed_until, null);

  const done = await completeTask(ctxFor(db, "complete_task"), added.taskId);
  const undoneDone = await undoChange(ctxFor(db, "undo_change", later), done.changeId);
  assert.match(undoneDone.summary, /put back the earlier done date on task/i);
  assert.equal((await task(db, added.taskId)).done_at, null);
});
