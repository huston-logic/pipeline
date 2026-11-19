import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActivityRow, Db, DealRow } from "../db/db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import { logActivity } from "./activities.ts";
import type { Ctx } from "./change.ts";
import { addLead } from "./leads.ts";
import { undoChange } from "./undo.ts";

const CREATED = new Date("2026-11-16T18:00:00.000Z");
const NOW = new Date("2026-11-19T18:00:00.000Z");
const ctxAt = (db: Db, now: Date, tool = "log_activity"): Ctx => ({ db, now, actor: "ai", tool });

async function setup() {
  const db = await openTestDb();
  const lead = await addLead(ctxAt(db, CREATED, "add_lead"), { name: "Pat Example", dealTitle: "Website refresh" });
  return { db, ...lead };
}

const deal = async (db: Db, id: string) => {
  const row = await db.prepare("SELECT * FROM deals WHERE id = ?").bind(id).first<DealRow>();
  assert.ok(row);
  return row;
};

const activity = async (db: Db, id: string) => {
  const row = await db.prepare("SELECT * FROM activities WHERE id = ?").bind(id).first<ActivityRow>();
  assert.ok(row);
  return row;
};

test("logging a call on a deal adds the activity and sets the deal's last_activity_at", async () => {
  const { db, dealId, contactId } = await setup();
  const result = await logActivity(ctxAt(db, NOW), { dealId, type: "call", summary: "Short intro call.\nWants booking." });

  assert.equal(
    result.summary,
    `Logged a call on "Website refresh" (Pat Example): Short intro call. Wants booking. (change ${result.changeId})`,
  );
  const row = await activity(db, result.activityId);
  assert.equal(row.type, "call");
  assert.equal(row.summary, "Short intro call.\nWants booking.");
  assert.equal(row.deal_id, dealId);
  assert.equal(row.contact_id, contactId);
  assert.equal(row.untrusted_text, null);
  assert.equal(row.actor, "ai");
  assert.equal(row.occurred_at, NOW.toISOString());
  const updated = await deal(db, dealId);
  assert.equal(updated.last_activity_at, NOW.toISOString());
  assert.equal(updated.version, 2);
  assert.equal(updated.stage_entered_at, CREATED.toISOString());
});

test("every contact type counts; an older activity never moves last_activity_at back", async () => {
  const { db, dealId } = await setup();
  for (const type of ["form", "email", "meeting", "note"] as const) {
    await logActivity(ctxAt(db, NOW), { dealId, type, summary: `A ${type}` });
  }
  assert.equal((await deal(db, dealId)).last_activity_at, NOW.toISOString());

  const old = await logActivity(ctxAt(db, NOW), { dealId, type: "email", summary: "Old email", occurredAt: "2026-11-17" });
  assert.equal((await activity(db, old.activityId)).occurred_at, "2026-11-17T08:00:00.000Z");
  assert.equal((await deal(db, dealId)).last_activity_at, NOW.toISOString());
});

test("a contact-only activity moves last_activity_at on all of the contact's open deals, in the same change", async () => {
  const { db, dealId, contactId } = await setup();
  await db.prepare("UPDATE contacts SET email = 'pat@example.com' WHERE id = ?").bind(contactId).run();
  const second = await addLead(ctxAt(db, CREATED, "add_lead"), { name: "Pat Example", email: "pat@example.com", dealTitle: "Logo" });
  const closed = await addLead(ctxAt(db, CREATED, "add_lead"), { name: "Pat Example", email: "pat@example.com", dealTitle: "Old job" });
  await db.prepare("UPDATE deals SET status = 'lost', stage_key = 'lost' WHERE id = ?").bind(closed.dealId).run();

  const result = await logActivity(ctxAt(db, NOW), { contactId: "Pat Example", type: "email", summary: "Sent a hello." });

  assert.match(result.summary, /^Logged an email with Pat Example: Sent a hello\. \(change/);
  const row = await activity(db, result.activityId);
  assert.equal(row.deal_id, null);
  assert.equal(row.contact_id, contactId);
  assert.equal((await deal(db, dealId)).last_activity_at, NOW.toISOString());
  assert.equal((await deal(db, second.dealId)).last_activity_at, NOW.toISOString());
  assert.equal((await deal(db, closed.dealId)).last_activity_at, null, "a closed deal is left alone");
  const audit = await db.prepare("SELECT after_json FROM audit_log WHERE id = ?").bind(result.changeId).first<{ after_json: string }>();
  assert.equal(Object.keys(JSON.parse(audit?.after_json ?? "{}")).length, 3, "the activity and the two deals are one change");

  await undoChange({ ...ctxAt(db, NOW, "undo_change") }, result.changeId);
  assert.equal((await deal(db, dealId)).last_activity_at, null);
});

test("logActivity refuses stage changes, future times, mismatched contacts and missing targets", async () => {
  const { db, dealId } = await setup();
  const other = await addLead(ctxAt(db, CREATED, "add_lead"), { name: "Robin Sample" });
  await assert.rejects(logActivity(ctxAt(db, NOW), { dealId, type: "stage_change", summary: "x" }), /update_deal/);
  await assert.rejects(logActivity(ctxAt(db, NOW), { dealId, type: "system", summary: "x" }), /form, email, call, meeting, note/);
  await assert.rejects(
    logActivity(ctxAt(db, NOW), { dealId, type: "call", summary: "x", occurredAt: "2026-11-20" }),
    /future.*add_task/,
  );
  await assert.rejects(
    logActivity(ctxAt(db, NOW), { dealId, contactId: other.contactId, type: "call", summary: "x" }),
    /belongs to Pat Example, not Robin Sample/,
  );
  await assert.rejects(logActivity(ctxAt(db, NOW), { type: "call", summary: "x" }), /deal or a contact/);
  await assert.rejects(logActivity(ctxAt(db, NOW), { dealId, type: "call", summary: "  " }), /summary/);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM activities").first<{ n: number }>())?.n, 0);
});
