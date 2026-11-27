// The person status tools (decision 0041): add_contact, update_contact's personStatus and subStatus, the four tools
// that change the status list, list_person_statuses, search_contacts' filters, and the owner's labels in answers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { approved, connectInMemory, fails, ok } from "../../tests/helpers/mcp-client.ts";
import type { ContactRow, Db } from "../db/db.ts";
import { createTestDb } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import { createMcpServer } from "./server.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");

async function setup() {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  return { db, c: await connectInMemory(createMcpServer({ db, now: () => NOW })) };
}

const changeIdOf = (data: unknown) => (data as { changeId: string }).changeId;
const contactIdOf = (data: unknown) => (data as { contactId: string }).contactId;

const row = async (db: Db, id: string) => {
  const found = await db.prepare("SELECT * FROM contacts WHERE id = ?").bind(id).first<ContactRow>();
  assert.ok(found);
  return found;
};

type Match = { id: string; personStatus: string; personStatusLabel: string; subStatus: string | null; subStatusLabel: string | null };

test("add_contact adds a Contact by default, with no deal, and undo removes them", async () => {
  const { db, c } = await setup();
  const answer = await approved(c, "add_contact", { name: "Lee Example", email: "lee@example.com", source: "trade fair", notes: "Sends us work." });
  assert.match(answer.headline, /^Added Lee Example as a Contact, from trade fair \(change chg_[a-z0-9]{12}\)$/);
  const id = contactIdOf(answer.data);
  const added = await row(db, id);
  assert.deepEqual([added.person_status, added.sub_status, added.lead_status, added.notes], ["contact", null, null, "Sends us work."]);
  const deals = await db.prepare("SELECT COUNT(*) AS n FROM deals WHERE contact_id = ?").bind(id).first<number>("n");
  assert.equal(deals, 0);

  const undone = await ok(c, "undo_change", { changeId: changeIdOf(answer.data) });
  assert.match(undone.headline, /^Undid chg_[a-z0-9]{12}: Removed contact Lee Example/);
  assert.equal(await db.prepare("SELECT 1 FROM contacts WHERE id = ?").bind(id).first(), null);
});

test("add_contact takes any live status and sub-status by key or label; a Lead starts New", async () => {
  const { db, c } = await setup();
  const partner = await approved(c, "add_contact", { name: "Hana Example", personStatus: "Partner" });
  assert.match(partner.headline, /^Added Hana Example as a Partner \(change/);
  const client = await approved(c, "add_contact", { name: "Cal Example", personStatus: "contact", subStatus: "Client" });
  assert.match(client.headline, /^Added Cal Example as a Contact \(Client\) \(change/);
  assert.equal((await row(db, contactIdOf(client.data))).sub_status, "client");
  const lead = await approved(c, "add_contact", { name: "Lou Example", personStatus: "lead" });
  assert.match(lead.headline, /^Added lead Lou Example \(New\) \(change/);
  const leadRow = await row(db, contactIdOf(lead.data));
  assert.deepEqual([leadRow.person_status, leadRow.sub_status, leadRow.lead_status], ["lead", "new", "new"]);

  assert.match(await fails(c, "add_contact", { name: "Max Example", personStatus: "Supplier" }), /^There's no live person status "Supplier"\. Use one of: Lead \(lead\), Contact \(contact\), Partner \(partner\)\.$/);
  assert.match(await fails(c, "add_contact", { name: "Max Example", personStatus: "partner", subStatus: "gold" }), /^Partner has no sub-statuses\. Leave the sub-status out\.$/);
  assert.match(await fails(c, "add_contact", { name: "Max Example", personStatus: "lead", subStatus: null }), /^A lead always has a lead status\./);
  assert.match(
    await fails(c, "add_contact", { name: "Pat Again", email: "pat@example.com" }),
    /^Pat Example \(ct_seed01, pat@example\.com\) already uses that email\. Change them with update_contact instead\.$/,
  );
  assert.match(await fails(c, "add_contact", { name: "  " }), /^A contact needs a name\./);
});

test("add_contact with a Lead adds them exactly as add_lead does: the business check, notes as a note, undo", async () => {
  const { db, c } = await setup();
  const first = await approved(c, "add_contact", { name: "Ann Example", business: "Acme Plumbing", personStatus: "lead", notes: "Met at the fair." });
  const ann = contactIdOf(first.data);
  assert.match(first.headline, /^Added lead Ann Example \(New\) \(change/);
  const annRow = await row(db, ann);
  assert.equal(annRow.notes, null, "notes are a note on the person, as add_lead logs them");
  const note = await db.prepare("SELECT type, summary FROM activities WHERE contact_id = ?").bind(ann).first<{ type: string; summary: string }>();
  assert.deepEqual(note, { type: "note", summary: "Met at the fair." });
  assert.match(
    await fails(c, "add_contact", { name: "Jo Example", business: " acme  plumbing", personStatus: "Lead" }),
    /already has that account\. Say allowDuplicate: true to add another lead anyway\.$/,
  );
  await approved(c, "add_contact", { name: "Jo Example", business: "Acme Plumbing", personStatus: "lead", allowDuplicate: true });
  const reached = await approved(c, "add_contact", { name: "Kim Example", personStatus: "lead", subStatus: "Contacted" });
  assert.match(reached.headline, /^Added lead Kim Example \(Contacted\) \(change/);
  assert.equal((await row(db, contactIdOf(reached.data))).lead_status, "contacted");
  await ok(c, "undo_change", { changeId: changeIdOf(first.data) });
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM activities WHERE contact_id = ?").bind(ann).first<number>("n"), 0);
  assert.equal(await db.prepare("SELECT 1 FROM contacts WHERE id = ?").bind(ann).first(), null);
});

test("a blank sub-status is refused, not read as none; null clears one, except a lead's", async () => {
  const { db, c } = await setup();
  for (const [tool, args] of [
    ["add_contact", { name: "Lee Example", subStatus: "  " }],
    ["update_contact", { contact: "ct_seed01", subStatus: "" }],
    ["search_contacts", { query: "", personStatus: "contact", subStatus: " " }],
    ["update_sub_status", { status: "contact", subStatus: "", label: "Buyer" }],
  ] as const) {
    assert.match(await fails(c, tool, args), /subStatus"? can't be empty/, tool);
  }
  assert.match(await fails(c, "add_contact", { name: "Lee Example", personStatus: " " }), /personStatus"? can't be empty/);
  const id = contactIdOf((await approved(c, "add_contact", { name: "Lee Example", subStatus: "client" })).data);
  await approved(c, "update_contact", { contact: id, subStatus: null });
  assert.equal((await row(db, id)).sub_status, null);
  const lead = contactIdOf((await approved(c, "add_lead", { name: "Lou Example" })).data);
  assert.match(await fails(c, "update_contact", { contact: lead, subStatus: null }), /^A lead always has a lead status\./);
});

test("update_contact sets a person status and sub-status in one change with other fields, and undo reverses it all", async () => {
  const { db, c } = await setup();
  const id = contactIdOf((await approved(c, "add_contact", { name: "Lee Example" })).data);
  const moved = await approved(c, "update_contact", { contact: id, personStatus: "partner", phone: "555-0199" });
  assert.match(moved.headline, /^Updated Lee Example: person status to Partner and phone \(change chg_[a-z0-9]{12}\)$/);
  const after = await row(db, id);
  assert.deepEqual([after.person_status, after.sub_status, after.phone], ["partner", null, "555-0199"]);
  await ok(c, "undo_change", { changeId: changeIdOf(moved.data) });
  const back = await row(db, id);
  assert.deepEqual([back.person_status, back.sub_status, back.phone], ["contact", null, null]);

  const client = await approved(c, "update_contact", { contact: id, personStatus: "contact", subStatus: "client" });
  assert.match(client.headline, /^Updated Lee Example: person status to Contact \(Client\) \(change/);
  // The sub-status alone, of the status they have.
  assert.equal((await row(db, id)).sub_status, "client");
  const none = await approved(c, "update_contact", { contact: id, subStatus: null });
  assert.match(none.headline, /^Updated Lee Example: person status to Contact \(change/);
  await ok(c, "undo_change", { changeId: changeIdOf(none.data) });
  assert.equal((await row(db, id)).sub_status, "client");
});

test("update_contact moves a lead out of Lead (Qualified kept) and refuses Lead while there is an open deal", async () => {
  const { db, c } = await setup();
  const lead = contactIdOf((await approved(c, "add_lead", { name: "Lou Example" })).data);
  const out = await approved(c, "update_contact", { contact: lead, personStatus: "partner" });
  assert.match(out.headline, /^Updated Lou Example: person status to Partner \(change/);
  const partner = await row(db, lead);
  assert.deepEqual([partner.person_status, partner.lead_status], ["partner", "qualified"]);
  const back = await approved(c, "update_contact", { contact: lead, personStatus: "lead", subStatus: "contacted" });
  assert.match(back.headline, /^Updated Lou Example: person status to Lead \(Contacted\) \(change/);
  assert.equal((await row(db, lead)).lead_status, "contacted");

  assert.match(await fails(c, "update_contact", { contact: "ct_seed01", personStatus: "lead" }), /^Pat Example has 1 open deal\. Use return_to_lead on that deal instead, or close it first\.$/);
  assert.match(await fails(c, "update_contact", { contact: lead, personStatus: "partner", leadStatus: "new" }), /^Give either leadStatus or personStatus and subStatus, not both\./);
  assert.match(await fails(c, "update_contact", { contact: lead, subStatus: "client" }), /^Lead has no sub-status "client"\. Use one of: New \(new\)/);
  assert.match(await fails(c, "update_contact", { contact: lead, personStatus: "lead", subStatus: "contacted" }), /^Nothing to change for Lou Example/);
});

test("the four status tools change the list as owner text, each in one change that undo reverses", async () => {
  const { c } = await setup();
  const added = await ok(c, "add_person_status", { label: "Supplier", subLabel: "Supplier type" });
  assert.match(added.headline, /^Added person status Supplier \(key supplier\) at position 4 of 4 \(change/);
  assert.equal((added.data as { key: string }).key, "supplier");
  const sub = await ok(c, "add_sub_status", { status: "Supplier", label: "Wholesale" });
  assert.match(sub.headline, /^Added sub-status Wholesale \(key wholesale\) to Supplier \(change/);
  const renamed = await ok(c, "update_sub_status", { status: "supplier", subStatus: "wholesale", label: "Trade" });
  assert.match(renamed.headline, /^Renamed sub-status Wholesale of Supplier to Trade \(change/);
  const moved = await ok(c, "update_person_status", { status: "supplier", label: "Vendor", position: 1 });
  assert.match(moved.headline, /^Renamed person status Supplier to Vendor; moved it to position 1 of 4 \(change/);

  const listed = await ok(c, "list_person_statuses");
  assert.equal(listed.headline, "4 person statuses: Vendor, Lead, Contact, Partner.");
  const statuses = (listed.data as { statuses: { key: string; subLabel: string; people: number; subStatuses: { key: string; label: string }[] }[] }).statuses;
  assert.deepEqual(statuses.map((s) => s.key), ["supplier", "lead", "contact", "partner"]);
  assert.deepEqual(statuses[0]?.subStatuses.map((s) => [s.key, s.label]), [["wholesale", "Trade"]]);
  assert.equal(statuses[0]?.subLabel, "Supplier type");

  const someone = await approved(c, "add_contact", { name: "Val Example", personStatus: "Vendor", subStatus: "Trade" });
  assert.match(someone.headline, /^Added Val Example as a Vendor \(Trade\)/);
  assert.match(await fails(c, "update_sub_status", { status: "supplier", subStatus: "trade", archived: true }), /^1 person has the sub-status Trade: Val Example\. Give them another one first\.$/);
  assert.match(await fails(c, "update_person_status", { status: "contact", archived: true }), /^Contact can be renamed but not archived/);
  assert.match(await fails(c, "add_sub_status", { status: "lead", label: "Warm" }), /^Lead's sub-statuses are fixed/);
  await ok(c, "undo_change", { changeId: changeIdOf(someone.data) });
  const archived = await ok(c, "update_sub_status", { status: "supplier", subStatus: "trade", archived: true });
  assert.match(archived.headline, /^Archived sub-status Trade of Vendor \(change/);
  const withArchived = (await ok(c, "list_person_statuses", { includeArchived: true })).data as { statuses: { subStatuses: { archived: boolean }[] }[] };
  assert.equal(withArchived.statuses[0]?.subStatuses[0]?.archived, true);
  assert.deepEqual(((await ok(c, "list_person_statuses")).data as { statuses: { subStatuses: unknown[] }[] }).statuses[0]?.subStatuses, []);
});

test("undo reverses each status tool's change", async () => {
  const { db, c } = await setup();
  const statuses = async () =>
    (await db.prepare("SELECT key, label, position, archived FROM person_statuses ORDER BY position").all<{ key: string; label: string; position: number; archived: number }>()).results.map(
      (s) => `${s.position} ${s.label}${s.archived === 1 ? " (archived)" : ""}`,
    );
  const subs = async () =>
    (await db.prepare("SELECT label, archived FROM person_substatuses WHERE status_key = 'supplier' ORDER BY position").all<{ label: string; archived: number }>()).results.map(
      (s) => `${s.label}${s.archived === 1 ? " (archived)" : ""}`,
    );
  const undo = (answer: { data: unknown }) => ok(c, "undo_change", { changeId: changeIdOf(answer.data) });

  await undo(await ok(c, "add_person_status", { label: "Supplier", position: 1 }));
  assert.deepEqual(await statuses(), ["1 Lead", "2 Contact", "3 Partner"]);
  await ok(c, "add_person_status", { label: "Supplier" });
  await undo(await ok(c, "update_person_status", { status: "Supplier", label: "Vendor", position: 2 }));
  assert.deepEqual(await statuses(), ["1 Lead", "2 Contact", "3 Partner", "4 Supplier"]);
  await undo(await ok(c, "update_person_status", { status: "supplier", archived: true }));
  assert.deepEqual(await statuses(), ["1 Lead", "2 Contact", "3 Partner", "4 Supplier"]);

  await undo(await ok(c, "add_sub_status", { status: "supplier", label: "Wholesale" }));
  assert.deepEqual(await subs(), []);
  const wholesale = await ok(c, "add_sub_status", { status: "supplier", label: "Wholesale" });
  await undo(await ok(c, "update_sub_status", { status: "supplier", subStatus: "Wholesale", label: "Trade" }));
  assert.deepEqual(await subs(), ["Wholesale"]);
  await undo(await ok(c, "update_sub_status", { status: "supplier", subStatus: "wholesale", archived: true }));
  assert.deepEqual(await subs(), ["Wholesale"]);

  // Undo never takes away a sub-status someone has.
  await approved(c, "add_contact", { name: "Val Example", personStatus: "supplier", subStatus: "wholesale" });
  assert.match(await fails(c, "undo_change", { changeId: changeIdOf(wholesale.data) }), /^Can't undo chg_[a-z0-9]{12}: /);
  assert.deepEqual(await subs(), ["Wholesale"]);
});

test("list_person_statuses counts the people who have each status and sub-status", async () => {
  const { c } = await setup();
  await approved(c, "add_contact", { name: "Cal Example", subStatus: "client" });
  await approved(c, "add_contact", { name: "Hana Example", personStatus: "partner" });
  const listed = await ok(c, "list_person_statuses");
  assert.equal(listed.headline, "3 person statuses: Lead, Contact, Partner.");
  const statuses = (listed.data as { statuses: { key: string; locked: boolean; people: number; subStatuses: { key: string; people: number }[] }[] }).statuses;
  const byKey = new Map(statuses.map((s) => [s.key, s]));
  assert.equal(byKey.get("partner")?.people, 1);
  assert.equal(byKey.get("contact")?.subStatuses.find((s) => s.key === "client")?.people, 1);
  assert.deepEqual(statuses.map((s) => s.locked), [true, true, false]);
});

test("search_contacts filters by person status, sub-status and a custom field, and shows the status labels", async () => {
  const { c } = await setup();
  await ok(c, "add_field", { entity: "contact", label: "Region", type: "text" });
  await ok(c, "add_field", { entity: "contact", label: "Referrals", type: "number" });
  const hana = contactIdOf((await approved(c, "add_contact", { name: "Hana Example", personStatus: "partner", fields: { region: "North", referrals: 3 } })).data);
  const cal = contactIdOf((await approved(c, "add_contact", { name: "Cal Example", subStatus: "client", fields: { region: "south" } })).data);

  const partners = await ok(c, "search_contacts", { query: "", personStatus: "Partner" });
  assert.equal(partners.headline, "1 contact found.");
  const [first] = (partners.data as { contacts: Match[] }).contacts;
  assert.deepEqual([first?.id, first?.personStatus, first?.personStatusLabel, first?.subStatus], [hana, "partner", "Partner", null]);

  const clients = (await ok(c, "search_contacts", { query: "", personStatus: "contact", subStatus: "Client" })).data as { contacts: Match[] };
  assert.deepEqual(clients.contacts.map((m) => [m.id, m.subStatusLabel]), [[cal, "Client"]]);

  const north = (await ok(c, "search_contacts", { query: "", field: "Region", value: "NORTH" })).data as { contacts: Match[] };
  assert.deepEqual(north.contacts.map((m) => m.id), [hana]);
  const three = (await ok(c, "search_contacts", { query: "", field: "referrals", value: "3" })).data as { contacts: Match[] };
  assert.deepEqual(three.contacts.map((m) => m.id), [hana]);
  assert.equal((await ok(c, "search_contacts", { query: "", field: "region", value: "north", personStatus: "contact" })).headline, "No contacts match that search.");

  assert.match(await fails(c, "search_contacts", { query: "", subStatus: "client" }), /^A sub-status belongs to one person status\. Give personStatus too/);
  assert.match(await fails(c, "search_contacts", { query: "", field: "region" }), /^Give field and value together/);
  assert.match(await fails(c, "search_contacts", { query: "", field: "Shoe size", value: "9" }), /^There's no custom field "Shoe size"\./);
  assert.match(await fails(c, "search_contacts", { query: "", field: "referrals", value: "lots" }), /^Referrals is a number field\. Give a number/);
  assert.match(await fails(c, "search_contacts", { query: "", personStatus: "Supplier" }), /^There's no person status "Supplier"\. Use one of: Lead \(lead\), Contact \(contact\), Partner \(partner\)\.$/);
  await ok(c, "update_field", { field: "region", archived: true });
  assert.match(await fails(c, "search_contacts", { query: "", field: "region", value: "north" }), /^Region is archived, so nobody is searched by it\./);
});

test("a renamed Lead sub-status shows under its new label in answers, summaries and reads; the key stays", async () => {
  const { c } = await setup();
  await ok(c, "update_sub_status", { status: "lead", subStatus: "contacted", label: "Reached" });
  await ok(c, "update_sub_status", { status: "lead", subStatus: "new", label: "Fresh" });
  const lead = await approved(c, "add_lead", { name: "Lou Example" });
  assert.match(lead.headline, /^Added lead Lou Example \(Fresh\) \(change/);
  const id = contactIdOf(lead.data);
  const logged = await approved(c, "log_activity", { contact: id, type: "call", summary: "Left a message." });
  assert.match(logged.headline, /; Lou Example is now Reached \(change/);
  const leads = await ok(c, "list_leads", { statuses: ["contacted"] });
  assert.match(leads.headline, /\(\d+ reached\)\.$/);
  const item = (leads.data as { items: { id: string; leadStatus: string; leadStatusLabel: string; personStatusLabel: string; subStatusLabel: string }[] }).items.find((i) => i.id === id);
  assert.deepEqual([item?.leadStatus, item?.leadStatusLabel, item?.personStatusLabel, item?.subStatusLabel], ["contacted", "Reached", "Lead", "Reached"]);
  const found = (await ok(c, "search_contacts", { query: "Lou" })).data as { contacts: (Match & { leadStatusLabel: string })[] };
  assert.equal(found.contacts[0]?.leadStatusLabel, "Reached");
  const status = await approved(c, "update_contact", { contact: id, leadStatus: "not_now" });
  assert.match(status.headline, /^Updated Lou Example: lead status to Not now \(change/);
  const brief = (await ok(c, "get_deal", { deal: "dl_seed01" })).data as { contact: Match };
  assert.deepEqual([brief.contact.personStatus, brief.contact.personStatusLabel], ["contact", "Contact"]);
});
