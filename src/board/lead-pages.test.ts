// Leads on the board (decisions 0022, 0028): Add a lead, Add a deal for a new person, a lead's status line and status
// menu, Qualify and Back to leads. Each write is one audited change by the owner under the MCP tool's name, a refused
// one is a 422 with the values kept, the same sign-in, origin and CSRF checks apply, and Undo takes it back.
import assert from "node:assert/strict";
import { test } from "node:test";
import { auditCount, auditOf, changeIdOf, devEnv, formFields, h1Count, load, post, seededDb } from "../../tests/helpers/board.ts";
import type { ContactRow, DealRow, TaskRow } from "../db/db.ts";
import type { Env } from "../env.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import { updateContact } from "../services/contacts.ts";

const contact = (db: SqliteD1, id: string) => db.prepare("SELECT * FROM contacts WHERE id = ?").bind(id).first<ContactRow>();
const deal = (db: SqliteD1, id: string) => db.prepare("SELECT * FROM deals WHERE id = ?").bind(id).first<DealRow>();
const titleOf = (body: string) => /<title>([^<]*)<\/title>/.exec(body)?.[1] ?? "";
const mainOf = (body: string) => /<main id="main" tabindex="-1">([\s\S]*)<\/main>/.exec(body)?.[1] ?? "";
const formOf = (body: string, action: string) => {
  const at = body.indexOf(`action="${action}"`);
  const start = at < 0 ? -1 : body.lastIndexOf("<form", at + 1);
  return start < 0 ? "" : body.slice(start, body.indexOf("</form>", start) + 7);
};

async function assertOneChange(db: SqliteD1, before: number, location: string, tool: string) {
  assert.equal(await auditCount(db), before + 1, "exactly one audit row");
  const audit = await auditOf(db, changeIdOf(location));
  assert.equal(audit?.actor, "owner");
  assert.equal(audit?.tool, tool);
}

/** A lead added through the board's Add a lead form; its contact id. */
async function addLead(env: Env, fields: Record<string, string> = {}): Promise<string> {
  const { res, location } = await post(env, "/leads/new", { name: "Lee Example", business: "Example Signs", phone: "555-0123", email: "lee@example.com", ...fields });
  assert.equal(res.status, 303);
  const id = /^\/contacts\/(ct_[a-z0-9]+)\?change=/.exec(location)?.[1];
  assert.ok(id, location);
  return id;
}

/** Undo from the banner, confirming when it asks first; the redirect. */
async function undo(env: Env, location: string, back: string): Promise<string> {
  const { res, location: to } = await post(env, `/changes/${changeIdOf(location)}/undo`, { confirm: "yes", return_to: back });
  assert.equal(res.status, 303);
  return to;
}

test("Add a lead: the form has Name, Account, Email, Phone, Source and Notes, and Cancel goes back where it came from", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const { res, body } = await load(env, "/leads/new?from=leads");
  assert.equal(res.status, 200);
  assert.equal(h1Count(body), 1);
  assert.match(body, /<h1>Add a lead<\/h1>/);
  assert.match(titleOf(body), /^Add a lead · /);
  const form = formOf(body, "/leads/new");
  assert.match(form, /<form class="record-form" method="post" action="\/leads\/new" novalidate>/);
  assert.match(form, /<label for="lead-name">Name<\/label>/, "a name is not required on its own");
  assert.match(form, /<p class="field-hint" id="lead-name-hint">A name or an account is enough\.<\/p>/);
  for (const label of ["Account", "Email", "Phone", "Source", "Notes"]) assert.match(form, new RegExp(`<label for="lead-[a-z]+">${label}</label>`), label);
  assert.doesNotMatch(form, /Deal title|name="value"/, "no deal fields");
  assert.match(form, /<a class="form-cancel" href="\/leads">Cancel<\/a>/);
  assert.match((await load(env, "/leads/new")).body, /<a class="form-cancel" href="\/leads">Cancel<\/a>/, "Leads by default");
  assert.match((await load(env, "/leads/new?from=pipeline")).body, /<a class="form-cancel" href="\/pipeline">Cancel<\/a>/);
  assert.match(body, /<a href="\/leads" aria-current="true">/, "in the People section");
});

test("Add a lead: one add_lead change by the owner, the lead's page with the banner, and Undo takes it back to Leads", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const before = await auditCount(db);
  const { res, location } = await post(env, "/leads/new", { name: "Lee Example", business: "Example Signs", source: "walk-in", notes: "Saw their van.", return_to: "/leads" });
  assert.equal(res.status, 303);
  assert.match(location, /^\/contacts\/ct_[a-z0-9]{12}\?change=chg_[a-z0-9]{12}$/);
  await assertOneChange(db, before, location, "add_lead");
  const id = /^\/contacts\/(ct_[a-z0-9]+)/.exec(location)?.[1] ?? "";
  const row = await contact(db, id);
  assert.equal(row?.lead_status, "new");
  assert.equal(row?.business, "Example Signs");
  assert.match((await load(env, location)).body, /<p class="corner-text">Added lead Lee Example \(New\), from walk-in/);
  const back = await undo(env, location, `/contacts/${id}`);
  assert.match(back, /^\/leads\?change=chg_/, "the lead is gone, so its list");
  assert.equal(await contact(db, id), null);
});

test("Add a lead with only a business is named after it; with neither, a 422 with the values kept", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const id = await addLead(env, { name: "", business: "Corner Example Shop", email: "" });
  assert.equal((await contact(db, id))?.name, "Corner Example Shop");
  const before = await auditCount(db);
  const { res, body } = await post(env, "/leads/new", { name: " ", business: "", phone: "555-0190", return_to: "/leads" });
  assert.equal(res.status, 422);
  assert.equal(await auditCount(db), before);
  assert.match(titleOf(body), /^Error: Add a lead · /);
  assert.match(body, /<li><a href="#lead-name">Give a name or an account\.<\/a><\/li>/);
  assert.match(body, /name="phone" type="tel" value="555-0190"/);
  assert.match(body, /<a class="form-cancel" href="\/leads">Cancel<\/a>/);
});

test("a business already on file is refused with an Add anyway box; ticking it adds the lead", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const before = await auditCount(db);
  const refused = await post(env, "/leads/new", { name: "Lee Example", business: " example  PLUMBING ", return_to: "/leads" });
  assert.equal(refused.res.status, 422);
  assert.equal(await auditCount(db), before);
  assert.match(refused.body, /Pat Example \(ct_seed01, pat@example\.com\) already has that account\. Tick Add anyway to add another lead\./);
  assert.match(refused.body, /<input id="lead-allow_duplicate" name="allow_duplicate" type="checkbox" value="yes">/);
  assert.match(refused.body, /<label for="lead-allow_duplicate">Add anyway<\/label>/);
  assert.match(refused.body, /name="business" type="text" value=" example  PLUMBING "/);
  assert.doesNotMatch(refused.body, /allowDuplicate/, "no tool words on the board");
  const added = await post(env, "/leads/new", { name: "Lee Example", business: "Example Plumbing", allow_duplicate: "yes" });
  assert.equal(added.res.status, 303);
  await assertOneChange(db, before, added.location, "add_lead");
});

test("an email already on file is refused and names the person; an outside name is named by id", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const known = await post(env, "/leads/new", { name: "Someone", email: "pat@example.com" });
  assert.equal(known.res.status, 422);
  assert.match(known.body, /Pat Example \(ct_seed01, pat@example\.com\) already uses that email, so they are on file already\./);
  assert.doesNotMatch(known.body, /update_contact|add_deal/);
  const outside = await post(env, "/leads/new", { name: "Someone", email: "robin@example.com" });
  assert.match(outside.body, /Contact ct_seed02 already uses that email/);
  assert.doesNotMatch(mainOf(outside.body), /Robin Sample/);
});

test("Add a deal (/deals/new): a person and their deal as add_deal, then the deal page; Cancel goes back where it came from", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const page = await load(env, "/deals/new?from=contacts");
  assert.equal(page.res.status, 200);
  assert.match(page.body, /<h1>Add a deal<\/h1>/);
  const form = formOf(page.body, "/deals/new");
  assert.match(form, /<label for="deal-name">Name <span class="field-required">\(required\)<\/span><\/label>/);
  assert.match(form, /<label for="deal-title">Deal title<\/label>/);
  assert.match(form, /<button class="button" type="submit">Add the deal<\/button>/);
  assert.match(form, /<a class="form-cancel" href="\/contacts">Cancel<\/a>/);
  assert.match((await load(env, "/deals/new")).body, /<a class="form-cancel" href="\/pipeline">Cancel<\/a>/, "Pipeline by default");
  assert.match(page.body, /<a href="\/pipeline" aria-current="true">/, "a new deal is in the Pipeline section");
  const before = await auditCount(db);
  const { res, location } = await post(env, "/deals/new", { name: "Lee Example", email: "lee@example.com", title: "Garage plans", value: "2,400", return_to: "/pipeline" });
  assert.equal(res.status, 303);
  assert.match(location, /^\/deals\/dl_[a-z0-9]{12}\?change=chg_/);
  await assertOneChange(db, before, location, "add_deal");
  const refused = await post(env, "/deals/new", { name: "", value: "lots", return_to: "/contacts" });
  assert.equal(refused.res.status, 422);
  assert.match(refused.body, /<li><a href="#deal-name">Give the person&#39;s name\.<\/a><\/li>/);
  assert.match(refused.body, /name="value" type="text" value="lots"/);
});

test("Today, Pipeline, Contacts and Leads offer Add a lead and Add a deal in place of New lead", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  for (const [path, from] of [["/", "today"], ["/pipeline", "pipeline"], ["/contacts", "contacts"]] as const) {
    const body = (await load(env, path)).body;
    assert.match(body, new RegExp(`href="/leads/new\\?from=${from}">Add a lead</a>`), path);
    assert.match(body, new RegExp(`href="/deals/new\\?from=${from}">Add a deal</a>`), path);
    assert.doesNotMatch(body, /New lead/, path);
  }
  assert.match((await load(env, "/leads")).body, /href="\/leads\/new\?from=leads">Add a lead<\/a>/);
});

test("a lead's page: the status line, the status menu, Qualify and Ask Claude's intro, with only the id in the prompt", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const id = await addLead(env);
  db.exec(`UPDATE contacts SET name = '<img src=x> Lee Example', untrusted_fields = '["name"]' WHERE id = '${id}'`);
  const { body } = await load(env, `/contacts/${id}`);
  const main = mainOf(body);
  assert.match(main, /<p class="lead-status-line">Lead status: New, since <time datetime="[^"]+">[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}<\/time><\/p>/);
  const menu = formOf(body, `/contacts/${id}/lead-status`);
  assert.match(menu, /<label for="status-[a-z0-9_-]+-lead_status">Change lead status<\/label>/);
  assert.equal(menu.match(/<option /g)?.length, 5, "the five statuses that are not Qualified");
  assert.match(menu, /<option value="new" selected>New<\/option>/);
  assert.match(menu, /<option value="not_now">Not now<\/option>/);
  assert.doesNotMatch(menu, /qualified/i);
  assert.match(menu, /<label for="status-[a-z0-9_-]+-follow_up">Check back on \(optional\)<\/label>/);
  assert.match(menu, /Only for Not now\. Adds a task to check back that day\./);
  assert.match(menu, /name="follow_up" type="date"/);
  assert.match(menu, /<button class="button button-small" type="submit">Save status<\/button>/);
  assert.match(main, new RegExp(`<a class="button" href="/contacts/${id}/qualify">Qualify</a>`));
  assert.equal(main.match(/href="https:\/\/claude\.ai\/new\?q=/g)?.length, 1);
  assert.match(main, /Draft an intro in my voice/);
  const prompt = `Draft an intro to contact ${id} in my voice. Read my rulebook first, then the contact.`;
  assert.ok(main.includes(`href="https://claude.ai/new?q=${encodeURIComponent(prompt)}"`), "the fixed prompt in the link");
  const ask = main.slice(main.indexOf('aria-labelledby="ask-heading"'));
  for (const bad of [/Lee Example/, /img/, /Example Signs/, /lee@/, /555-0123/]) assert.doesNotMatch(ask.slice(0, ask.indexOf("</section>")), bad, String(bad));
  assert.match(formOf(body, `/contacts/${id}/log`), /<input type="hidden" name="type" value="call">/);
  const text = body.slice(body.lastIndexOf("<form", body.indexOf('value="Sent a text message."')));
  assert.match(text.slice(0, text.indexOf("</form>")), /<input type="hidden" name="via" value="text">/, "the text log button posts via=text");
});

test("a contact who was never a lead sees no lead controls; a Qualified one sees the status line only", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const never = mainOf((await load(env, "/contacts/ct_seed01")).body);
  for (const bad of [/Lead status/, /lead-status/, /\/qualify/, /claude\.ai/, /Draft an intro/]) assert.doesNotMatch(never, bad, String(bad));
  db.exec(`UPDATE contacts SET lead_status = 'qualified', person_status = 'contact', sub_status = NULL, lead_status_at = '2026-11-01T18:00:00.000Z' WHERE id = 'ct_seed01'`);
  const qualified = mainOf((await load(env, "/contacts/ct_seed01")).body);
  assert.match(qualified, /Lead status: Qualified, since/);
  for (const bad of [/lead-status"/, /\/qualify/, /claude\.ai/]) assert.doesNotMatch(qualified, bad, String(bad));
  for (const path of ["/contacts/ct_seed01/qualify", "/contacts/ct_seed03/qualify"]) assert.equal((await load(env, path)).res.status, 404, path);
  for (const path of ["/contacts/ct_seed01/lead-status", "/contacts/ct_seed03/lead-status", "/contacts/ct_seed03/qualify"]) {
    assert.equal((await post(env, path, { lead_status: "bad" })).res.status, 404, path);
  }
});

test("Save status: Not now with a check-back date is one update_contact change with the task; Undo takes both back", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const id = await addLead(env);
  const page = await load(env, `/contacts/${id}`);
  const fields = formFields(page.body, `/contacts/${id}/lead-status`);
  fields.set("lead_status", "not_now");
  fields.set("follow_up", "2026-12-04");
  const before = await auditCount(db);
  const { res, location } = await post(env, `/contacts/${id}/lead-status`, fields, { cookie: page.cookie, token: page.token });
  assert.equal(res.status, 303);
  assert.match(location, new RegExp(`^/contacts/${id}\\?change=chg_`));
  await assertOneChange(db, before, location, "update_contact");
  assert.equal((await contact(db, id))?.lead_status, "not_now");
  const tasks = await db.prepare("SELECT * FROM tasks WHERE contact_id = ?").bind(id).all<TaskRow>();
  assert.equal(tasks.results.length, 1);
  const shown = (await load(env, location)).body;
  assert.match(shown, /<p class="corner-text">Updated Lee Example: lead status to Not now; added task &quot;Check back with Lee Example&quot;, due Fri Dec 4/);
  assert.match(shown, /Lead status: Not now, since/);
  await undo(env, location, `/contacts/${id}`);
  assert.equal((await contact(db, id))?.lead_status, "new");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE contact_id = ?").bind(id).first<{ n: number }>())?.n, 0);
});

test("Save status: Not a fit needs no confirmation; a date with another status, the same status and Qualified are refused", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const id = await addLead(env);
  const path = `/contacts/${id}/lead-status`;
  const fit = await post(env, path, { lead_status: "not_a_fit", follow_up: "", return_to: `/contacts/${id}` });
  assert.equal(fit.res.status, 303);
  assert.equal((await contact(db, id))?.lead_status, "not_a_fit");
  const before = await auditCount(db);
  const dated = await post(env, path, { lead_status: "contacted", follow_up: "2026-12-04", return_to: `/contacts/${id}` });
  assert.equal(dated.res.status, 422);
  assert.match(dated.body, /<h1>The lead status wasn&#39;t changed<\/h1>/);
  assert.match(dated.body, /A check-back date only goes with Not now\. Choose Not now, or clear the date\./);
  assert.match(dated.body, /<option value="contacted" selected>Contacted<\/option>/, "the choice is kept");
  assert.match(dated.body, /name="follow_up" type="date" value="2026-12-04"/);
  const same = await post(env, path, { lead_status: "not_a_fit", follow_up: "" });
  assert.equal(same.res.status, 422);
  assert.match(same.body, /Nothing to change/);
  const qualified = await post(env, path, { lead_status: "qualified", follow_up: "" });
  assert.equal(qualified.res.status, 422);
  assert.match(qualified.body, /Choose one of the options\./);
  assert.equal(await auditCount(db), before);
});

test("a stale status menu never puts back a status changed since: only a changed select sends it; a date alone still works", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const id = await addLead(env);
  const ai = { db, now: new Date(), actor: "ai" as const, tool: "update_contact" };
  await updateContact(ai, id, { leadStatus: "not_now" });
  const page = await load(env, `/contacts/${id}`);
  const path = `/contacts/${id}/lead-status`;
  const fields = formFields(page.body, path);
  assert.match(formOf(page.body, path), /<input type="hidden" name="was\.lead_status" value="[A-Za-z0-9_-]{22}">/);
  const send = (changes: Record<string, string>) => {
    const body = new URLSearchParams(fields);
    for (const [name, value] of Object.entries(changes)) body.set(name, value);
    return post(env, path, body, { cookie: page.cookie, token: page.token });
  };
  const tasks = async () => (await db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE contact_id = ?").bind(id).first<{ n: number }>())?.n;

  const dated = await send({ follow_up: "2026-12-04" });
  assert.equal(dated.res.status, 303, "a check-back date alone, the select left as drawn");
  assert.match((await auditOf(db, changeIdOf(dated.location)))?.summary ?? "", /^Added task "Check back with Lee Example" for Lee Example, due Fri Dec 4/);
  assert.equal(await tasks(), 1);

  await updateContact(ai, id, { leadStatus: "contacted" });
  const before = await auditCount(db);
  const untouched = await send({ follow_up: "" });
  assert.equal(untouched.res.status, 422);
  assert.match(untouched.body, /Nothing to change/);
  const staleDate = await send({ follow_up: "2026-12-05" });
  assert.equal(staleDate.res.status, 422, "the lead is Contacted now, so a check-back date is refused");
  assert.match(staleDate.body, /A check-back date only goes with Not now/);
  const changed = await send({ lead_status: "bad", follow_up: "" });
  assert.equal(changed.res.status, 422);
  assert.match(changed.body, /The lead status was changed while you were saving\./);
  assert.match(changed.body, /<option value="contacted" selected>Contacted<\/option>/, "the saved status is shown");
  assert.equal(await auditCount(db), before);
  assert.equal((await contact(db, id))?.lead_status, "contacted");
  assert.equal(await tasks(), 1);
});

test("an archived lead's page has the status line only and goes back to Contacts", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const id = await addLead(env);
  db.exec(`UPDATE contacts SET archived = 1 WHERE id = '${id}'`);
  const main = mainOf((await load(env, `/contacts/${id}`)).body);
  assert.match(main, /Lead status: New, since/);
  assert.match(main, /<p class="back"><a href="\/contacts">Back to contacts<\/a><\/p>/);
  for (const bad of [/lead-status"/, /\/qualify/, /claude\.ai/, /href="\/leads"/]) assert.doesNotMatch(main, bad, String(bad));
});

test("the Qualify page: Create a deal ticked, the open stages, and the deal's details; named safely", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const id = await addLead(env);
  const { res, body } = await load(env, `/contacts/${id}/qualify`);
  assert.equal(res.status, 200);
  assert.equal(h1Count(body), 1);
  assert.match(body, /<h1>Qualify Lee Example<\/h1>/);
  const form = formOf(body, `/contacts/${id}/qualify`);
  assert.match(form, /novalidate>/);
  assert.match(form, /<input id="qualify-create_deal" name="create_deal" type="checkbox" value="yes" checked>/);
  assert.match(form, /<label for="qualify-create_deal">Create a deal<\/label>/);
  assert.match(form, /<select id="qualify-stage" name="stage"[^>]*>\n<option value="new_inquiry" selected>New inquiry<\/option>/);
  assert.doesNotMatch(form, /value="won"|value="lost"|value="not_now"/, "open stages only");
  for (const label of ["Deal title", "Value", "Next step"]) assert.match(form, new RegExp(`<label for="qualify-[a-z_]+">${label}</label>`), label);
  assert.match(form, /<legend>Next date<\/legend>/);
  assert.match(form, /<button class="button" type="submit">Qualify<\/button>/);
  assert.match(form, new RegExp(`<a class="form-cancel" href="/contacts/${id}">Cancel</a>`));
  db.exec(`UPDATE contacts SET untrusted_fields = '["name"]' WHERE id = '${id}'`);
  const outside = (await load(env, `/contacts/${id}/qualify`)).body;
  assert.match(outside, /<h1>Qualify this lead<\/h1>/);
  assert.doesNotMatch(titleOf(outside), /Lee/);
});

test("Qualify with a deal: one qualify_lead change, the deal page; Undo goes back to the lead's page", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const id = await addLead(env);
  const before = await auditCount(db);
  const { res, location } = await post(env, `/contacts/${id}/qualify`, {
    create_deal: "yes",
    stage: "replied",
    title: "Shop sign",
    value: "900",
    next_step: "Send a sketch",
    "next_at.date": "",
    "next_at.time": "",
    return_to: `/contacts/${id}`,
  });
  assert.equal(res.status, 303);
  assert.match(location, /^\/deals\/dl_[a-z0-9]{12}\?change=chg_/);
  await assertOneChange(db, before, location, "qualify_lead");
  const dealId = /^\/deals\/(dl_[a-z0-9]+)/.exec(location)?.[1] ?? "";
  const row = await deal(db, dealId);
  assert.deepEqual([row?.stage_key, row?.title, row?.value, row?.next_step], ["replied", "Shop sign", 900, "Send a sketch"]);
  assert.equal((await contact(db, id))?.lead_status, "qualified");
  const back = await undo(env, location, `/deals/${dealId}`);
  assert.match(back, new RegExp(`^/contacts/${id}\\?change=chg_`), "the deal is gone; its person is still there");
  assert.equal((await contact(db, id))?.lead_status, "new");
});

test("Qualify with Create a deal unticked: no deal, back to the contact; deal details without a deal are refused", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const id = await addLead(env);
  const before = await auditCount(db);
  const details = await post(env, `/contacts/${id}/qualify`, { stage: "new_inquiry", title: "Shop sign", value: "", next_step: "" });
  assert.equal(details.res.status, 422);
  assert.match(details.body, /Deal details only go with a deal\. Tick Create a deal, or clear the deal details\./);
  assert.match(details.body, /<input id="qualify-create_deal" name="create_deal" type="checkbox" value="yes">/, "still unticked");
  assert.match(details.body, /name="title" type="text" value="Shop sign"/);
  const bad = await post(env, `/contacts/${id}/qualify`, { create_deal: "yes", stage: "new_inquiry", value: "lots" });
  assert.equal(bad.res.status, 422);
  assert.match(bad.body, /<a href="#qualify-value">Give a number of 0 or more\.<\/a>/);
  assert.match(bad.body, /type="checkbox" value="yes" checked>/);
  assert.equal(await auditCount(db), before);
  const plain = await post(env, `/contacts/${id}/qualify`, { stage: "new_inquiry", title: "", value: "", next_step: "", "next_at.date": "", "next_at.time": "" });
  assert.equal(plain.res.status, 303);
  assert.match(plain.location, new RegExp(`^/contacts/${id}\\?change=chg_`));
  await assertOneChange(db, before, plain.location, "qualify_lead");
  assert.equal((await contact(db, id))?.lead_status, "qualified");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM deals WHERE contact_id = ?").bind(id).first<{ n: number }>())?.n, 0);
});

test("Back to leads is on open, lost and not now deals that are not archived, never on won or archived ones", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const has = async (dealId: string) => formOf((await load(env, `/deals/${dealId}`)).body, `/deals/${dealId}/return-to-lead`) !== "";
  assert.ok(await has("dl_seed01"), "open");
  assert.ok(await has("dl_seed08"), "lost");
  assert.equal(await has("dl_seed07"), false, "won");
  db.exec("UPDATE deals SET status = 'not_now', stage_key = 'not_now' WHERE id = 'dl_seed03'");
  assert.ok(await has("dl_seed03"), "not now");
  db.exec("UPDATE deals SET archived = 1 WHERE id = 'dl_seed01'");
  assert.equal(await has("dl_seed01"), false, "archived");
  assert.match(formOf((await load(env, "/deals/dl_seed08")).body, "/deals/dl_seed08/return-to-lead"), /<button class="button button-quiet button-small" type="submit">Back to leads<\/button>/);
});

test("Back to leads is hidden while the person has another open deal, and a post for it is refused without asking first", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  db.exec("UPDATE deals SET contact_id = 'ct_seed01' WHERE id = 'dl_seed03'");
  assert.equal(formOf((await load(env, "/deals/dl_seed01")).body, "/deals/dl_seed01/return-to-lead"), "");
  const before = await auditCount(db);
  const ask = await post(env, "/deals/dl_seed01/return-to-lead", { return_to: "/deals/dl_seed01" });
  assert.equal(ask.res.status, 422);
  assert.doesNotMatch(ask.body, /Move back to leads\?/);
  assert.match(ask.body, /Pat Example has another open deal, so they can&#39;t go back to leads\./);
  assert.equal(await auditCount(db), before);
  db.exec("UPDATE deals SET status = 'lost', stage_key = 'lost' WHERE id = 'dl_seed03'");
  assert.equal(formOf((await load(env, "/deals/dl_seed03")).body, "/deals/dl_seed03/return-to-lead"), "", "a lost deal whose person has an open one");
  assert.ok(formOf((await load(env, "/deals/dl_seed01")).body, "/deals/dl_seed01/return-to-lead"), "no other open deal now");
});

test("Back to leads asks first, with a status defaulting to Contacted; confirming is one return_to_lead change, undoable", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const before = await auditCount(db);
  const ask = await post(env, "/deals/dl_seed01/return-to-lead", { return_to: "/deals/dl_seed01" });
  assert.equal(ask.res.status, 200);
  assert.equal(await auditCount(db), before, "nothing is written before the confirm");
  assert.match(ask.body, /<h1>Move back to leads\?<\/h1>/);
  assert.match(ask.body, /This archives the deal and makes the person a lead again\. Their notes, timeline and tasks stay\. You can undo it\./);
  const confirm = formOf(ask.body, "/deals/dl_seed01/return-to-lead");
  assert.match(confirm, /<input type="hidden" name="confirm" value="yes">/);
  assert.match(confirm, /<label for="return-status">Lead status<\/label>/);
  assert.match(confirm, /<option value="contacted" selected>Contacted<\/option>/);
  assert.equal(confirm.match(/<option /g)?.length, 5);
  assert.match(confirm, /<button class="button" type="submit">Move back to leads<\/button>/);
  assert.match(ask.body, /<a class="confirm-cancel" href="\/deals\/dl_seed01">Keep the deal<\/a>/);

  const fields = formFields(ask.body, "/deals/dl_seed01/return-to-lead");
  fields.set("status", "not_now");
  const { res, location } = await post(env, "/deals/dl_seed01/return-to-lead", fields, { cookie: ask.cookie, token: ask.token });
  assert.equal(res.status, 303);
  assert.match(location, /^\/contacts\/ct_seed01\?change=chg_/);
  await assertOneChange(db, before, location, "return_to_lead");
  assert.equal((await deal(db, "dl_seed01"))?.archived, 1);
  assert.equal((await contact(db, "ct_seed01"))?.lead_status, "not_now");
  assert.match(mainOf((await load(env, location)).body), /Lead status: Not now, since/);
  await undo(env, location, "/contacts/ct_seed01");
  assert.equal((await deal(db, "dl_seed01"))?.archived, 0);
  assert.equal((await contact(db, "ct_seed01"))?.lead_status, null);
});

test("Back to leads refused (a won deal, a person with another open deal) is a 422 with the reason", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const before = await auditCount(db);
  const won = await post(env, "/deals/dl_seed07/return-to-lead", { confirm: "yes", status: "contacted" });
  assert.equal(won.res.status, 422);
  assert.match(won.body, /<h1>The deal wasn&#39;t moved back to leads<\/h1>/);
  assert.match(won.body, /is Won, so it was a real opportunity/);
  db.exec("UPDATE deals SET contact_id = 'ct_seed01' WHERE id = 'dl_seed03'");
  const other = await post(env, "/deals/dl_seed01/return-to-lead", { confirm: "yes", status: "contacted" });
  assert.equal(other.res.status, 422);
  assert.match(other.body, /has another open deal/);
  const unknown = await post(env, "/deals/dl_seed01/return-to-lead", { confirm: "yes", status: "qualified" });
  assert.equal(unknown.res.status, 422);
  assert.equal(await auditCount(db), before);
  assert.equal((await post(env, "/deals/dl_nothing0000/return-to-lead", { confirm: "yes" })).res.status, 404);
});

test("every lead route sits behind the same checks: a cross-site origin or a missing token writes nothing", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const id = await addLead(env);
  const before = await auditCount(db);
  const routes: [string, Record<string, string>][] = [
    ["/leads/new", { name: "Kim Example" }],
    ["/deals/new", { name: "Kim Example" }],
    [`/contacts/${id}/lead-status`, { lead_status: "bad" }],
    [`/contacts/${id}/qualify`, { create_deal: "yes" }],
    ["/deals/dl_seed01/return-to-lead", { confirm: "yes" }],
  ];
  for (const [path, fields] of routes) {
    assert.equal((await post(env, path, fields, { origin: "https://evil.example" })).res.status, 403, `${path} cross-site`);
    const page = await load(env, "/pipeline");
    const noToken = await post(env, path, { ...fields, csrf: "" }, { cookie: page.cookie, token: "" });
    assert.equal(noToken.res.status, 403, `${path} without the token`);
  }
  assert.equal(await auditCount(db), before);
});
