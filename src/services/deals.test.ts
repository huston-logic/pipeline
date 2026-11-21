import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActivityRow, Db, DealRow } from "../db/db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import type { Ctx } from "./change.ts";
import { updateDeal } from "./deals.ts";
import { UserError } from "./errors.ts";
import { addDeal } from "./add-deal.ts";
import { returnToLead } from "./leads.ts";

const CREATED = new Date("2026-11-16T18:00:00.000Z");
const NOW = new Date("2026-11-19T18:00:00.000Z");
const ctxAt = (db: Db, now: Date, tool = "update_deal"): Ctx => ({ db, now, actor: "ai", tool });

async function setup(): Promise<{ db: Db; dealId: string; contactId: string }> {
  const db = await openTestDb();
  const lead = await addDeal(ctxAt(db, CREATED, "add_deal"), {
    name: "Pat Example",
    email: "pat@example.com",
    dealTitle: "Website refresh",
    notes: "Asked about a website.",
  });
  return { db, dealId: lead.dealId, contactId: lead.contactId };
}

const deal = async (db: Db, id: string) => {
  const row = await db.prepare("SELECT * FROM deals WHERE id = ?").bind(id).first<DealRow>();
  assert.ok(row);
  return row;
};

const stageChanges = async (db: Db) =>
  (await db.prepare("SELECT * FROM activities WHERE type = 'stage_change' ORDER BY rowid").all<ActivityRow>()).results;

test("moving a deal records a stage_change, resets stage_entered_at and leaves last_activity_at alone", async () => {
  const { db, dealId, contactId } = await setup();
  const result = await updateDeal(ctxAt(db, NOW), dealId, {
    stage: "call_booked",
    nextStep: "Call",
    nextAt: "2026-11-19T14:00",
  });

  assert.equal(
    result.summary,
    `Moved "Website refresh" (Pat Example) to Call booked; next: Call, Thu Nov 19, 2:00 PM (change ${result.changeId})`,
  );
  const row = await deal(db, dealId);
  assert.equal(row.stage_key, "call_booked");
  assert.equal(row.status, "open");
  assert.equal(row.stage_entered_at, NOW.toISOString());
  assert.equal(row.last_activity_at, CREATED.toISOString());
  assert.equal(row.next_step, "Call");
  assert.equal(row.next_at, "2026-11-19T22:00:00.000Z");
  assert.equal(row.version, 2);

  const [activity] = await stageChanges(db);
  assert.ok(activity);
  assert.equal(activity.deal_id, dealId);
  assert.equal(activity.contact_id, contactId);
  assert.deepEqual(JSON.parse(activity.data ?? ""), { from: "new_inquiry", to: "call_booked" });
  assert.equal(activity.summary, "Moved from New inquiry to Call booked.");
  assert.equal(activity.actor, "ai");
  assert.equal(activity.occurred_at, NOW.toISOString());
});

test("a stage can be named by its label, and a deal by its title or its contact's name", async () => {
  const { db, dealId } = await setup();
  await updateDeal(ctxAt(db, NOW), "website REFRESH", { stage: "replied" });
  assert.equal((await deal(db, dealId)).stage_key, "replied");
  await updateDeal(ctxAt(db, NOW), "pat example", { stage: "Call Done" });
  assert.equal((await deal(db, dealId)).stage_key, "call_done");
});

test("moving to a won, lost or not_now stage sets the status, and moving back to an open stage reopens", async () => {
  const { db, dealId } = await setup();
  const won = await updateDeal(ctxAt(db, NOW), dealId, { stage: "won" });
  assert.equal((await deal(db, dealId)).status, "won");
  assert.match(won.summary, /^Moved "Website refresh" \(Pat Example\) to Won \(change/);

  await updateDeal(ctxAt(db, NOW), dealId, { stage: "replied" });
  const row = await deal(db, dealId);
  assert.equal(row.status, "open");
  assert.equal(row.stage_key, "replied");
  assert.equal((await stageChanges(db)).length, 2);
});

test("setting a closed status moves the deal to the first stage of that kind", async () => {
  const { db, dealId } = await setup();
  await db.prepare("INSERT INTO stages (key, label, position, kind) VALUES ('lost_old', 'Lost (old)', 0, 'lost')").run();
  await db.prepare("UPDATE stages SET archived = 1 WHERE key = 'lost_old'").run();
  await updateDeal(ctxAt(db, NOW), dealId, { status: "lost" });
  const row = await deal(db, dealId);
  assert.equal(row.stage_key, "lost");
  assert.equal(row.status, "lost");
  assert.deepEqual(JSON.parse((await stageChanges(db))[0]?.data ?? ""), { from: "new_inquiry", to: "lost" });
});

test("reopening by status alone asks which open stage", async () => {
  const { db, dealId } = await setup();
  await updateDeal(ctxAt(db, NOW), dealId, { status: "not_now" });
  await assert.rejects(updateDeal(ctxAt(db, NOW), dealId, { status: "open" }), /which open stage/);
  await assert.rejects(updateDeal(ctxAt(db, NOW), dealId, { stage: "replied", status: "won" }), /Replied is an open stage/);
});

test("other fields change without a stage_change, and clearing works", async () => {
  const { db, dealId } = await setup();
  await db
    .prepare("INSERT INTO field_defs (id, entity, key, label, type) VALUES ('fd_budget00001', 'deal', 'budget', 'Budget', 'text')")
    .run();
  const result = await updateDeal(ctxAt(db, NOW), dealId, {
    title: "Website rebuild",
    value: 2000,
    fields: { budget: "2k" },
  });
  assert.equal(result.summary, `Updated "Website rebuild" (Pat Example): changed title, value and custom fields (budget) (change ${result.changeId})`);
  let row = await deal(db, dealId);
  assert.equal(row.title, "Website rebuild");
  assert.equal(row.value, 2000);
  assert.deepEqual(JSON.parse(row.fields), { budget: "2k" });
  assert.equal(row.stage_entered_at, CREATED.toISOString());
  assert.equal((await stageChanges(db)).length, 0);

  await updateDeal(ctxAt(db, NOW), dealId, { nextStep: "Send quote", nextAt: "2026-11-20" });
  const cleared = await updateDeal(ctxAt(db, NOW), dealId, { nextStep: null, nextAt: null, value: null, fields: { budget: null } });
  assert.match(cleared.summary, /next step cleared; changed value and custom fields \(budget\)/);
  row = await deal(db, dealId);
  assert.equal(row.next_step, null);
  assert.equal(row.next_at, null);
  assert.equal(row.value, null);
  assert.deepEqual(JSON.parse(row.fields), {});
});

test("updateDeal refuses unknown stages, unknown fields, unknown deals and no-ops in plain English", async () => {
  const { db, dealId } = await setup();
  await assert.rejects(updateDeal(ctxAt(db, NOW), dealId, { stage: "Negotiating" }), (error: unknown) => {
    assert.ok(error instanceof UserError);
    assert.match(error.message, /There's no stage "Negotiating"/);
    assert.match(error.message, /New inquiry \(new_inquiry\)/);
    return true;
  });
  await assert.rejects(updateDeal(ctxAt(db, NOW), dealId, { fields: { colour: "blue" } }), /deal field "colour"/);
  await assert.rejects(updateDeal(ctxAt(db, NOW), "Nope", { stage: "replied" }), /No deal matches "Nope".*list_deals/);
  await assert.rejects(updateDeal(ctxAt(db, NOW), dealId, { stage: "new_inquiry" }), /Nothing to change/);
  await assert.rejects(updateDeal(ctxAt(db, NOW), dealId, {}), /Nothing to change/);
  await assert.rejects(updateDeal(ctxAt(db, NOW), dealId, { title: " " }), /title/);
  assert.equal((await deal(db, dealId)).version, 1);
});

test("a deal name matching several deals is refused with each deal's id", async () => {
  const { db, dealId } = await setup();
  const other = await addDeal(ctxAt(db, CREATED, "add_deal"), { name: "Pat Example", email: "pat@example.com", dealTitle: "Logo" });
  const error = await updateDeal(ctxAt(db, NOW), "Pat Example", { stage: "replied" }).catch((e: unknown) => e);
  assert.ok(error instanceof UserError);
  assert.match(error.message, /"Pat Example" matches 2 deals/);
  assert.ok(error.message.includes(dealId) && error.message.includes(other.dealId));
  assert.match(error.message, /Use the deal id/);
});

const leadStatusOf = async (db: Db, id: string) =>
  (await db.prepare("SELECT lead_status, lead_status_at FROM contacts WHERE id = ?").bind(id).first<{ lead_status: string | null; lead_status_at: string | null }>());

test("reopening a Lost deal of a Not a fit person into an open stage makes them Qualified in the same change (invariant 1)", async () => {
  const { db, dealId, contactId } = await setup();
  await updateDeal(ctxAt(db, CREATED), dealId, { status: "lost" });
  await db.prepare("UPDATE contacts SET lead_status = 'not_a_fit', lead_status_at = ? WHERE id = ?").bind(CREATED.toISOString(), contactId).run();

  const result = await updateDeal(ctxAt(db, NOW), dealId, { stage: "replied" });
  assert.equal(result.summary, `Moved "Website refresh" (Pat Example) to Replied; Pat Example is now Qualified (change ${result.changeId})`);
  assert.deepEqual({ ...(await leadStatusOf(db, contactId)) }, { lead_status: "qualified", lead_status_at: NOW.toISOString() });
  const audit = await db.prepare("SELECT after_json FROM audit_log WHERE id = ?").bind(result.changeId).first<{ after_json: string }>();
  assert.ok(Object.keys(JSON.parse(audit?.after_json ?? "{}")).includes(`contacts:${contactId}`));
});

test("moving an open deal, closing it, or reopening one for a person with no lead status leaves the contact alone", async () => {
  const { db, dealId, contactId } = await setup();
  await db.prepare("UPDATE contacts SET lead_status = 'contacted' WHERE id = ?").bind(contactId).run();
  const moved = await updateDeal(ctxAt(db, NOW), dealId, { stage: "replied" });
  assert.doesNotMatch(moved.summary, /Qualified/, "only a reopen qualifies");
  await updateDeal(ctxAt(db, NOW), dealId, { status: "lost" });
  assert.equal((await leadStatusOf(db, contactId))?.lead_status, "contacted", "closing a deal never touches the lead status");

  await db.prepare("UPDATE contacts SET lead_status = NULL WHERE id = ?").bind(contactId).run();
  const reopened = await updateDeal(ctxAt(db, NOW), dealId, { stage: "new_inquiry" });
  assert.doesNotMatch(reopened.summary, /Qualified/);
  assert.equal((await leadStatusOf(db, contactId))?.lead_status, null);
});

test("updateDeal refuses an archived deal, such as one moved back to leads, and writes nothing", async () => {
  const { db, dealId, contactId } = await setup();
  await updateDeal(ctxAt(db, CREATED), dealId, { status: "lost" });
  await returnToLead(ctxAt(db, CREATED, "return_to_lead"), { deal: dealId, status: "not_a_fit" });
  const changes = async () => (await db.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>())?.n;
  const before = { deal: await deal(db, dealId), changes: await changes() };
  await assert.rejects(
    updateDeal(ctxAt(db, NOW), dealId, { stage: "replied" }),
    /^UserError: "Website refresh" \(Pat Example\) is archived\. Undo the change that archived it to bring it back\.$/,
  );
  await assert.rejects(updateDeal(ctxAt(db, NOW), dealId, { value: 500 }), /is archived\. Undo the change that archived it/);
  assert.deepEqual(await deal(db, dealId), before.deal);
  assert.equal(await changes(), before.changes);
  assert.equal((await leadStatusOf(db, contactId))?.lead_status, "not_a_fit");
});
