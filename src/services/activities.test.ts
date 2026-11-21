import assert from "node:assert/strict";
import { test } from "node:test";
import { racing } from "../../tests/helpers/race-db.ts";
import type { ActivityRow, ContactRow, Db, DealRow } from "../db/db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import { logActivity } from "./activities.ts";
import { addDeal } from "./add-deal.ts";
import type { Ctx } from "./change.ts";
import { updateContact } from "./contacts.ts";
import { addLead } from "./leads.ts";
import { undoChange } from "./undo.ts";

const CREATED = new Date("2026-11-16T18:00:00.000Z");
const NOW = new Date("2026-11-19T18:00:00.000Z");
const ctxAt = (db: Db, now: Date, tool = "log_activity"): Ctx => ({ db, now, actor: "ai", tool });

async function setup() {
  const db = await openTestDb();
  const lead = await addDeal(ctxAt(db, CREATED, "add_deal"), { name: "Pat Example", dealTitle: "Website refresh" });
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
  const second = await addDeal(ctxAt(db, CREATED, "add_deal"), { name: "Pat Example", email: "pat@example.com", dealTitle: "Logo" });
  const closed = await addDeal(ctxAt(db, CREATED, "add_deal"), { name: "Pat Example", email: "pat@example.com", dealTitle: "Old job" });
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
  const other = await addDeal(ctxAt(db, CREATED, "add_deal"), { name: "Robin Sample" });
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

const person = async (db: Db, id: string) => {
  const row = await db.prepare("SELECT * FROM contacts WHERE id = ?").bind(id).first<ContactRow>();
  assert.ok(row);
  return row;
};

async function newLead(db: Db) {
  return addLead(ctxAt(db, CREATED, "add_lead"), { name: "Lee Example" });
}

test("a call on a New lead makes them Contacted in the same change, and the summary says so", async () => {
  const db = await openTestDb();
  const lead = await newLead(db);
  const result = await logActivity(ctxAt(db, NOW), { contactId: lead.contactId, type: "call", summary: "Intro call." });
  assert.equal(result.summary, `Logged a call with Lee Example: Intro call.; Lee Example is now Contacted (change ${result.changeId})`);
  const row = await person(db, lead.contactId);
  assert.equal(row.lead_status, "contacted");
  assert.equal(row.lead_status_at, NOW.toISOString());
  const audit = await db.prepare("SELECT after_json FROM audit_log WHERE id = ?").bind(result.changeId).first<{ after_json: string }>();
  assert.ok(Object.keys(JSON.parse(audit?.after_json ?? "{}")).includes(`contacts:${lead.contactId}`), "one change");

  await undoChange(ctxAt(db, NOW, "undo_change"), result.changeId);
  assert.equal((await person(db, lead.contactId)).lead_status, "new", "undo puts New back");
});

test("an email and a meeting count as reaching a New lead", async () => {
  for (const type of ["email", "meeting"] as const) {
    const db = await openTestDb();
    const lead = await newLead(db);
    await logActivity(ctxAt(db, NOW), { contactId: lead.contactId, type, summary: `A ${type}.` });
    assert.equal((await person(db, lead.contactId)).lead_status, "contacted", type);
  }
});

test("a plain note leaves a New lead as it is; a note marked as a text moves it", async () => {
  const db = await openTestDb();
  const lead = await newLead(db);
  const note = await logActivity(ctxAt(db, NOW), { contactId: lead.contactId, type: "note", summary: "Looked them up." });
  assert.doesNotMatch(note.summary, /Contacted/);
  assert.equal((await person(db, lead.contactId)).lead_status, "new");
  const noteRow = await activity(db, note.activityId);
  assert.equal(noteRow.data, null);

  const text = await logActivity(ctxAt(db, NOW), { contactId: lead.contactId, type: "note", summary: "Sent a text message.", via: "text" });
  assert.match(text.summary, /; Lee Example is now Contacted \(change/);
  assert.equal((await activity(db, text.activityId)).data, '{"via":"text"}');
  assert.equal((await person(db, lead.contactId)).lead_status, "contacted");
});

test("via is only for a note", async () => {
  const db = await openTestDb();
  const lead = await newLead(db);
  await assert.rejects(
    logActivity(ctxAt(db, NOW), { contactId: lead.contactId, type: "call", summary: "Called.", via: "text" }),
    /^UserError: Only a note can be marked as a text\./,
  );
  assert.equal((await person(db, lead.contactId)).lead_status, "new");
});

test("an email on a Contacted lead leaves the status and its time alone", async () => {
  const db = await openTestDb();
  const lead = await newLead(db);
  await updateContact(ctxAt(db, CREATED, "update_contact"), lead.contactId, { leadStatus: "contacted" });
  const before = await person(db, lead.contactId);
  const result = await logActivity(ctxAt(db, NOW), { contactId: lead.contactId, type: "email", summary: "Followed up." });
  assert.doesNotMatch(result.summary, /Contacted/);
  assert.deepEqual(await person(db, lead.contactId), before, "the contact row is not touched");
});

test("a call on a person who is not a lead leaves lead_status null (invariant 4)", async () => {
  const { db, contactId } = await setup();
  await logActivity(ctxAt(db, NOW), { contactId, type: "call", summary: "Called." });
  assert.equal((await person(db, contactId)).lead_status, null);
});

test("a call on a New lead whose row changed after it was read fails as a stale write and moves nothing (Review Focus 1)", async () => {
  const db = await openTestDb();
  const lead = await newLead(db);
  const rival = racing(db, () => updateContact(ctxAt(db, NOW, "update_contact"), lead.contactId, { phone: "555-0100" }));
  await assert.rejects(
    logActivity(ctxAt(rival, NOW), { contactId: lead.contactId, type: "call", summary: "Intro call." }),
    new RegExp(`^UserError: Contact ${lead.contactId} changed since you read it\\. Read it again and retry\\.$`),
  );
  const row = await person(db, lead.contactId);
  assert.equal(row.lead_status, "new");
  assert.equal(row.phone, "555-0100");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM activities").first<{ n: number }>())?.n, 0);
});
