import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContactRow, Db, PersonStatusRow, PersonSubstatusRow } from "../db/db.ts";
import { racing } from "../../tests/helpers/race-db.ts";
import { createTestDb, openTestDb } from "../db/sqlite-d1.ts";
import { logActivity } from "./activities.ts";
import { addDeal } from "./add-deal.ts";
import type { Ctx } from "./change.ts";
import { updateDeal } from "./deals.ts";
import { UserError } from "./errors.ts";
import { addLead } from "./leads.ts";
import { newPersonColumns } from "./person-move.ts";
import {
  addPersonStatus,
  addSubStatus,
  listPersonStatuses,
  personStatusPatch,
  setPersonStatus,
  updatePersonStatus,
  updateSubStatus,
} from "./person-status.ts";
import { undoChange } from "./undo.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const LATER = new Date("2026-11-20T18:00:00.000Z");
const ctxFor = (db: Db, tool = "test", now = NOW): Ctx => ({ db, now, actor: "owner", tool });

const contact = async (db: Db, id: string) => {
  const row = await db.prepare("SELECT * FROM contacts WHERE id = ?").bind(id).first<ContactRow>();
  assert.ok(row);
  return row;
};
const pair = async (db: Db, id: string) => {
  const row = await contact(db, id);
  return { person_status: row.person_status, sub_status: row.sub_status, lead_status: row.lead_status, lead_status_at: row.lead_status_at };
};
const statuses = async (db: Db) =>
  (await db.prepare("SELECT * FROM person_statuses ORDER BY archived, position").all<PersonStatusRow>()).results;
const subs = async (db: Db, status: string) =>
  (await db.prepare("SELECT * FROM person_substatuses WHERE status_key = ? ORDER BY archived, position").bind(status).all<PersonSubstatusRow>()).results;
const refusal = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.catch((e: unknown) => e);
  assert.ok(error instanceof UserError, `expected a UserError, got ${String(error)}`);
  return error.message;
};

test("personStatusPatch keeps the lead pair in step: to Lead sets it, out of Lead is Qualified, others leave it", () => {
  const at = NOW.toISOString();
  const lead = { person_status: "lead", sub_status: "new", lead_status: "new" as const };
  const plain = { person_status: "contact", sub_status: null, lead_status: null };
  const qualified = { person_status: "contact", sub_status: null, lead_status: "qualified" as const };
  assert.deepEqual(personStatusPatch(lead, { status: "lead", sub: "contacted" }, NOW), {
    person_status: "lead",
    sub_status: "contacted",
    lead_status: "contacted",
    lead_status_at: at,
  });
  assert.deepEqual(personStatusPatch(lead, { status: "partner", sub: null }, NOW), {
    person_status: "partner",
    sub_status: null,
    lead_status: "qualified",
    lead_status_at: at,
  });
  assert.deepEqual(personStatusPatch(plain, { status: "contact", sub: "client" }, NOW), { person_status: "contact", sub_status: "client" });
  assert.deepEqual(personStatusPatch(qualified, { status: "partner", sub: null }, NOW), { person_status: "partner", sub_status: null });
  assert.deepEqual(personStatusPatch(plain, { status: "lead", sub: "not_now" }, NOW), {
    person_status: "lead",
    sub_status: "not_now",
    lead_status: "not_now",
    lead_status_at: at,
  });
  // Leaving Lead for Lead with the same sub-status changes nothing of the lead pair.
  assert.deepEqual(personStatusPatch(lead, { status: "lead", sub: "new" }, NOW), { person_status: "lead", sub_status: "new" });
  assert.throws(() => personStatusPatch(plain, { status: "lead", sub: "client" }, NOW), /lead status key/);
  assert.throws(() => personStatusPatch(plain, { status: "lead", sub: null }, NOW), /lead status key/);
  assert.deepEqual(newPersonColumns({ status: "lead", sub: "new" }, NOW), {
    person_status: "lead",
    sub_status: "new",
    lead_status: "new",
    lead_status_at: at,
  });
  assert.deepEqual(newPersonColumns({ status: "partner", sub: null }, NOW), {
    person_status: "partner",
    sub_status: null,
    lead_status: null,
    lead_status_at: null,
  });
});

test("listPersonStatuses: the three seeded statuses in order, each with its sub-statuses and sub label", async () => {
  const db = await openTestDb();
  const list = await listPersonStatuses(db);
  assert.deepEqual(
    list.map((s) => [s.key, s.label, s.position, s.subLabel, s.locked, s.archived]),
    [
      ["lead", "Lead", 1, "Lead status", true, false],
      ["contact", "Contact", 2, "Contact type", true, false],
      ["partner", "Partner", 3, "Sub-status", false, false],
    ],
  );
  assert.deepEqual(list[0]?.subStatuses.map((s) => s.key), ["new", "contacted", "not_now", "not_a_fit", "bad"]);
  assert.deepEqual(list[0]?.subStatuses.map((s) => s.label), ["New", "Contacted", "Not now", "Not a fit", "Bad lead"]);
  assert.deepEqual(list[1]?.subStatuses, [{ key: "client", label: "Client", position: 1, archived: false }]);
  assert.deepEqual(list[2]?.subStatuses, []);
});

test("addPersonStatus: a slug key, a place, one audited change that undo takes back", async () => {
  const db = await openTestDb();
  const added = await addPersonStatus(ctxFor(db, "add_person_status"), { label: "Supplier", subLabel: "Supplier type", position: 2 });
  assert.equal(added.key, "supplier");
  assert.equal(added.summary, `Added person status Supplier (key supplier) at position 2 of 4 (change ${added.changeId})`);
  assert.deepEqual((await statuses(db)).map((s) => [s.key, s.position, s.sub_label]), [
    ["lead", 1, "Lead status"],
    ["supplier", 2, "Supplier type"],
    ["contact", 3, "Contact type"],
    ["partner", 4, "Sub-status"],
  ]);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM audit_log").first("n"), 1);
  assert.match(await refusal(addPersonStatus(ctxFor(db), { label: " supplier " })), /already a person status called Supplier \(supplier\)/);
  assert.match(await refusal(addPersonStatus(ctxFor(db), { label: "  " })), /needs a label/);
  assert.match(await refusal(addPersonStatus(ctxFor(db), { label: "x".repeat(61) })), /at most 60 characters/);
  assert.match(await refusal(addPersonStatus(ctxFor(db), { label: "Vendor", position: 9 })), /between 1 and 5/);

  await undoChange(ctxFor(db, "undo_change", LATER), added.changeId);
  assert.deepEqual((await statuses(db)).map((s) => [s.key, s.position]), [
    ["lead", 1],
    ["contact", 2],
    ["partner", 3],
  ]);
});

test("a status someone has can't be undone away", async () => {
  const db = await openTestDb();
  const added = await addPersonStatus(ctxFor(db), { label: "Supplier" });
  const pat = await addDeal(ctxFor(db, "add_deal"), { name: "Pat Example", email: "pat@example.com" });
  await setPersonStatus(ctxFor(db, "set_person_status"), pat.contactId, { status: "Supplier" });
  assert.match(await refusal(undoChange(ctxFor(db, "undo_change", LATER), added.changeId)), /other records now depend on it \(1 person\)/);
  const sub = await addSubStatus(ctxFor(db), "supplier", { label: "Wholesale" });
  await setPersonStatus(ctxFor(db, "set_person_status"), pat.contactId, { status: "supplier", sub: "wholesale" });
  assert.match(await refusal(undoChange(ctxFor(db, "undo_change", LATER), sub.changeId)), /other records now depend on it \(1 person\)/);
});

test("updatePersonStatus renames, relabels and moves; Lead and Contact can't be archived; a used status can't either", async () => {
  const db = await openTestDb();
  const renamed = await updatePersonStatus(ctxFor(db), "lead", { label: "Prospect", subLabel: "Prospect stage" });
  assert.equal(renamed.summary, `Renamed person status Lead to Prospect; called its sub-status field Prospect stage (change ${renamed.changeId})`);
  const lead = (await statuses(db))[0];
  assert.deepEqual([lead?.key, lead?.label, lead?.sub_label], ["lead", "Prospect", "Prospect stage"]);

  const moved = await updatePersonStatus(ctxFor(db), "Partner", { position: 1 });
  assert.equal(moved.summary, `Moved person status Partner to position 1 of 3 (change ${moved.changeId})`);
  assert.deepEqual((await statuses(db)).map((s) => s.key), ["partner", "lead", "contact"]);

  assert.match(await refusal(updatePersonStatus(ctxFor(db), "prospect", { archived: true })), /Prospect can be renamed but not archived/);
  assert.match(await refusal(updatePersonStatus(ctxFor(db), "contact", { archived: true })), /Contact can be renamed but not archived/);
  assert.match(await refusal(updatePersonStatus(ctxFor(db), "contact", { label: "prospect" })), /already a person status called Prospect/);
  assert.match(await refusal(updatePersonStatus(ctxFor(db), "contact", { label: "Contact" })), /Nothing to change on Contact/);
  assert.match(await refusal(updatePersonStatus(ctxFor(db), "nobody", { label: "X" })), /no person status "nobody". Use one of: Partner \(partner\)/);

  const pat = await addDeal(ctxFor(db, "add_deal"), { name: "Pat Example", email: "pat@example.com" });
  await setPersonStatus(ctxFor(db), pat.contactId, { status: "partner" });
  assert.match(
    await refusal(updatePersonStatus(ctxFor(db), "partner", { archived: true })),
    /^1 person has the status Partner: Pat Example\. Move them to another status first\.$/,
  );
  await setPersonStatus(ctxFor(db), pat.contactId, { status: "contact" });
  const archived = await updatePersonStatus(ctxFor(db), "partner", { archived: true });
  assert.equal(archived.summary, `Archived person status Partner (change ${archived.changeId})`);
  assert.deepEqual((await statuses(db)).map((s) => [s.key, s.position, s.archived]), [
    ["lead", 1, 0],
    ["contact", 2, 0],
    ["partner", 3, 1],
  ]);
  assert.match(await refusal(setPersonStatus(ctxFor(db), pat.contactId, { status: "partner" })), /no live person status "partner"/);
  assert.match(await refusal(updatePersonStatus(ctxFor(db), "partner", { label: "Ally" })), /is archived. Bring it back first/);
  const back = await updatePersonStatus(ctxFor(db), "partner", { archived: false, position: 1 });
  assert.equal(back.summary, `Brought back person status Partner; moved it to position 1 of 3 (change ${back.changeId})`);
  assert.deepEqual((await statuses(db)).map((s) => s.key), ["partner", "lead", "contact"]);
});

test("sub-statuses: Lead's can be renamed but not added to or archived; others can be added, renamed, moved, archived", async () => {
  const db = await openTestDb();
  const renamed = await updateSubStatus(ctxFor(db), "lead", "Bad lead", { label: "Dead end" });
  assert.equal(renamed.summary, `Renamed sub-status Bad lead of Lead to Dead end (change ${renamed.changeId})`);
  assert.deepEqual((await subs(db, "lead")).map((s) => [s.id, s.key, s.label]).at(-1), ["lead.bad", "bad", "Dead end"]);
  assert.match(await refusal(addSubStatus(ctxFor(db), "lead", { label: "Warm" })), /Lead's sub-statuses are fixed/);
  assert.match(await refusal(updateSubStatus(ctxFor(db), "lead", "new", { archived: true })), /New can be renamed but not archived/);

  const added = await addSubStatus(ctxFor(db), "partner", { label: "Referral partner" });
  assert.equal(added.key, "referral_partner");
  assert.equal(added.summary, `Added sub-status Referral partner (key referral_partner) to Partner (change ${added.changeId})`);
  await addSubStatus(ctxFor(db), "Partner", { label: "Supplier" });
  assert.match(await refusal(addSubStatus(ctxFor(db), "partner", { label: "supplier" })), /already a sub-status of Partner called Supplier/);
  const moved = await updateSubStatus(ctxFor(db), "partner", "supplier", { position: 1 });
  assert.equal(moved.summary, `Moved sub-status Supplier of Partner to position 1 of 2 (change ${moved.changeId})`);
  assert.deepEqual((await subs(db, "partner")).map((s) => [s.id, s.position]), [
    ["partner.supplier", 1],
    ["partner.referral_partner", 2],
  ]);

  const pat = await addDeal(ctxFor(db, "add_deal"), { name: "Pat Example", email: "pat@example.com" });
  await setPersonStatus(ctxFor(db), pat.contactId, { status: "contact", sub: "Client" });
  assert.match(
    await refusal(updateSubStatus(ctxFor(db), "contact", "client", { archived: true })),
    /^1 person has the sub-status Client: Pat Example\. Give them another one first\.$/,
  );
  await setPersonStatus(ctxFor(db), pat.contactId, { status: "contact", sub: null });
  const client = await updateSubStatus(ctxFor(db), "contact", "client", { label: "Customer", archived: true });
  assert.equal(client.summary, `Renamed sub-status Client of Contact to Customer; archived it (change ${client.changeId})`);
  assert.match(await refusal(setPersonStatus(ctxFor(db), pat.contactId, { status: "contact", sub: "customer" })), /Contact has no sub-statuses\. Leave the sub-status out\./);
});

test("setPersonStatus moves a person and keeps the lead pair in step; undo puts both back", async () => {
  const db = await openTestDb();
  const lee = await addLead(ctxFor(db, "add_lead"), { name: "Lee Example", email: "lee@example.com" });
  const toPartner = await setPersonStatus(ctxFor(db, "set_person_status", LATER), lee.contactId, { status: "Partner" });
  assert.equal(toPartner.summary, `Moved Lee Example to Partner (change ${toPartner.changeId})`);
  assert.deepEqual(await pair(db, lee.contactId), {
    person_status: "partner",
    sub_status: null,
    lead_status: "qualified",
    lead_status_at: LATER.toISOString(),
  });
  const toLead = await setPersonStatus(ctxFor(db, "set_person_status", LATER), lee.contactId, { status: "lead", sub: "Not now" });
  assert.equal(toLead.summary, `Moved Lee Example to Lead (Not now) (change ${toLead.changeId})`);
  assert.deepEqual(await pair(db, lee.contactId), {
    person_status: "lead",
    sub_status: "not_now",
    lead_status: "not_now",
    lead_status_at: LATER.toISOString(),
  });
  // Lead with no sub-status given keeps the one they have; a new Lead starts New; Lead always has one.
  assert.match(await refusal(setPersonStatus(ctxFor(db), lee.contactId, { status: "lead" })), /Nothing to change for Lee Example/);
  assert.match(await refusal(setPersonStatus(ctxFor(db), lee.contactId, { status: "lead", sub: null })), /A lead always has a lead status/);
  assert.match(await refusal(setPersonStatus(ctxFor(db), lee.contactId, { status: "partner", sub: "x" })), /Partner has no sub-statuses/);

  await undoChange(ctxFor(db, "undo_change", LATER), toLead.changeId);
  assert.deepEqual(await pair(db, lee.contactId), {
    person_status: "partner",
    sub_status: null,
    lead_status: "qualified",
    lead_status_at: LATER.toISOString(),
  });
  const kim = await addLead(ctxFor(db, "add_lead"), { name: "Kim Example", email: "kim@example.com" });
  const kimMoved = await setPersonStatus(ctxFor(db, "set_person_status", LATER), kim.contactId, { status: "contact", sub: "client" });
  await undoChange(ctxFor(db, "undo_change", LATER), kimMoved.changeId);
  assert.deepEqual(await pair(db, kim.contactId), {
    person_status: "lead",
    sub_status: "new",
    lead_status: "new",
    lead_status_at: NOW.toISOString(),
  });
});

test("Lead is refused while the person has an open deal, also when the deal comes in at the same moment", async () => {
  const db = await openTestDb();
  const pat = await addDeal(ctxFor(db, "add_deal"), { name: "Pat Example", email: "pat@example.com" });
  assert.match(
    await refusal(setPersonStatus(ctxFor(db), pat.contactId, { status: "lead" })),
    /^Pat Example has an open deal, so they can't be a lead\. Use return_to_lead on that deal instead, or close it first\.$/,
  );
  await addDeal(ctxFor(db, "add_deal"), { contact: pat.contactId, dealTitle: "Second" });
  assert.match(await refusal(setPersonStatus(ctxFor(db), pat.contactId, { status: "lead" })), /has 2 open deals/);

  const robin = await addLead(ctxFor(db, "add_lead"), { name: "Robin Sample", email: "robin@example.com" });
  await setPersonStatus(ctxFor(db), robin.contactId, { status: "partner" });
  // A deal for Robin lands between the read and the write: the batch's guard refuses it in plain words.
  const raced = racing(db, async () => {
    await addDeal(ctxFor(db, "add_deal"), { contact: robin.contactId, dealTitle: "Raced" });
  });
  assert.match(await refusal(setPersonStatus(ctxFor(raced), robin.contactId, { status: "lead" })), /has an open deal, so they can't be a lead/);
  assert.equal((await contact(db, robin.contactId)).person_status, "partner");
});

test("a Won deal makes a Contact a Client in the same change; undo puts it back; others are left alone", async () => {
  const db = await openTestDb();
  const pat = await addDeal(ctxFor(db, "add_deal"), { name: "Pat Example", email: "pat@example.com", dealTitle: "Website" });
  const won = await updateDeal(ctxFor(db, "update_deal", LATER), pat.dealId, { stage: "won" });
  assert.equal(won.summary, `Moved "Website" (Pat Example) to Won; Pat Example is now a Client (change ${won.changeId})`);
  assert.deepEqual(await pair(db, pat.contactId), { person_status: "contact", sub_status: "client", lead_status: null, lead_status_at: null });
  await undoChange(ctxFor(db, "undo_change", LATER), won.changeId);
  assert.deepEqual(await pair(db, pat.contactId), { person_status: "contact", sub_status: null, lead_status: null, lead_status_at: null });

  // Already a Client: unchanged. A Partner: unchanged. Renamed Client: the summary uses the new word.
  await updateDeal(ctxFor(db, "update_deal", LATER), pat.dealId, { stage: "won" });
  const second = await addDeal(ctxFor(db, "add_deal"), { contact: pat.contactId, dealTitle: "Logo" });
  const again = await updateDeal(ctxFor(db, "update_deal", LATER), second.dealId, { status: "won" });
  assert.equal(again.summary, `Moved "Logo" (Pat Example) to Won (change ${again.changeId})`);

  const robin = await addDeal(ctxFor(db, "add_deal"), { name: "Robin Sample", email: "robin@example.com", dealTitle: "Sign" });
  await setPersonStatus(ctxFor(db), robin.contactId, { status: "partner" });
  const partnerWon = await updateDeal(ctxFor(db, "update_deal", LATER), robin.dealId, { stage: "won" });
  assert.doesNotMatch(partnerWon.summary, /Client/);
  assert.equal((await contact(db, robin.contactId)).person_status, "partner");

  await updateSubStatus(ctxFor(db), "contact", "client", { label: "Account" });
  const sam = await addDeal(ctxFor(db, "add_deal"), { name: "Sam Example", email: "sam@example.com", dealTitle: "Shop" });
  const samWon = await updateDeal(ctxFor(db, "update_deal", LATER), sam.dealId, { stage: "won" });
  assert.match(samWon.summary, /Sam Example is now an Account/);
  // Client archived: nobody moves to it.
  const kim = await addDeal(ctxFor(db, "add_deal"), { name: "Kim Example", email: "kim@example.com", dealTitle: "Fence" });
  await setPersonStatus(ctxFor(db), pat.contactId, { status: "contact", sub: null });
  await setPersonStatus(ctxFor(db), sam.contactId, { status: "contact", sub: null });
  await updateSubStatus(ctxFor(db), "contact", "client", { archived: true });
  await updateDeal(ctxFor(db, "update_deal", LATER), kim.dealId, { stage: "won" });
  assert.equal((await contact(db, kim.contactId)).sub_status, null);
});

test("an undo of a change from before migration 0011 puts back the status the migration gives its lead status", async () => {
  const db = await createTestDb();
  // A qualify_lead change recorded before 0011: its snapshots have no person_status or sub_status.
  db.exec(`INSERT INTO contacts (id, name, email, lead_status, lead_status_at, version, person_status)
    VALUES ('ct_old', 'Old Lead', 'old@example.com', 'qualified', '2026-11-18T00:00:00.000Z', 2, 'contact')`);
  const row = await contact(db, "ct_old");
  const after: Record<string, unknown> = { ...row };
  delete after.person_status;
  delete after.sub_status;
  const before = { ...after, lead_status: "contacted", lead_status_at: "2026-11-10T00:00:00.000Z", version: 1 };
  await db
    .prepare(
      `INSERT INTO audit_log (id, at, actor, tool, target_table, target_id, before_json, after_json, summary)
       VALUES ('chg_old', '2026-11-18T00:00:00.000Z', 'owner', 'qualify_lead', 'contacts', 'ct_old', ?, ?, 'Qualified Old Lead (no deal) (change chg_old)')`,
    )
    .bind(JSON.stringify({ "contacts:ct_old": before }), JSON.stringify({ "contacts:ct_old": after }))
    .run();
  await undoChange(ctxFor(db, "undo_change", LATER), "chg_old");
  assert.deepEqual(await pair(db, "ct_old"), {
    person_status: "lead",
    sub_status: "contacted",
    lead_status: "contacted",
    lead_status_at: "2026-11-10T00:00:00.000Z",
  });
});

test("the moves the app makes by itself: New to Contacted on a reach, Lead to Contact on a deal, Contact to Client on Won", async () => {
  const db = await openTestDb();
  const lee = await addLead(ctxFor(db, "add_lead"), { name: "Lee Example", email: "lee@example.com" });
  assert.deepEqual(await pair(db, lee.contactId), { person_status: "lead", sub_status: "new", lead_status: "new", lead_status_at: NOW.toISOString() });
  await logActivity(ctxFor(db, "log_activity", LATER), { contactId: lee.contactId, type: "call", summary: "Called." });
  assert.deepEqual(await pair(db, lee.contactId), {
    person_status: "lead",
    sub_status: "contacted",
    lead_status: "contacted",
    lead_status_at: LATER.toISOString(),
  });
  const deal = await addDeal(ctxFor(db, "add_deal", LATER), { contact: lee.contactId, dealTitle: "Roof" });
  assert.deepEqual(await pair(db, lee.contactId), {
    person_status: "contact",
    sub_status: null,
    lead_status: "qualified",
    lead_status_at: LATER.toISOString(),
  });
  await updateDeal(ctxFor(db, "update_deal", LATER), deal.dealId, { status: "won" });
  assert.equal((await contact(db, lee.contactId)).sub_status, "client");
  assert.equal((await contact(db, lee.contactId)).lead_status, "qualified", "Qualified stays as history");
});

test("undoing a bring-back is refused while someone has the status again", async () => {
  const db = await openTestDb();
  await updatePersonStatus(ctxFor(db), "partner", { archived: true });
  const back = await updatePersonStatus(ctxFor(db), "partner", { archived: false });
  const pat = await addDeal(ctxFor(db, "add_deal"), { name: "Pat Example", email: "pat@example.com" });
  await setPersonStatus(ctxFor(db), pat.contactId, { status: "partner" });
  assert.match(
    await refusal(undoChange(ctxFor(db, "undo_change", LATER), back.changeId)),
    /it would archive person status Partner again, but 1 person has it now/,
  );
});
