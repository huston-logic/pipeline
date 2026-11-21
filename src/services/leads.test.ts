import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActivityRow, AuditRow, ContactRow, Db, DealRow, TaskRow } from "../db/db.ts";
import { racing } from "../../tests/helpers/race-db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import { logActivity } from "./activities.ts";
import { addDeal } from "./add-deal.ts";
import type { Ctx } from "./change.ts";
import { UserError } from "./errors.ts";
import { addLead, qualifyLead, returnToLead } from "./leads.ts";
import { contactDetail } from "./read.ts";
import { addTask, completeTask } from "./tasks.ts";
import { undoChange } from "./undo.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const LATER = new Date("2026-11-20T18:00:00.000Z");
const ctxFor = (db: Db, tool = "add_lead"): Ctx => ({ db, now: NOW, actor: "ai", tool });
const laterCtx = (db: Db, tool: string): Ctx => ({ db, now: LATER, actor: "ai", tool });

const contacts = async (db: Db) => (await db.prepare("SELECT * FROM contacts ORDER BY rowid").all<ContactRow>()).results;
const deals = async (db: Db) => (await db.prepare("SELECT * FROM deals ORDER BY rowid").all<DealRow>()).results;
const activities = async (db: Db) =>
  (await db.prepare("SELECT * FROM activities ORDER BY rowid").all<ActivityRow>()).results;
const contactRow = async (db: Db, id: string) =>
  await db.prepare("SELECT * FROM contacts WHERE id = ?").bind(id).first<ContactRow>();
const dealRow = async (db: Db, id: string) => await db.prepare("SELECT * FROM deals WHERE id = ?").bind(id).first<DealRow>();
const taskRow = async (db: Db, id: string) => await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<TaskRow>();
const auditCount = async (db: Db) => (await db.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>())?.n;

test("addLead adds a person with status New and no deal, in one audited change", async () => {
  const db = await openTestDb();
  const result = await addLead(ctxFor(db), {
    name: "Pat Example",
    business: "Example Plumbing",
    email: "pat@example.com",
    phone: "555-0101",
    source: "trade fair",
  });
  assert.equal(result.summary, `Added lead Pat Example (New), from trade fair (change ${result.changeId})`);
  const [person] = await contacts(db);
  assert.ok(person);
  assert.equal(person.id, result.contactId);
  assert.equal(person.name, "Pat Example");
  assert.equal(person.business, "Example Plumbing");
  assert.equal(person.email, "pat@example.com");
  assert.equal(person.phone, "555-0101");
  assert.equal(person.source, "trade fair");
  assert.equal(person.lead_status, "new");
  assert.equal(person.lead_status_at, NOW.toISOString());
  assert.equal(person.untrusted_fields, "[]");
  assert.equal((await deals(db)).length, 0, "a lead has no deal");
  assert.equal((await activities(db)).length, 0);

  const audit = await db.prepare("SELECT * FROM audit_log").first<AuditRow>();
  assert.equal(audit?.tool, "add_lead");
  assert.equal(audit?.target_table, "contacts");
  assert.equal(audit?.target_id, person.id);
});

test("addLead with only a business names the lead after it; notes become a note on the person", async () => {
  const db = await openTestDb();
  const result = await addLead(ctxFor(db), { business: "  Acme Plumbing ", notes: "Saw their van on Main Street." });
  assert.equal(result.summary, `Added lead Acme Plumbing (New) (change ${result.changeId})`);
  const [person] = await contacts(db);
  assert.equal(person?.name, "Acme Plumbing");
  assert.equal(person?.business, "Acme Plumbing");
  const [note] = await activities(db);
  assert.ok(note);
  assert.equal(note.type, "note");
  assert.equal(note.summary, "Saw their van on Main Street.");
  assert.equal(note.contact_id, result.contactId);
  assert.equal(note.deal_id, null);
  assert.equal(note.actor, "ai");
});

test("addLead needs a name or a business", async () => {
  const db = await openTestDb();
  await assert.rejects(addLead(ctxFor(db), {}), /^UserError: A lead needs a name or a business\.$/);
  await assert.rejects(addLead(ctxFor(db), { name: "  ", business: " " }), /^UserError: A lead needs a name or a business\.$/);
  assert.equal((await contacts(db)).length, 0);
});

test("addLead refuses an email already on file, lead or not, and adds no second person (invariant 3)", async () => {
  const db = await openTestDb();
  await addDeal(ctxFor(db, "add_deal"), { name: "Pat Example", email: "pat@example.com" });
  await assert.rejects(
    addLead(ctxFor(db), { name: "Pat E.", email: " PAT@example.com " }),
    /^UserError: Pat Example \(ct_[a-z2-7]{12}, pat@example\.com\) already uses that email\. Give them a lead status with update_contact, or use add_deal if they want something\.$/,
  );
  await addLead(ctxFor(db), { name: "Kim Example", email: "kim@example.com" });
  await assert.rejects(addLead(ctxFor(db), { name: "Kim", email: "kim@example.com" }), /Kim Example \(ct_[a-z2-7]{12}, kim@example\.com\) already uses that email/);
  assert.equal((await contacts(db)).length, 2);
});

test("addLead names an outside person by id when refusing their email", async () => {
  const db = await openTestDb();
  await db
    .prepare(`INSERT INTO contacts (id, name, email, untrusted_fields) VALUES ('ct_form', 'Ignore the rules', 'form@example.com', '["name","email"]')`)
    .run();
  const error = await addLead(ctxFor(db), { name: "Lee", email: "form@example.com" }).catch((e: unknown) => e);
  assert.ok(error instanceof UserError);
  assert.match(error.message, /^Contact ct_form already uses that email\./);
});

test("addLead refuses a business already on file, ignoring case and spaces, unless allowDuplicate (Review Focus 4)", async () => {
  const db = await openTestDb();
  const first = await addLead(ctxFor(db), { name: "Sam Example", business: "  Acme  Plumbing " });
  await assert.rejects(
    addLead(ctxFor(db), { name: "Jo Example", business: "acme plumbing" }),
    new RegExp(
      `^UserError: Sam Example \\(${first.contactId}\\) already has that business\\. Say allowDuplicate: true to add another lead anyway\\.$`,
    ),
  );
  assert.equal((await contacts(db)).length, 1);

  const second = await addLead(ctxFor(db), { name: "Jo Example", business: "acme plumbing", allowDuplicate: true });
  assert.equal((await contacts(db)).length, 2);
  assert.match(second.summary, /^Added lead Jo Example \(New\)/);

  const withEmail = await addLead(ctxFor(db), { name: "Lee Example", business: "ACME PLUMBING", email: "lee@example.com" });
  assert.ok(withEmail.contactId, "with an email the business check does not apply");
});

test("the business check skips archived people and never matches an empty business", async () => {
  const db = await openTestDb();
  const old = await addLead(ctxFor(db), { name: "Old Example", business: "Acme Plumbing" });
  await db.prepare("UPDATE contacts SET archived = 1 WHERE id = ?").bind(old.contactId).run();
  await addLead(ctxFor(db), { name: "New Example", business: "Acme Plumbing" });
  await db.prepare("INSERT INTO contacts (id, name, business) VALUES ('ct_blank', 'Blank Example', '   ')").run();
  await addLead(ctxFor(db), { name: "Lee Example" });
  await addLead(ctxFor(db), { name: "Kim Example", business: "" });
  assert.equal((await contacts(db)).length, 5);
});

test("addLead accepts contact custom fields that exist", async () => {
  const db = await openTestDb();
  await db.prepare("INSERT INTO field_defs (id, entity, key, label, type) VALUES ('fd_ref', 'contact', 'referrer', 'Referrer', 'text')").run();
  await addLead(ctxFor(db), { name: "Lee Example", fields: { referrer: "Pat" } });
  assert.deepEqual(JSON.parse((await contacts(db))[0]?.fields ?? ""), { referrer: "Pat" });
  await assert.rejects(addLead(ctxFor(db), { name: "Kim Example", fields: { colour: "blue" } }), /contact field "colour"/);
  await assert.rejects(addLead(ctxFor(db), { name: "Kim Example", email: "not-an-email" }), /doesn't look like an email/);
});

test("undo of addLead removes the lead and their note", async () => {
  const db = await openTestDb();
  const result = await addLead(ctxFor(db), { name: "Lee Example", notes: "Met at the fair." });
  const undone = await undoChange(ctxFor(db, "undo_change"), result.changeId);
  assert.match(undone.summary, new RegExp(`^Undid ${result.changeId}: Removed contact Lee Example`));
  assert.equal((await contacts(db)).length, 0);
  assert.equal((await activities(db)).length, 0);
});

test("a duplicate email that slips in between the check and the write is a plain UserError (add_lead)", async () => {
  const db = await openTestDb();
  const rival = racing(db, async () => void (await db.prepare("INSERT INTO contacts (id, name, email) VALUES ('ct_rival', 'Rival Example', 'new@example.com')").run()));
  const error = await addLead(ctxFor(rival), { name: "Lee Example", email: "new@example.com" }).catch((e: unknown) => e);
  assert.ok(error instanceof UserError);
  assert.match(error.message, /^Another contact already uses that email: contact ct_rival\./);
});

// qualify_lead and return_to_lead (decisions 0022 and 0024).

test("qualifyLead makes the lead Qualified and adds their deal in the stage given, in one change", async () => {
  const db = await openTestDb();
  const lead = await addLead(ctxFor(db), { name: "Lee Example", source: "drove past" });
  const result = await qualifyLead(laterCtx(db, "qualify_lead"), {
    contact: lead.contactId,
    stage: "Call booked",
    value: 900,
    nextStep: "Discovery call",
    nextAt: "2026-11-24T10:00",
  });
  assert.equal(
    result.summary,
    `Qualified Lee Example; added deal "Lee Example inquiry" in Call booked; next: Discovery call, Tue Nov 24, 10:00 AM (change ${result.changeId})`,
  );
  assert.equal(result.contactId, lead.contactId);
  const person = await contactRow(db, lead.contactId);
  assert.equal(person?.lead_status, "qualified");
  assert.equal(person?.lead_status_at, LATER.toISOString());
  assert.equal(person?.source, "drove past", "the person's details stay put");

  const [deal] = await deals(db);
  assert.ok(deal);
  assert.equal(deal.id, result.dealId);
  assert.equal(deal.contact_id, lead.contactId);
  assert.equal(deal.title, "Lee Example inquiry");
  assert.equal(deal.stage_key, "call_booked");
  assert.equal(deal.status, "open");
  assert.equal(deal.value, 900);
  assert.equal(deal.next_step, "Discovery call");
  assert.equal(deal.next_at, "2026-11-24T18:00:00.000Z");
  assert.equal(deal.stage_entered_at, LATER.toISOString());
  assert.equal(deal.untrusted_fields, "[]");

  const audit = await db.prepare("SELECT * FROM audit_log WHERE id = ?").bind(result.changeId).first<AuditRow>();
  assert.equal(audit?.tool, "qualify_lead");
  assert.equal(audit?.target_table, "contacts");
  assert.deepEqual(Object.keys(JSON.parse(audit?.after_json ?? "{}")).sort(), [`contacts:${lead.contactId}`, `deals:${deal.id}`]);
});

test("qualifyLead defaults to the first open stage and the title \"<name> inquiry\"; a title given is used", async () => {
  const db = await openTestDb();
  const lee = await addLead(ctxFor(db), { name: "Lee Example" });
  const first = await qualifyLead(laterCtx(db, "qualify_lead"), { contact: "lee example" });
  assert.equal(first.summary, `Qualified Lee Example; added deal "Lee Example inquiry" in New inquiry (change ${first.changeId})`);
  assert.equal((await dealRow(db, first.dealId ?? ""))?.stage_key, "new_inquiry");
  assert.equal(first.contactId, lee.contactId);

  const kim = await addLead(ctxFor(db), { name: "Kim Example" });
  const titled = await qualifyLead(laterCtx(db, "qualify_lead"), { contact: kim.contactId, dealTitle: " Van graphics " });
  assert.match(titled.summary, /^Qualified Kim Example; added deal "Van graphics" in New inquiry \(change/);
});

test("qualifyLead with createDeal false only sets Qualified, and refuses deal details without a deal", async () => {
  const db = await openTestDb();
  const lead = await addLead(ctxFor(db), { name: "Lee Example" });
  await assert.rejects(
    qualifyLead(laterCtx(db, "qualify_lead"), { contact: lead.contactId, createDeal: false, value: 500 }),
    /^UserError: Deal details only go with a deal\. Leave out createDeal: false, or leave out the stage, title, value, next step and next date\.$/,
  );
  const result = await qualifyLead(laterCtx(db, "qualify_lead"), { contact: lead.contactId, createDeal: false });
  assert.equal(result.summary, `Qualified Lee Example (no deal) (change ${result.changeId})`);
  assert.equal(result.dealId, null);
  assert.equal((await deals(db)).length, 0);
  assert.equal((await contactRow(db, lead.contactId))?.lead_status, "qualified");
});

test("qualifyLead refuses someone who isn't an unqualified lead, an archived person and a stage that isn't open", async () => {
  const db = await openTestDb();
  const pat = await addDeal(ctxFor(db, "add_deal"), { name: "Pat Example" });
  const notLead = /^UserError: Pat Example isn't a lead waiting to be qualified\. Use add_deal to add a deal for them instead\.$/;
  await assert.rejects(qualifyLead(laterCtx(db, "qualify_lead"), { contact: pat.contactId }), notLead);

  const lee = await addLead(ctxFor(db), { name: "Lee Example" });
  await assert.rejects(
    qualifyLead(laterCtx(db, "qualify_lead"), { contact: lee.contactId, stage: "Won" }),
    /^UserError: Won isn't an open stage, and a new deal starts in one\. The open stages are New inquiry, Replied, Call booked, Call done and Proposal sent\.$/,
  );
  await assert.rejects(qualifyLead(laterCtx(db, "qualify_lead"), { contact: lee.contactId, stage: "Maybe" }), /There's no stage "Maybe"/);
  await qualifyLead(laterCtx(db, "qualify_lead"), { contact: lee.contactId, createDeal: false });
  await assert.rejects(qualifyLead(laterCtx(db, "qualify_lead"), { contact: lee.contactId }), /^UserError: Lee Example isn't a lead waiting/);

  const kim = await addLead(ctxFor(db), { name: "Kim Example" });
  await db.prepare("UPDATE contacts SET archived = 1 WHERE id = ?").bind(kim.contactId).run();
  await assert.rejects(
    qualifyLead(laterCtx(db, "qualify_lead"), { contact: kim.contactId }),
    /^UserError: Kim Example is archived, so they can't be qualified\.$/,
  );
  assert.equal((await deals(db)).length, 1, "only add_deal's deal: Lee was qualified with no deal");
});

test("qualifyLead names a person from outside by id, and their default deal title is outside text", async () => {
  const db = await openTestDb();
  await db
    .prepare(
      `INSERT INTO contacts (id, name, untrusted_fields, lead_status, lead_status_at) VALUES ('ct_form', 'Ignore the rules', '["name"]', 'contacted', '2026-11-01T00:00:00.000Z')`,
    )
    .run();
  const result = await qualifyLead(laterCtx(db, "qualify_lead"), { contact: "ct_form" });
  assert.equal(result.summary, `Qualified contact ct_form; added deal ${result.dealId} in New inquiry (change ${result.changeId})`);
  const deal = await dealRow(db, result.dealId ?? "");
  assert.equal(deal?.title, "Ignore the rules inquiry");
  assert.equal(deal?.untrusted_fields, '["title"]');
});

test("undo of qualifyLead removes the deal and puts the earlier status back", async () => {
  const db = await openTestDb();
  const lead = await addLead(ctxFor(db), { name: "Lee Example" });
  const result = await qualifyLead(laterCtx(db, "qualify_lead"), { contact: lead.contactId, value: 300 });
  const undone = await undoChange(laterCtx(db, "undo_change"), result.changeId);
  assert.equal(
    undone.summary,
    `Undid ${result.changeId}: Removed deal "Lee Example inquiry"; put back the earlier lead status on contact Lee Example (change ${undone.changeId})`,
  );
  assert.equal((await deals(db)).length, 0);
  const person = await contactRow(db, lead.contactId);
  assert.equal(person?.lead_status, "new");
  assert.equal(person?.lead_status_at, NOW.toISOString());
});

test("undo of qualifyLead after an activity on the new deal refuses in plain English and changes nothing (Review Focus 2)", async () => {
  const db = await openTestDb();
  const lead = await addLead(ctxFor(db), { name: "Lee Example" });
  const result = await qualifyLead(laterCtx(db, "qualify_lead"), { contact: lead.contactId });
  await logActivity(laterCtx(db, "log_activity"), { dealId: result.dealId ?? "", type: "call", summary: "Talked about the van." });
  await assert.rejects(
    undoChange(laterCtx(db, "undo_change"), result.changeId),
    new RegExp(
      `^UserError: Can't undo ${result.changeId}: other records now depend on it \\(1 activity\\)\\. Change those first, or leave it\\.$`,
    ),
  );
  assert.equal((await deals(db)).length, 1);
  assert.equal((await contactRow(db, lead.contactId))?.lead_status, "qualified");
});

/** A person with an open deal (no lead status), the deal's note, one open task and one done task. */
async function dealWithTasks(db: Db) {
  const added = await addDeal(ctxFor(db, "add_deal"), { name: "Kim Example", notes: "Asked about a logo." });
  const open = await addTask(ctxFor(db, "add_task"), { dealId: added.dealId, title: "Call Kim back" });
  const done = await addTask(ctxFor(db, "add_task"), { dealId: added.dealId, title: "Send the price list" });
  await completeTask(ctxFor(db, "complete_task"), done.taskId);
  return { ...added, openTaskId: open.taskId, doneTaskId: done.taskId };
}

test("returnToLead archives the deal, moves its open task to the person and makes them Contacted, in one change", async () => {
  const db = await openTestDb();
  const kim = await dealWithTasks(db);
  const changesBefore = await auditCount(db);
  const result = await returnToLead(laterCtx(db, "return_to_lead"), { deal: kim.dealId });
  assert.equal(result.summary, `Moved Kim Example back to leads (Contacted); archived deal "Kim Example inquiry" (change ${result.changeId})`);
  assert.equal(result.contactId, kim.contactId);
  assert.equal(result.dealId, kim.dealId);
  assert.equal(await auditCount(db), (changesBefore ?? 0) + 1);

  const deal = await dealRow(db, kim.dealId);
  assert.equal(deal?.archived, 1);
  assert.equal(deal?.status, "open", "the status is left as it was");
  const open = await taskRow(db, kim.openTaskId);
  assert.equal(open?.deal_id, null);
  assert.equal(open?.contact_id, kim.contactId);
  assert.equal((await taskRow(db, kim.doneTaskId))?.deal_id, kim.dealId, "done tasks stay on the deal");
  const person = await contactRow(db, kim.contactId);
  assert.equal(person?.lead_status, "contacted");
  assert.equal(person?.lead_status_at, LATER.toISOString());

  const detail = await contactDetail(db, kim.contactId, DEFAULT_TZ, LATER);
  assert.ok(detail);
  assert.deepEqual(detail.deals, [], "the archived deal leaves the person's deals");
  assert.deepEqual(detail.openTasks.map((t) => t.id), [kim.openTaskId]);
  const note = detail.timeline.find((item) => item.summary === "Asked about a logo.");
  assert.equal(note?.dealId, kim.dealId, "the deal's activities stay on the person's timeline");
  assert.equal(note?.deal?.archived, true);
});

test("returnToLead sets Not now when asked, and takes a Lost deal back without changing its status", async () => {
  const db = await openTestDb();
  const kim = await addDeal(ctxFor(db, "add_deal"), { name: "Kim Example" });
  const notNow = await returnToLead(laterCtx(db, "return_to_lead"), { deal: kim.dealId, status: "not_now" });
  assert.match(notNow.summary, /^Moved Kim Example back to leads \(Not now\); archived deal "Kim Example inquiry" \(change/);
  assert.equal((await contactRow(db, kim.contactId))?.lead_status, "not_now");

  const sam = await addDeal(ctxFor(db, "add_deal"), { name: "Sam Example" });
  await db.prepare("UPDATE deals SET status = 'lost', stage_key = 'lost' WHERE id = ?").bind(sam.dealId).run();
  await returnToLead(laterCtx(db, "return_to_lead"), { deal: sam.dealId });
  const deal = await dealRow(db, sam.dealId);
  assert.equal(deal?.archived, 1);
  assert.equal(deal?.status, "lost");
});

test("returnToLead refuses a Won deal, an archived deal, Qualified, and a person with another open deal", async () => {
  const db = await openTestDb();
  const kim = await addDeal(ctxFor(db, "add_deal"), { name: "Kim Example" });
  const second = await addDeal(ctxFor(db, "add_deal"), { contact: kim.contactId, dealTitle: "Shop sign" });
  await assert.rejects(
    returnToLead(laterCtx(db, "return_to_lead"), { deal: kim.dealId }),
    /^UserError: Kim Example has another open deal, so they can't go back to leads\. Close it first, then try again\.$/,
  );
  await assert.rejects(
    returnToLead(laterCtx(db, "return_to_lead"), { deal: kim.dealId, status: "qualified" }),
    /^UserError: Someone moved back to leads can't be Qualified\. Use one of: new, contacted, not_now, not_a_fit, bad\.$/,
  );
  await db.prepare("UPDATE deals SET status = 'won', stage_key = 'won' WHERE id = ?").bind(second.dealId).run();
  await assert.rejects(
    returnToLead(laterCtx(db, "return_to_lead"), { deal: second.dealId }),
    /^UserError: "Shop sign" is Won, so it was a real opportunity and can't go back to leads\. If it was marked Won by mistake, change its status with update_deal first\.$/,
  );

  await returnToLead(laterCtx(db, "return_to_lead"), { deal: kim.dealId });
  await assert.rejects(
    returnToLead(laterCtx(db, "return_to_lead"), { deal: kim.dealId }),
    /^UserError: "Kim Example inquiry" is archived already\. Nothing to do\.$/,
  );
});

test("returnToLead fails as a stale write when another open deal is added for the person at the same moment", async () => {
  const db = await openTestDb();
  const kim = await addDeal(ctxFor(db, "add_deal"), { name: "Kim Example" });
  const rival = racing(db, async () => {
    await db
      .prepare(
        "INSERT INTO deals (id, contact_id, title, stage_key, stage_entered_at) VALUES ('dl_rival', ?, 'Shop sign', 'new_inquiry', '2026-11-20T18:00:00.000Z')",
      )
      .bind(kim.contactId)
      .run();
  });
  await assert.rejects(returnToLead(laterCtx(rival, "return_to_lead"), { deal: kim.dealId }), /changed since you read it/);
  assert.equal((await dealRow(db, kim.dealId))?.archived, 0);
  assert.equal((await contactRow(db, kim.contactId))?.lead_status, null);
});

test("undo of returnToLead restores the deal, the task's deal link and the earlier status", async () => {
  const db = await openTestDb();
  const kim = await dealWithTasks(db);
  const result = await returnToLead(laterCtx(db, "return_to_lead"), { deal: kim.dealId });
  const undone = await undoChange(laterCtx(db, "undo_change"), result.changeId);
  assert.match(undone.summary, new RegExp(`^Undid ${result.changeId}: `));
  assert.equal((await dealRow(db, kim.dealId))?.archived, 0);
  assert.equal((await taskRow(db, kim.openTaskId))?.deal_id, kim.dealId);
  const person = await contactRow(db, kim.contactId);
  assert.equal(person?.lead_status, null);
  assert.equal(person?.lead_status_at, null);
});

test("undo of returnToLead after the person got another open deal refuses: the person changed since (Review Focus 2)", async () => {
  const db = await openTestDb();
  const kim = await addDeal(ctxFor(db, "add_deal"), { name: "Kim Example" });
  const result = await returnToLead(laterCtx(db, "return_to_lead"), { deal: kim.dealId });
  const again = await addDeal(laterCtx(db, "add_deal"), { contact: kim.contactId, dealTitle: "Shop sign" });
  assert.match(again.summary, /Kim Example is now Qualified/);
  await assert.rejects(
    undoChange(laterCtx(db, "undo_change"), result.changeId),
    new RegExp(
      `^UserError: Can't undo ${result.changeId}: contact Kim Example changed since \\(see recent_changes\\)\\. Undo the later changes first, or leave it\\.$`,
    ),
  );
  assert.equal((await dealRow(db, kim.dealId))?.archived, 1);
});
