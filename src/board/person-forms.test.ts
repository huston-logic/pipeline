// Add contact and the Person status fields of the person form (decision 0041), through the Worker: plain selects that
// work without JavaScript, one add_contact or update_contact change by the owner, only the fields the owner changed,
// and a 422 that keeps the values and says which sub-statuses belong to the chosen status.
import assert from "node:assert/strict";
import { test } from "node:test";
import { auditCount, auditOf, changeIdOf, devEnv, formFields, h1Count, load, post, seededDb } from "../../tests/helpers/board.ts";
import type { ContactRow } from "../db/db.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import { updateSubStatus } from "../services/person-status.ts";

const contact = (db: SqliteD1, id: string) => db.prepare("SELECT * FROM contacts WHERE id = ?").bind(id).first<ContactRow>();
const owner = (db: SqliteD1) => ({ db, now: new Date(), actor: "owner" as const, tool: "test" });

async function editForm(db: SqliteD1, path: string) {
  const page = await load(devEnv(db), path);
  return { fields: formFields(page.body, path), cookie: page.cookie, token: page.token };
}

/** The <select> for `name` in a page, from its opening tag to its close. */
const selectOf = (body: string, name: string) => new RegExp(`<select id="[^"]*" name="${name}"[\\s\\S]*?</select>`).exec(body)?.[0] ?? "";

test("Add contact: one h1, the Person status select (Contact first chosen) and Sub-status grouped under each status", async () => {
  const db = await seededDb();
  const { res, body } = await load(devEnv(db), "/contacts/new?from=contacts");
  assert.equal(res.status, 200);
  assert.equal(h1Count(body), 1);
  assert.match(body, /<h1>Add contact<\/h1>/);
  assert.match(body, /<title>Add contact · /);
  assert.match(body, /<label for="contact-person_status">Person status<\/label>/);
  assert.match(body, /<label for="contact-sub_status">Sub-status<\/label>/);
  const status = selectOf(body, "person_status");
  assert.match(status, /<option value="lead">Lead<\/option>\n<option value="contact" selected>Contact<\/option>\n<option value="partner">Partner<\/option>/);
  const sub = selectOf(body, "sub_status");
  assert.match(sub, /<option value="" selected>None<\/option>/);
  assert.match(sub, /<optgroup label="Lead">\n<option value="lead.new">New<\/option>/);
  assert.match(sub, /<optgroup label="Contact">\n<option value="contact.client">Client<\/option>\n<\/optgroup>/);
  assert.doesNotMatch(sub, /label="Partner"/, "a status with no sub-statuses has no group");
  assert.match(body, /<a class="form-cancel" href="\/contacts">Cancel<\/a>/);
  assert.match(body, /<input type="hidden" name="csrf" value="[^"]+">/);
});

test("Add contact posts add_contact as the owner, then the new contact's page; the sub-status key reaches the service", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const before = await auditCount(db);
  const { res, location } = await post(env, "/contacts/new", {
    name: "Cal Example",
    email: "cal@example.com",
    person_status: "contact",
    sub_status: "contact.client",
    notes: "Bought twice.",
    return_to: "/contacts",
  });
  assert.equal(res.status, 303);
  assert.match(location, /^\/contacts\/ct_[a-z0-9]{12}\?change=chg_[a-z0-9]{12}$/);
  assert.equal(await auditCount(db), before + 1);
  const audit = await auditOf(db, changeIdOf(location));
  assert.equal(audit?.actor, "owner");
  assert.equal(audit?.tool, "add_contact");
  assert.match(audit?.summary ?? "", /^Added Cal Example as a Contact \(Client\) \(change/);
  const id = /^\/contacts\/(ct_[a-z0-9]+)/.exec(location)?.[1] ?? "";
  const row = await contact(db, id);
  assert.deepEqual([row?.person_status, row?.sub_status, row?.notes], ["contact", "client", "Bought twice."]);
  const page = (await load(env, location)).body;
  assert.match(page, /<dt>Person status<\/dt><dd>Contact \(Client\)<\/dd>/);

  const lead = await post(env, "/contacts/new", { name: "Lou Example", person_status: "lead", sub_status: "" });
  assert.equal(lead.res.status, 303);
  const leadRow = await contact(db, /^\/contacts\/(ct_[a-z0-9]+)/.exec(lead.location)?.[1] ?? "");
  assert.deepEqual([leadRow?.person_status, leadRow?.sub_status, leadRow?.lead_status], ["lead", "new", "new"], "a lead with none chosen starts New");
});

test("a sub-status of another status is a 422 that keeps the values and names the chosen status's own; nothing is written", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const before = await auditCount(db);
  const partner = await post(env, "/contacts/new", { name: "Hana Example", person_status: "partner", sub_status: "contact.client" });
  assert.equal(partner.res.status, 422);
  assert.match(partner.body, /<title>Error: Add contact · /);
  assert.match(partner.body, /<a href="#contact-sub_status">Client isn&#39;t one of Partner&#39;s: Partner has no sub-statuses\. Choose None\.<\/a>/);
  assert.match(partner.body, /name="name" type="text" value="Hana Example"/);
  assert.match(selectOf(partner.body, "person_status"), /<option value="partner" selected>Partner<\/option>/);
  assert.match(selectOf(partner.body, "sub_status"), /<option value="contact.client" selected>Client<\/option>/);
  assert.match(partner.body, /aria-invalid="true"/);

  const lead = await post(env, "/contacts/new", { name: "Lou Example", person_status: "lead", sub_status: "contact.client" });
  assert.equal(lead.res.status, 422);
  assert.match(lead.body, /Client isn&#39;t one of Lead&#39;s\. Pick one of New, Contacted, Not now, Not a fit and Bad lead\./);
  const contactOnly = await post(env, "/contacts/new", { name: "Cy Example", person_status: "contact", sub_status: "lead.new" });
  assert.match(contactOnly.body, /New isn&#39;t one of Contact&#39;s\. Pick one of Client, or None\./);
  const unknown = await post(env, "/contacts/new", { name: "Di Example", person_status: "supplier" });
  assert.equal(unknown.res.status, 422);
  assert.match(unknown.body, /Choose one of the options\./);
  assert.equal(await auditCount(db), before);
});

test("Edit contact: the status fields show what is stored, and changing only the sub-status sends only it", async () => {
  const db = await seededDb();
  const { fields, cookie, token } = await editForm(db, "/contacts/ct_seed01/edit");
  assert.equal(fields.get("person_status"), "contact");
  assert.equal(fields.get("sub_status"), "");
  assert.match(fields.get("was.person_status") ?? "", /^[A-Za-z0-9_-]{22}$/);
  fields.set("sub_status", "contact.client");
  const { res, location } = await post(devEnv(db), "/contacts/ct_seed01/edit", fields, { cookie, token });
  assert.equal(res.status, 303);
  const audit = await auditOf(db, changeIdOf(location));
  assert.equal(audit?.tool, "update_contact");
  assert.match(audit?.summary ?? "", /^Updated Pat Example: person status to Contact \(Client\) \(change/);
  assert.equal((await contact(db, "ct_seed01"))?.sub_status, "client");

  // Drawn again, the form shows the new sub-status; a status change with the old sub-status left alone drops it.
  const again = await editForm(db, "/contacts/ct_seed01/edit");
  assert.equal(again.fields.get("sub_status"), "contact.client");
  again.fields.set("person_status", "partner");
  const moved = await post(devEnv(db), "/contacts/ct_seed01/edit", again.fields, { cookie: again.cookie, token: again.token });
  assert.equal(moved.res.status, 303);
  assert.match((await auditOf(db, changeIdOf(moved.location)))?.summary ?? "", /^Updated Pat Example: person status to Partner \(change/);
  const row = await contact(db, "ct_seed01");
  assert.deepEqual([row?.person_status, row?.sub_status], ["partner", null]);
});

test("Edit contact: a mismatched sub-status, or Lead with an open deal, is a 422 with the reason; nothing is written", async () => {
  const db = await seededDb();
  const before = await auditCount(db);
  const form = await editForm(db, "/contacts/ct_seed01/edit");
  form.fields.set("sub_status", "lead.new");
  const mismatch = await post(devEnv(db), "/contacts/ct_seed01/edit", form.fields, { cookie: form.cookie, token: form.token });
  assert.equal(mismatch.res.status, 422);
  assert.match(mismatch.body, /New isn&#39;t one of Contact&#39;s\. Pick one of Client, or None\./);
  assert.match(selectOf(mismatch.body, "sub_status"), /<option value="lead.new" selected>New<\/option>/);

  const lead = await editForm(db, "/contacts/ct_seed01/edit");
  lead.fields.set("person_status", "lead");
  const refused = await post(devEnv(db), "/contacts/ct_seed01/edit", lead.fields, { cookie: lead.cookie, token: lead.token });
  assert.equal(refused.res.status, 422);
  assert.match(refused.body, /Pat Example has 1 open deal\. Use return_to_lead on that deal instead, or close it first\./);
  assert.equal(await auditCount(db), before);
  assert.equal((await contact(db, "ct_seed01"))?.person_status, "contact");
});

test("a renamed lead status shows by its new name on the contact page, its status menu and the Leads filter", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  await updateSubStatus(owner(db), "lead", "contacted", { label: "Reached" });
  const { location } = await post(env, "/leads/new", { name: "Lou Example" });
  const id = /^\/contacts\/(ct_[a-z0-9]+)/.exec(location)?.[1] ?? "";
  await post(env, `/contacts/${id}/log`, { type: "call", summary: "Left a message." });
  const page = (await load(env, `/contacts/${id}`)).body;
  assert.match(page, /<p class="lead-status-line">Lead status: Reached, since /);
  assert.match(page, /<option value="contacted" selected>Reached<\/option>/);
  assert.match(page, /<dt>Person status<\/dt><dd>Lead \(Reached\)<\/dd>/);
  const leads = (await load(env, "/leads")).body;
  assert.match(leads, /<option value="open" selected>Open \(New, Reached, Not now\)<\/option>/);
  assert.match(leads, /<option value="contacted">Reached<\/option>/);
});

test("Add contact with Lead adds a lead as Add a lead does: notes as a note, a business on file refused in board words", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const added = await post(env, "/contacts/new", { name: "Ann Example", business: "Acme Plumbing", person_status: "lead", notes: "Met at the fair." });
  assert.equal(added.res.status, 303);
  const audit = await auditOf(db, changeIdOf(added.location));
  assert.equal(audit?.tool, "add_contact");
  assert.match(audit?.summary ?? "", /^Added lead Ann Example \(New\) \(change/);
  const id = /^\/contacts\/(ct_[a-z0-9]+)/.exec(added.location)?.[1] ?? "";
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM activities WHERE contact_id = ? AND type = 'note'").bind(id).first<number>("n"), 1);

  const before = await auditCount(db);
  const again = await post(env, "/contacts/new", { name: "Jo Example", business: "acme plumbing", person_status: "lead" });
  assert.equal(again.res.status, 422);
  assert.match(again.body, /<a href="#contact-business">Ann Example \(ct_[a-z0-9]+\) already has that business\. To add another lead anyway, use Add a lead and tick Add anyway\.<\/a>/);
  assert.equal(await auditCount(db), before);
});
