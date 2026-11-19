import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditRow, Db, TaskRow } from "../db/db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import type { Ctx } from "./change.ts";
import { addLead } from "./leads.ts";
import { addTask } from "./tasks.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const ctxFor = (db: Db, tool = "add_task"): Ctx => ({ db, now: NOW, actor: "ai", tool });

async function setup() {
  const db = await openTestDb();
  const lead = await addLead(ctxFor(db, "add_lead"), { name: "Pat Example", dealTitle: "Website refresh" });
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
