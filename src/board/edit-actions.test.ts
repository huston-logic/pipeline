// The board's editing posts (decision 0018) through the Worker: each one is one audited change by the owner under the
// MCP tool's name, a refused one is a 422 with the message and the values kept, and an unknown or malformed id is 404.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auditCount,
  auditOf,
  changeIdOf,
  devEnv,
  formFields,
  h1Count,
  load,
  post,
  seededDb,
} from "../../tests/helpers/board.ts";
import type { ContactRow, DealRow, TaskRow } from "../db/db.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import { addField } from "../services/fields.ts";
import { updateContact } from "../services/contacts.ts";
import { DEFAULT_TZ, localDate, zonedToUtc } from "../time.ts";
import { snoozePresets } from "./snooze.ts";

const contact = (db: SqliteD1, id: string) => db.prepare("SELECT * FROM contacts WHERE id = ?").bind(id).first<ContactRow>();
const deal = (db: SqliteD1, id: string) => db.prepare("SELECT * FROM deals WHERE id = ?").bind(id).first<DealRow>();
const task = (db: SqliteD1, id: string) => db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<TaskRow>();

/** One write by the owner under `tool`, and nothing else. */
async function assertOneChange(db: SqliteD1, before: number, location: string, tool: string) {
  assert.equal(await auditCount(db), before + 1, "exactly one audit row");
  const audit = await auditOf(db, changeIdOf(location));
  assert.equal(audit?.actor, "owner");
  assert.equal(audit?.tool, tool);
}

/** The edit form as the page draws it, ready to post unchanged or with some fields changed. */
async function editForm(db: SqliteD1, path: string) {
  const page = await load(devEnv(db), path);
  return { fields: formFields(page.body, path), cookie: page.cookie, token: page.token };
}

test("Add a deal for a new person: one add_deal change by the owner, then the new deal's page with the banner", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const before = await auditCount(db);
  const { res, location } = await post(env, "/deals/new", {
    name: "Lee Example",
    email: "lee@example.com",
    title: "Garage plans",
    value: "2,400",
    "next_at.date": "2026-12-01",
    "next_at.time": "10:30",
    notes: "Wants plans for a garage.",
    return_to: "/pipeline",
  });
  assert.equal(res.status, 303);
  assert.match(location, /^\/deals\/dl_[a-z0-9]{12}\?change=chg_[a-z0-9]{12}$/);
  await assertOneChange(db, before, location, "add_deal");
  const id = /^\/deals\/(dl_[a-z0-9]+)/.exec(location)?.[1] ?? "";
  const row = await deal(db, id);
  assert.equal(row?.title, "Garage plans");
  assert.equal(row?.value, 2400);
  assert.equal(row?.next_at, zonedToUtc("2026-12-01T10:30", DEFAULT_TZ).toISOString());
  const shown = (await load(env, location)).body;
  assert.match(shown, /<p class="banner-text">Added contact Lee Example with deal &quot;Garage plans&quot; in /);
});

test("Add a deal with an email already on file adds the deal to that contact, and the banner says so", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const { location } = await post(env, "/deals/new", { name: "P. Example", email: "PAT@example.com", title: "Second site" });
  const id = /^\/deals\/(dl_[a-z0-9]+)/.exec(location)?.[1] ?? "";
  assert.equal((await deal(db, id))?.contact_id, "ct_seed01");
  assert.match((await load(env, location)).body, /Added deal &quot;Second site&quot; for existing contact Pat Example in /);
});

test("a refused Add a deal is a 422 with an error summary linking each field, the values kept and nothing written", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const before = await auditCount(db);
  const { res, body } = await post(env, "/deals/new", { name: "", email: "lee@example.com", value: "lots", "next_at.date": "", "next_at.time": "09:00", return_to: "/contacts" });
  assert.equal(res.status, 422);
  assert.equal(await auditCount(db), before);
  assert.equal(h1Count(body), 1);
  assert.match(body, /<title>Error: Add a deal · Pipeline<\/title>/);
  assert.match(body, /<div class="error-summary" role="alert" aria-labelledby="error-summary-heading" tabindex="-1" autofocus>\n<h2 id="error-summary-heading">3 things to fix<\/h2>/);
  assert.match(body, /<li><a href="#deal-name">Give the person&#39;s name\.<\/a><\/li>/);
  assert.match(body, /<li><a href="#deal-value">Give a number of 0 or more\.<\/a><\/li>/);
  assert.match(body, /<li><a href="#deal-next_at-date">Give a date for this time, or clear the time\.<\/a><\/li>/);
  assert.match(body, /<input id="deal-name" name="name" type="text" value="" autocomplete="off" required maxlength="500" aria-describedby="deal-name-error" aria-invalid="true">/);
  assert.match(body, /name="email" type="email" value="lee@example\.com"/, "the values are kept");
  assert.match(body, /name="value" type="text" value="lots"/);
  assert.match(body, /<a class="form-cancel" href="\/contacts">Cancel<\/a>/, "Cancel still goes back where it came from");
});

test("Edit contact: only the changed field is written, as update_contact by the owner, then back to the contact", async () => {
  const db = await seededDb();
  const { fields, cookie, token } = await editForm(db, "/contacts/ct_seed01/edit");
  fields.set("phone", "555-0199");
  const before = await auditCount(db);
  const { res, location } = await post(devEnv(db), "/contacts/ct_seed01/edit", fields, { cookie, token });
  assert.equal(res.status, 303);
  assert.match(location, /^\/contacts\/ct_seed01\?change=chg_/);
  await assertOneChange(db, before, location, "update_contact");
  const audit = await auditOf(db, changeIdOf(location));
  assert.match(audit?.summary ?? "", /^Updated Pat Example: phone \(change chg_/);
  assert.equal((await contact(db, "ct_seed01"))?.phone, "555-0199");
});

test("re-saving a contact whose values came from outside keeps them marked as outside: nothing is confirmed by accident", async () => {
  const db = await seededDb();
  const { fields, cookie, token } = await editForm(db, "/contacts/ct_seed02/edit");
  const unchanged = await post(devEnv(db), "/contacts/ct_seed02/edit", fields, { cookie, token });
  assert.equal(unchanged.res.status, 422);
  assert.match(unchanged.body, /Nothing to save: every field is as it was\./);
  assert.equal((await contact(db, "ct_seed02"))?.untrusted_fields, '["name","email","business"]');

  fields.set("phone", "555-0142");
  const changed = await post(devEnv(db), "/contacts/ct_seed02/edit", fields, { cookie, token });
  assert.equal(changed.res.status, 303);
  const row = await contact(db, "ct_seed02");
  assert.equal(row?.phone, "555-0142");
  assert.equal(row?.untrusted_fields, '["name","email","business"]', "the outside name, email and company stay outside text");
  assert.equal(row?.name, "Robin Sample");
});

test("an outside email a browser would reject (intake accepts it) doesn't block saving another field", async () => {
  const db = await seededDb();
  db.exec(`UPDATE contacts SET email = 'robin@exa_mple.com' WHERE id = 'ct_seed02'`);
  const { body, cookie, token } = await load(devEnv(db), "/contacts/ct_seed02/edit");
  assert.match(body, /action="\/contacts\/ct_seed02\/edit" novalidate>/, "the browser's email rule is off; the server checks");
  const fields = formFields(body, "/contacts/ct_seed02/edit");
  fields.set("phone", "555-0143");
  assert.equal((await post(devEnv(db), "/contacts/ct_seed02/edit", fields, { cookie, token })).res.status, 303);
  const row = await contact(db, "ct_seed02");
  assert.equal(row?.phone, "555-0143");
  assert.equal(row?.email, "robin@exa_mple.com");
  assert.equal(row?.untrusted_fields, '["name","email","business"]');
});

test("a stored value a date input can't show comes back empty from the browser, and is kept, still from outside", async () => {
  const db = await seededDb();
  await addField({ db, now: new Date(), actor: "owner", tool: "add_field" }, { entity: "contact", label: "Met on", type: "date" });
  db.exec(`UPDATE contacts SET fields = '{"met_on":"next spring"}', untrusted_fields = '["name","email","business","fields.met_on"]' WHERE id = 'ct_seed02'`);
  const { body, cookie, token } = await load(devEnv(db), "/contacts/ct_seed02/edit");
  const fields = formFields(body, "/contacts/ct_seed02/edit");
  fields.set("cf.met_on", ""); // what a browser sends for a date input whose value isn't a date
  fields.set("phone", "555-0144");
  assert.equal((await post(devEnv(db), "/contacts/ct_seed02/edit", fields, { cookie, token })).res.status, 303);
  const row = await contact(db, "ct_seed02");
  assert.equal(row?.phone, "555-0144");
  assert.equal(row?.fields, '{"met_on":"next spring"}');
  assert.equal(row?.untrusted_fields, '["name","email","business","fields.met_on"]');
});

test("a value posted back in another spelling of the same thing (1,500 for 1500) is not a change", async () => {
  const db = await seededDb();
  const { fields, cookie, token } = await editForm(db, "/deals/dl_seed01/edit");
  fields.set("value", "1,500");
  const { res, body } = await post(devEnv(db), "/deals/dl_seed01/edit", fields, { cookie, token });
  assert.equal(res.status, 422);
  assert.match(body, /Nothing to save/);
});

test("changing an outside value makes it the owner's: that field leaves untrusted_fields, the others stay", async () => {
  const db = await seededDb();
  const { fields, cookie, token } = await editForm(db, "/contacts/ct_seed02/edit");
  fields.set("business", "Sample Bakery Ltd");
  await post(devEnv(db), "/contacts/ct_seed02/edit", fields, { cookie, token });
  assert.equal((await contact(db, "ct_seed02"))?.untrusted_fields, '["name","email"]');
});

test("a record form may be bigger than other board posts: 10,000 accented characters of notes and a phone edit save", async () => {
  const db = await seededDb();
  const notes = "é".repeat(10_000);
  db.exec(`UPDATE contacts SET notes = '${notes}' WHERE id = 'ct_seed01'`);
  const { fields, cookie, token } = await editForm(db, "/contacts/ct_seed01/edit");
  assert.ok(fields.toString().length > 16 * 1024, "the form is over the 16 KB other posts get");
  fields.set("phone", "555-0199");
  const { res } = await post(devEnv(db), "/contacts/ct_seed01/edit", fields, { cookie, token });
  assert.equal(res.status, 303);
  const row = await contact(db, "ct_seed01");
  assert.equal(row?.phone, "555-0199");
  assert.equal(row?.notes, notes, "the notes are left as they were");

  fields.set("notes", "x".repeat(130 * 1024));
  assert.equal((await post(devEnv(db), "/contacts/ct_seed01/edit", fields, { cookie, token })).res.status, 413, "128 KB is still a limit");
  const big = await post(devEnv(db), "/deals/dl_seed01/tasks", { title: "x".repeat(17 * 1024) });
  assert.equal(big.res.status, 413, "other board posts keep 16 KB");
});

test("clearing an optional field sets it to null", async () => {
  const db = await seededDb();
  const { fields, cookie, token } = await editForm(db, "/contacts/ct_seed01/edit");
  fields.set("source", "");
  assert.equal((await post(devEnv(db), "/contacts/ct_seed01/edit", fields, { cookie, token })).res.status, 303);
  assert.equal((await contact(db, "ct_seed01"))?.source, null);
});

test("a field changed by someone else while the form was open is a conflict: nothing is saved, the new value is shown", async () => {
  const db = await seededDb();
  const { fields, cookie, token } = await editForm(db, "/contacts/ct_seed01/edit");
  await updateContact({ db, now: new Date(), actor: "ai", tool: "update_contact" }, "ct_seed01", { phone: "555-0150" });
  const before = await auditCount(db);
  fields.set("phone", "555-0199");
  const { res, body } = await post(devEnv(db), "/contacts/ct_seed01/edit", fields, { cookie, token });
  assert.equal(res.status, 422);
  assert.equal(await auditCount(db), before);
  assert.match(body, /<a href="#contact-phone">Phone was changed while you were editing\./);
  assert.match(body, /name="phone" type="tel" value="555-0150"/);
});

test("a refused edit shows the service's own reason too: an email another contact uses", async () => {
  const db = await seededDb();
  const { fields, cookie, token } = await editForm(db, "/contacts/ct_seed01/edit");
  fields.set("email", "casey@example.com");
  const { res, body } = await post(devEnv(db), "/contacts/ct_seed01/edit", fields, { cookie, token });
  assert.equal(res.status, 422);
  assert.match(body, /<li>Casey Placeholder \(ct_seed03\) already uses casey@example\.com\./);
  assert.match(body, /name="email" type="email" value="casey@example\.com"/);
});

test("Edit deal: value and the next date in the owner's time, as update_deal; the stage is not touched", async () => {
  const db = await seededDb();
  const { fields, cookie, token } = await editForm(db, "/deals/dl_seed01/edit");
  fields.set("value", "1750");
  fields.set("next_at.date", "2026-12-03");
  fields.set("next_at.time", "");
  const before = await auditCount(db);
  const { res, location } = await post(devEnv(db), "/deals/dl_seed01/edit", fields, { cookie, token });
  assert.equal(res.status, 303);
  assert.match(location, /^\/deals\/dl_seed01\?change=chg_/);
  await assertOneChange(db, before, location, "update_deal");
  const row = await deal(db, "dl_seed01");
  assert.equal(row?.value, 1750);
  assert.equal(row?.next_at, zonedToUtc("2026-12-03", DEFAULT_TZ).toISOString());
  assert.equal(row?.stage_key, "call_booked");
  assert.equal(row?.next_step, "Discovery call");
});

test("New deal for a contact: add_deal with that contact, then the new deal's page; a missing title is refused", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const before = await auditCount(db);
  const { res, location } = await post(env, "/contacts/ct_seed07/deals/new", { title: "Gift cards page", value: "300" });
  assert.equal(res.status, 303);
  await assertOneChange(db, before, location, "add_deal");
  const id = /^\/deals\/(dl_[a-z0-9]+)/.exec(location)?.[1] ?? "";
  assert.equal((await deal(db, id))?.contact_id, "ct_seed07");
  const refused = await post(env, "/contacts/ct_seed07/deals/new", { title: " ", value: "300" });
  assert.equal(refused.res.status, 422);
  assert.match(refused.body, /<a href="#deal-title">Give the deal a title\.<\/a>/);
  assert.match(refused.body, /name="value" type="text" value="300"/);
});

test("Add a task on a deal and on a contact: add_task by the owner, back to the page", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  let before = await auditCount(db);
  const onDeal = await post(env, "/deals/dl_seed01/tasks", { title: "Send the plan", "due.date": "2026-12-02", "due.time": "15:00", return_to: "/deals/dl_seed01" });
  assert.equal(onDeal.res.status, 303);
  assert.match(onDeal.location, /^\/deals\/dl_seed01\?change=chg_/);
  await assertOneChange(db, before, onDeal.location, "add_task");
  const added = await db.prepare("SELECT * FROM tasks WHERE title = 'Send the plan'").first<TaskRow>();
  assert.equal(added?.deal_id, "dl_seed01");
  assert.equal(added?.due_at, zonedToUtc("2026-12-02T15:00", DEFAULT_TZ).toISOString());

  before = await auditCount(db);
  const onContact = await post(env, "/contacts/ct_seed06/tasks", { title: "Call Morgan", return_to: "/contacts/ct_seed06" });
  await assertOneChange(db, before, onContact.location, "add_task");
  const contactTask = await db.prepare("SELECT * FROM tasks WHERE title = 'Call Morgan'").first<TaskRow>();
  assert.equal(contactTask?.deal_id, null);
  assert.equal(contactTask?.contact_id, "ct_seed06");
});

test("a refused task is a 422 page with the message and the values kept", async () => {
  const db = await seededDb();
  const before = await auditCount(db);
  const { res, body } = await post(devEnv(db), "/deals/dl_seed01/tasks", { title: "", "due.date": "2026-12-02", "due.time": "", return_to: "/deals/dl_seed01" });
  assert.equal(res.status, 422);
  assert.equal(await auditCount(db), before);
  assert.equal(h1Count(body), 1);
  assert.match(body, /<h1>The task wasn&#39;t added<\/h1>/);
  assert.match(body, /<a href="#task-dl_seed01-title">Say in a few words what to do\.<\/a>/);
  assert.match(body, /name="due\.date" type="date" value="2026-12-02"/);
  assert.match(body, /<a href="\/deals\/dl_seed01">Back to the page<\/a>/);
});

test("Done: complete_task in one tap; a task already done is refused; an unknown or malformed task is 404", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const before = await auditCount(db);
  const done = await post(env, "/tasks/tk_seed01/complete", { return_to: "/" });
  assert.equal(done.res.status, 303);
  assert.match(done.location, /^\/\?change=chg_/);
  await assertOneChange(db, before, done.location, "complete_task");
  assert.ok((await task(db, "tk_seed01"))?.done_at);
  const again = await post(env, "/tasks/tk_seed01/complete", { return_to: "/" });
  assert.equal(again.res.status, 422);
  assert.match(again.body, /<h1>The task wasn&#39;t marked done<\/h1>/);
  assert.match(again.body, /is already done/);
  for (const path of ["/tasks/tk_nothing0000/complete", "/tasks/bad/complete", "/tasks/tk_nothing0000/snooze"]) {
    assert.equal((await post(env, path, { preset: "tomorrow" })).res.status, 404, path);
  }
});

test("Snooze: the presets are 9:00 tomorrow and next Monday at 9:00 in the owner's time; a date and time works too", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const presets = snoozePresets(new Date(), DEFAULT_TZ);
  const before = await auditCount(db);
  const tomorrow = await post(env, "/tasks/tk_seed02/snooze", { preset: "tomorrow", return_to: "/" });
  assert.equal(tomorrow.res.status, 303);
  await assertOneChange(db, before, tomorrow.location, "snooze_task");
  assert.equal((await task(db, "tk_seed02"))?.snoozed_until, zonedToUtc(presets.tomorrow, DEFAULT_TZ).toISOString());
  await post(env, "/tasks/tk_seed02/snooze", { preset: "next_week", return_to: "/" });
  assert.equal((await task(db, "tk_seed02"))?.snoozed_until, zonedToUtc(presets.nextWeek, DEFAULT_TZ).toISOString());
  await post(env, "/tasks/tk_seed02/snooze", { "until.date": "2027-01-04", "until.time": "", return_to: "/" });
  assert.equal((await task(db, "tk_seed02"))?.snoozed_until, zonedToUtc("2027-01-04T09:00", DEFAULT_TZ).toISOString(), "no time is 9:00");
  await post(env, "/tasks/tk_seed02/snooze", { "until.date": "2027-01-05", "until.time": "13:15", return_to: "/" });
  assert.equal((await task(db, "tk_seed02"))?.snoozed_until, zonedToUtc("2027-01-05T13:15", DEFAULT_TZ).toISOString());
});

test("a refused snooze (no date, a time in the past) is a 422 page with the snooze forms and the message", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const before = await auditCount(db);
  const none = await post(env, "/tasks/tk_seed02/snooze", { "until.date": "", "until.time": "", return_to: "/" });
  assert.equal(none.res.status, 422);
  assert.match(none.body, /<h1>The task wasn&#39;t snoozed<\/h1>/);
  assert.match(none.body, /<a href="\/pipeline" aria-current="true">/, "the nav marks the task's deal's section");
  assert.match(none.body, /<a href="#snooze-tk_seed02-date">Give a date to snooze it until\.<\/a>/);
  const yesterday = localDate(new Date(Date.now() - 86_400_000), DEFAULT_TZ);
  const past = await post(env, "/tasks/tk_seed02/snooze", { "until.date": yesterday, "until.time": "10:00", return_to: "/" });
  assert.equal(past.res.status, 422);
  assert.match(past.body, /has already passed/);
  assert.match(past.body, new RegExp(`name="until\\.date" type="date" value="${yesterday}"`));
  assert.equal(await auditCount(db), before);
});

test("Log on a deal and on a contact: log_activity by the owner, at now or at the time given", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  let before = await auditCount(db);
  const now = await post(env, "/deals/dl_seed01/log", { type: "call", summary: "Talked through the plan.", "when.date": "", "when.time": "", return_to: "/deals/dl_seed01" });
  assert.equal(now.res.status, 303);
  await assertOneChange(db, before, now.location, "log_activity");
  const call = await db.prepare("SELECT * FROM activities WHERE summary = 'Talked through the plan.'").first<{ type: string; actor: string; deal_id: string }>();
  assert.deepEqual([call?.type, call?.actor, call?.deal_id], ["call", "owner", "dl_seed01"]);

  before = await auditCount(db);
  const yesterday = localDate(new Date(Date.now() - 86_400_000), DEFAULT_TZ);
  const earlier = await post(env, "/contacts/ct_seed06/log", { type: "meeting", summary: "Met at the yard.", "when.date": yesterday, "when.time": "11:00", return_to: "/contacts/ct_seed06" });
  await assertOneChange(db, before, earlier.location, "log_activity");
  const meeting = await db.prepare("SELECT * FROM activities WHERE summary = 'Met at the yard.'").first<{ occurred_at: string; contact_id: string }>();
  assert.equal(meeting?.occurred_at, zonedToUtc(`${yesterday}T11:00`, DEFAULT_TZ).toISOString());
  assert.equal(meeting?.contact_id, "ct_seed06");
});

test("a refused log (no summary, a date without a time, a type that can't be logged) is a 422 with the values kept", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const before = await auditCount(db);
  const blank = await post(env, "/deals/dl_seed01/log", { type: "email", summary: "", "when.date": "2026-11-01", "when.time": "", return_to: "/deals/dl_seed01" });
  assert.equal(blank.res.status, 422);
  assert.match(blank.body, /<h1>Nothing was logged<\/h1>/);
  assert.match(blank.body, /<a href="#log-dl_seed01-summary">Say in a few words what happened\.<\/a>/);
  assert.match(blank.body, /<a href="#log-dl_seed01-when-date">Give the time too, or leave both blank for now\.<\/a>/);
  assert.match(blank.body, /<option value="email" selected>Email<\/option>/);
  const form = await post(env, "/deals/dl_seed01/log", { type: "form", summary: "Hello" });
  assert.equal(form.res.status, 422);
  assert.match(form.body, /Choose one of the options\./);
  assert.equal(await auditCount(db), before);
});

test("every new write route sits behind the same checks: a cross-site origin or a missing token writes nothing", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const before = await auditCount(db);
  const routes: [string, Record<string, string>][] = [
    ["/deals/new", { name: "Lee Example" }],
    ["/contacts/ct_seed01/edit", { phone: "555-0100" }],
    ["/deals/dl_seed01/edit", { value: "10" }],
    ["/contacts/ct_seed01/deals/new", { title: "Another" }],
    ["/deals/dl_seed01/tasks", { title: "Task" }],
    ["/contacts/ct_seed01/tasks", { title: "Task" }],
    ["/tasks/tk_seed01/complete", {}],
    ["/tasks/tk_seed01/snooze", { preset: "tomorrow" }],
    ["/deals/dl_seed01/log", { type: "note", summary: "Note" }],
    ["/contacts/ct_seed01/log", { type: "note", summary: "Note" }],
  ];
  for (const [path, fields] of routes) {
    assert.equal((await post(env, path, fields, { origin: "https://evil.example" })).res.status, 403, `${path} cross-site`);
    const page = await load(env, "/pipeline");
    const noToken = await post(env, path, { ...fields, csrf: "" }, { cookie: page.cookie, token: "" });
    assert.equal(noToken.res.status, 403, `${path} without the token`);
  }
  assert.equal(await auditCount(db), before);
});

test("a malformed or unknown record id on every new route is the 404 page", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  for (const path of [
    "/contacts/bad/edit",
    "/contacts/ct_nothing0000/edit",
    "/deals/%3Cx%3E/edit",
    "/deals/dl_nothing0000/edit",
    "/contacts/ct_nothing0000/deals/new",
    "/deals/dl_nothing0000/tasks",
    "/contacts/bad/tasks",
    "/deals/dl_nothing0000/log",
    "/contacts/ct_nothing0000/log",
  ]) {
    const { res, body } = await post(env, path, { title: "x", summary: "x", type: "note" });
    assert.equal(res.status, 404, path);
    assert.match(body, /<h1>Page not found<\/h1>/, path);
  }
});

test("undoing a new person's deal from its deal page goes to the pipeline, because the deal and the person are gone", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const added = await post(env, "/deals/new", { name: "Lee Example", title: "Garage plans" });
  const dealPath = added.location.split("?")[0] ?? "";
  const undone = await post(env, `/changes/${changeIdOf(added.location)}/undo`, { confirm: "yes", return_to: dealPath });
  assert.equal(undone.res.status, 303);
  assert.match(undone.location, /^\/pipeline\?change=chg_/);
});

test("the undo confirm page says what it removes in words that fit one record or many", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const added = await post(env, "/deals/dl_seed01/tasks", { title: "Send the plan", return_to: "/deals/dl_seed01" });
  const ask = await post(env, `/changes/${changeIdOf(added.location)}/undo`, { return_to: "/deals/dl_seed01" });
  assert.equal(ask.res.status, 200);
  assert.match(ask.body, /<p class="lede">It removes 1 task\. This can't be reversed\.<\/p>/);
});

test("Done on a task with open sub-tasks asks first; Complete them too and Only this task each finish in one change", async () => {
  const db = await seededDb();
  db.exec(
    "UPDATE settings SET projects = 1; " +
      "INSERT INTO projects (id, name, contact_id, status_key) VALUES ('pj_b2', 'Retrofit', 'ct_seed01', 'active'); " +
      "INSERT INTO tasks (id, contact_id, project_id, position, title) VALUES ('tk_par1', 'ct_seed01', 'pj_b2', 1, 'Parent one'), ('tk_par2', 'ct_seed01', 'pj_b2', 2, 'Parent two'); " +
      "INSERT INTO tasks (id, contact_id, project_id, parent_id, position, title) VALUES ('tk_kid1', 'ct_seed01', 'pj_b2', 'tk_par1', 1, 'Kid one'), ('tk_kid2', 'ct_seed01', 'pj_b2', 'tk_par2', 1, 'Kid two')",
  );
  const env = devEnv(db);
  const before = await auditCount(db);
  const ask = await post(env, "/tasks/tk_par1/complete", { return_to: "/" });
  assert.equal(ask.res.status, 200);
  assert.equal(await auditCount(db), before);
  assert.match(ask.body, /<h1>Complete its sub-tasks too\?<\/h1>/);
  assert.match(ask.body, /1 open sub-task/);
  assert.match(ask.body, /name="subtasks" value="complete"/);
  assert.match(ask.body, /Complete them too<\/button>/);
  assert.match(ask.body, /name="subtasks" value="leave"/);
  assert.match(ask.body, /Only this task<\/button>/);
  assert.match(ask.body, /<a class="confirm-cancel" href="\/">Cancel<\/a>/);
  assert.match(ask.body, /name="csrf"/);
  const both = await post(env, "/tasks/tk_par1/complete", { return_to: "/", subtasks: "complete" });
  assert.equal(both.res.status, 303);
  await assertOneChange(db, before, both.location, "complete_task");
  assert.ok((await task(db, "tk_par1"))?.done_at);
  assert.ok((await task(db, "tk_kid1"))?.done_at);
  const only = await post(env, "/tasks/tk_par2/complete", { return_to: "/", subtasks: "leave" });
  assert.equal(only.res.status, 303);
  assert.ok((await task(db, "tk_par2"))?.done_at);
  assert.equal((await task(db, "tk_kid2"))?.done_at, null);
});
