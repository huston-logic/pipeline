import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditRow, Db, DealRow } from "../db/db.ts";
import { racing } from "../../tests/helpers/race-db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import { logActivity } from "./activities.ts";
import type { Ctx } from "./change.ts";
import { updateDeal } from "./deals.ts";
import { UserError } from "./errors.ts";
import { addDeal } from "./add-deal.ts";
import { updateContact } from "./contacts.ts";
import { addTask } from "./tasks.ts";
import { undoChange, undoRemovals } from "./undo.ts";

const CREATED = new Date("2026-11-16T18:00:00.000Z");
const NOW = new Date("2026-11-19T18:00:00.000Z");
const LATER = new Date("2026-11-19T19:00:00.000Z");
const ctxAt = (db: Db, now: Date, tool: string): Ctx => ({ db, now, actor: "ai", tool });
const undoCtx = (db: Db) => ctxAt(db, LATER, "undo_change");

async function setup() {
  const db = await openTestDb();
  const lead = await addDeal(ctxAt(db, CREATED, "add_deal"), {
    name: "Pat Example",
    email: "pat@example.com",
    dealTitle: "Website refresh",
  });
  return { db, ...lead };
}

const deal = async (db: Db, id: string) => db.prepare("SELECT * FROM deals WHERE id = ?").bind(id).first<DealRow>();
const audit = async (db: Db, id: string) => db.prepare("SELECT * FROM audit_log WHERE id = ?").bind(id).first<AuditRow>();
const count = async (db: Db, table: string) =>
  (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? -1;

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => assert.fail("expected the undo to be refused"),
    (e: unknown) => e,
  );
  assert.ok(error instanceof UserError, `expected a UserError, got ${String(error)}`);
  return error.message;
}

test("undo of an update restores the row and logs an undo_change entry pointing at it", async () => {
  const { db, dealId } = await setup();
  await updateDeal(ctxAt(db, CREATED, "update_deal"), dealId, { stage: "replied" });
  const original = await deal(db, dealId);
  const move = await updateDeal(ctxAt(db, NOW, "update_deal"), dealId, { stage: "call_booked", nextStep: "Call" });
  const stageChangesBefore = await count(db, "activities");

  const result = await undoChange(undoCtx(db), move.changeId);

  assert.equal(
    result.summary,
    `Undid ${move.changeId}: Moved "Website refresh" back to Replied; put back the earlier next step on ` +
      `deal "Website refresh" (change ${result.changeId})`,
  );
  const restored = await deal(db, dealId);
  assert.ok(original && restored);
  assert.deepEqual(
    { ...restored, version: 0, updated_at: "" },
    { ...original, version: 0, updated_at: "" },
    "every column is back to its earlier value",
  );
  assert.equal(restored.version, original.version + 2);
  assert.equal(restored.updated_at, LATER.toISOString());
  assert.equal(await count(db, "activities"), stageChangesBefore - 1, "the stage_change activity is removed");

  const undoRow = await audit(db, result.changeId);
  assert.ok(undoRow);
  assert.equal(undoRow.tool, "undo_change");
  assert.equal(undoRow.undo_of, move.changeId);
  assert.equal(undoRow.target_table, "deals");
  assert.equal(undoRow.target_id, dealId);
  assert.equal(undoRow.at, LATER.toISOString());
  const undone = await audit(db, move.changeId);
  assert.equal(undone?.undone_at, LATER.toISOString());
  assert.equal(undone?.undone_by, result.changeId);
  assert.equal(await count(db, "write_guard"), 0);
});

test("a second undo of the same change is refused", async () => {
  const { db, dealId } = await setup();
  const move = await updateDeal(ctxAt(db, NOW, "update_deal"), dealId, { stage: "replied" });
  const first = await undoChange(undoCtx(db), move.changeId);
  assert.equal(first.summary, `Undid ${move.changeId}: Moved "Website refresh" back to New inquiry (change ${first.changeId})`);
  const message = await refusal(undoChange(undoCtx(db), move.changeId));
  assert.equal(message, `${move.changeId} was already undone (by ${first.changeId}). Nothing to do.`);
});

test("undo after a later edit to the same row is refused", async () => {
  const { db, dealId } = await setup();
  const move = await updateDeal(ctxAt(db, NOW, "update_deal"), dealId, { stage: "replied" });
  await updateDeal(ctxAt(db, NOW, "update_deal"), dealId, { nextStep: "Send times" });
  const message = await refusal(undoChange(undoCtx(db), move.changeId));
  assert.match(message, /^Can't undo chg_[a-z2-7]{12}: deal "Website refresh" changed since\b/);
  assert.match(message, /recent_changes/);
  assert.equal((await deal(db, dealId))?.stage_key, "replied");
  assert.equal((await audit(db, move.changeId))?.undone_at, null);
});

test("undo of add_deal after an activity was logged on the deal refuses in plain English (Review Focus 3)", async () => {
  const { db, changeId, dealId } = await setup();
  await logActivity(ctxAt(db, NOW, "log_activity"), { dealId, type: "call", summary: "Intro call." });
  const message = await refusal(undoChange(undoCtx(db), changeId));
  assert.equal(
    message,
    `Can't undo ${changeId}: other records now depend on it (1 activity). Change those first, or leave it.`,
  );
  assert.doesNotMatch(message, /FOREIGN KEY|constraint|D1_/);
  assert.equal(await count(db, "contacts"), 1);
  assert.equal(await count(db, "deals"), 1);
  assert.equal(await count(db, "audit_log"), 2);
});

test("undo of add_deal after a task was added counts the task too", async () => {
  const { db, changeId, dealId, contactId } = await setup();
  await addTask(ctxAt(db, NOW, "add_task"), { dealId, title: "Call back" });
  await addTask(ctxAt(db, NOW, "add_task"), { contactId, title: "Find card" });
  const message = await refusal(undoChange(undoCtx(db), changeId));
  assert.match(message, /other records now depend on it \(2 tasks\)/);
});

test("undo of add_deal with nothing added since removes the contact, the deal and the note", async () => {
  const db = await openTestDb();
  const lead = await addDeal(ctxAt(db, CREATED, "add_deal"), {
    name: "Robin Sample",
    dealTitle: "Bakery site",
    notes: "Wants a menu page.",
  });
  const result = await undoChange(undoCtx(db), lead.changeId);
  assert.equal(
    result.summary,
    `Undid ${lead.changeId}: Removed contact Robin Sample, deal "Bakery site" and the note "Wants a menu page." ` +
      `(change ${result.changeId})`,
  );
  assert.equal(await count(db, "contacts"), 0);
  assert.equal(await count(db, "deals"), 0);
  assert.equal(await count(db, "activities"), 0);
});

test("undo of add_deal that matched an existing contact keeps the contact", async () => {
  const { db, contactId } = await setup();
  const second = await addDeal(ctxAt(db, NOW, "add_deal"), { name: "Pat Example", email: "pat@example.com", dealTitle: "Logo" });
  await undoChange(undoCtx(db), second.changeId);
  assert.equal(await count(db, "deals"), 1);
  assert.equal((await db.prepare("SELECT id FROM contacts").first("id")), contactId);
});

test("undo of updateContact puts back the earlier values", async () => {
  const { db, contactId } = await setup();
  const edit = await updateContact(ctxAt(db, NOW, "update_contact"), contactId, { phone: "555-0101", business: "Plumbing" });
  const result = await undoChange(undoCtx(db), edit.changeId);
  assert.match(result.summary, /^Undid chg_[a-z2-7]{12}: Put back the earlier phone and business on contact Pat Example \(change/);
  const row = await db.prepare("SELECT phone, business FROM contacts").first();
  assert.deepEqual(row, { phone: null, business: null });
});

test("an undo can't itself be undone, and an unknown id is refused", async () => {
  const { db, dealId } = await setup();
  const move = await updateDeal(ctxAt(db, NOW, "update_deal"), dealId, { stage: "replied" });
  const undo = await undoChange(undoCtx(db), move.changeId);
  assert.equal(await refusal(undoChange(undoCtx(db), undo.changeId)), "Undo entries can't be undone; make the change again instead.");
  assert.equal(
    await refusal(undoChange(undoCtx(db), "chg_aaaaaaaaaaaa")),
    "There's no change chg_aaaaaaaaaaaa. Use recent_changes to find the change id.",
  );
});

test("a foreign-key failure inside the undo batch becomes the plain-English refusal", async () => {
  const { db, changeId } = await setup();
  const failing: Db = {
    prepare: (sql: string) => db.prepare(sql),
    batch: async () => {
      throw new Error("D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT");
    },
  };
  const message = await refusal(undoChange(undoCtx(failing), changeId));
  assert.equal(message, `Can't undo ${changeId}: other records now depend on it (records added since). Change those first, or leave it.`);
});

test("when another undo wins the race, the slower one is told the change was already undone", async () => {
  const { db, dealId } = await setup();
  const move = await updateDeal(ctxAt(db, NOW, "update_deal"), dealId, { stage: "replied" });
  const rival = racing(db, () => undoChange(undoCtx(db), move.changeId));

  const message = await refusal(undoChange(undoCtx(rival), move.changeId));

  assert.match(message, new RegExp(`^${move.changeId} was already undone \\(by chg_[a-z2-7]{12}\\)\\. Nothing to do\\.$`));
  assert.equal((await deal(db, dealId))?.stage_key, "new_inquiry", "restored once, not twice");
});

test("undoRemovals counts the records an undo would remove; a move's own stage-change entry doesn't count", async () => {
  const { db, changeId, dealId } = await setup();
  assert.deepEqual(await undoRemovals(db, changeId), [
    { table: "contacts", count: 1 },
    { table: "deals", count: 1 },
  ]);
  const task = await addTask(ctxAt(db, NOW, "add_task"), { dealId, title: "Call back" });
  assert.deepEqual(await undoRemovals(db, task.changeId), [{ table: "tasks", count: 1 }]);
  const logged = await logActivity(ctxAt(db, NOW, "log_activity"), { dealId, type: "call", summary: "Called." });
  assert.deepEqual(await undoRemovals(db, logged.changeId), [{ table: "activities", count: 1 }]);
  const moved = await updateDeal(ctxAt(db, NOW, "update_deal"), dealId, { stage: "replied" });
  assert.deepEqual(await undoRemovals(db, moved.changeId), [], "a move only puts values back");
  const edited = await updateContact(ctxAt(db, NOW, "update_contact"), "Pat Example", { phone: "555-0100" });
  assert.deepEqual(await undoRemovals(db, edited.changeId), []);
  assert.deepEqual(await undoRemovals(db, "chg_nothing0000"), []);
});
