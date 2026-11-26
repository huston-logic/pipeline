// The board's record forms as pages (decision 0018): every new form renders on the seed and on an empty database,
// labels every field, marks outside values, and keeps outside text out of titles, labels and link text.
import assert from "node:assert/strict";
import { test } from "node:test";
import { devEnv, h1Count, load, post, seededDb } from "../../tests/helpers/board.ts";
import { createTestDb } from "../db/sqlite-d1.ts";
import { addField } from "../services/fields.ts";

const titleOf = (body: string) => /<title>([^<]*)<\/title>/.exec(body)?.[1] ?? "";
const descriptionOf = (body: string) => /<meta name="description" content="([^"]*)">/.exec(body)?.[1] ?? "";
const mainOf = (body: string) => /<main id="main">([\s\S]*)<\/main>/.exec(body)?.[1] ?? "";
const labels = (body: string) => [...body.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)].map((m) => m[1] ?? "");
const linkTexts = (body: string) => [...body.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1] ?? "");
/** The form posting to `action`, as markup. */
/** The first form posting to `action` (of class `className` when given: the deal page has one-tap Log forms too). */
const formOf = (body: string, action: string, className?: string) => {
  const key = className === undefined ? `action="${action}"` : `<form class="${className}" method="post" action="${action}"`;
  const at = body.indexOf(key);
  const start = at < 0 ? -1 : body.lastIndexOf("<form", at + 1);
  return start < 0 ? "" : body.slice(start, body.indexOf("</form>", start) + 7);
};
/** Every control id has a label for it (or sits in a fieldset with a legend, for a date and time pair). */
function assertLabelled(form: string, where: string) {
  for (const m of form.matchAll(/<(?:input|select|textarea)\b([^>]*)>/g)) {
    const attrs = m[1] ?? "";
    if (/type="hidden"/.test(attrs)) continue;
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    assert.ok(id, `${where}: a control without an id: ${attrs}`);
    assert.match(form, new RegExp(`<label for="${id}">`), `${where}: ${id} has a label`);
  }
}

const OUTSIDE_NAMES = /Robin Sample|Sample Bakery|robin@example\.com|New website for Sample Bakery/;

test("Add a deal: one h1, every field labelled, name required in words, the token, and Cancel back where it came from", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const { res, body } = await load(env, "/deals/new?from=contacts");
  assert.equal(res.status, 200);
  assert.equal(h1Count(body), 1);
  assert.match(body, /<h1>Add a deal<\/h1>/);
  const form = formOf(body, "/deals/new");
  // The server checks every value, so the browser's own rules (stricter than intake's for email) never block a save.
  assert.match(form, /<form class="record-form" method="post" action="\/deals\/new" novalidate>/);
  assert.match(form, /<input type="hidden" name="csrf" value="[A-Za-z0-9_-]{43}">/);
  assert.match(form, /<input type="hidden" name="return_to" value="\/contacts">/);
  assertLabelled(form, "/deals/new");
  assert.match(form, /<label for="deal-name">Name <span class="field-required">\(required\)<\/span><\/label>/);
  for (const label of ["Email", "Phone", "Company", "Source", "Deal title", "Value", "Next step", "Notes"]) {
    assert.ok(labels(form).some((text) => text.startsWith(label)), label);
  }
  assert.match(form, /<legend>Next date<\/legend>/);
  assert.match(form, /<button class="button" type="submit">Add the deal<\/button>/);
  assert.match(form, /<a class="form-cancel" href="\/contacts">Cancel<\/a>/);
  assert.match((await load(env, "/deals/new")).body, /<a class="form-cancel" href="\/pipeline">Cancel<\/a>/, "Pipeline by default");
  assert.match((await load(env, "/deals/new?from=//evil.example")).body, /<a class="form-cancel" href="\/pipeline">Cancel<\/a>/);
  assert.match(body, /<a href="\/pipeline" aria-current="true">/, "a new deal is in the Pipeline section");
});

test("Add a lead and Add a deal on an empty database still render, and custom fields appear by their type", async () => {
  const db = await createTestDb();
  const env = devEnv(db);
  assert.equal((await load(env, "/deals/new")).res.status, 200);
  assert.equal((await load(env, "/leads/new")).res.status, 200);
  const owner = { db, now: new Date(), actor: "owner" as const, tool: "add_field" };
  await addField(owner, { entity: "contact", label: "Role", type: "text" });
  await addField(owner, { entity: "deal", label: "Budget", type: "number" });
  await addField(owner, { entity: "deal", label: "Start date", type: "date" });
  await addField(owner, { entity: "deal", label: "Temperature", type: "choice", choices: ["Cold", "Warm", "Hot"] });
  const form = formOf((await load(env, "/deals/new")).body, "/deals/new");
  assertLabelled(form, "custom fields");
  assert.match(form, /<input id="deal-cf-role" name="cf\.role" type="text" value="" autocomplete="off"/);
  assert.match(form, /<input id="deal-df-budget" name="df\.budget" type="text" value="" autocomplete="off" inputmode="decimal"/);
  assert.match(form, /<input id="deal-df-start_date" name="df\.start_date" type="date" value="">/);
  assert.match(form, /<select id="deal-df-temperature" name="df\.temperature">\n<option value="">Not set<\/option>\n<option value="Cold">Cold<\/option>/);
  const lead = formOf((await load(env, "/leads/new")).body, "/leads/new");
  assertLabelled(lead, "lead custom fields");
  assert.match(lead, /<input id="lead-cf-role" name="cf\.role" type="text" value="" autocomplete="off"/);
  assert.doesNotMatch(lead, /df\./, "a lead has no deal fields");
});

test("Edit contact: the stored values, outside ones labelled beside their label, nothing from outside in the title or labels", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const { res, body } = await load(env, "/contacts/ct_seed02/edit");
  assert.equal(res.status, 200);
  assert.equal(h1Count(body), 1);
  assert.match(body, /<h1>Edit contact ct_seed02<\/h1>/);
  assert.doesNotMatch(titleOf(body), OUTSIDE_NAMES);
  assert.doesNotMatch(descriptionOf(body), OUTSIDE_NAMES);
  for (const text of [...labels(body), ...linkTexts(body)]) assert.doesNotMatch(text, OUTSIDE_NAMES, text);
  const form = formOf(body, "/contacts/ct_seed02/edit");
  assertLabelled(form, "edit contact");
  assert.match(form, /<label for="contact-name">Name <span class="field-required">\(required\)<\/span><\/label> <span class="outside" id="contact-name-outside">From outside<\/span>/);
  assert.match(form, /<label for="contact-email">Email<\/label> <span class="outside" id="contact-email-outside">From outside<\/span>/);
  assert.match(form, /<label for="contact-phone">Phone<\/label>\n/, "the phone was not from outside");
  assert.match(form, /name="name" type="text" value="Robin Sample"/);
  assert.match(form, /<input type="hidden" name="was\.name" value="[A-Za-z0-9_-]{22}">/);
  assert.match(form, /<input type="hidden" name="return_to" value="\/contacts\/ct_seed02">/);
  assert.match(form, /<button class="button" type="submit">Save changes<\/button>/);
  assert.match(form, /<a class="form-cancel" href="\/contacts\/ct_seed02">Cancel<\/a>/);
  assert.match(mainOf(body), /stays marked until you change it/);
  assert.match(body, /<a href="\/contacts" aria-current="true">/);
});

test("Edit deal: title, value, next step and the next date in the owner's time; no stage field", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const { body } = await load(env, "/deals/dl_seed01/edit");
  assert.match(body, /<h1>Edit Website refresh for Example Plumbing<\/h1>/);
  const form = formOf(body, "/deals/dl_seed01/edit");
  assert.match(form, /action="\/deals\/dl_seed01\/edit" novalidate>/);
  assertLabelled(form, "edit deal");
  assert.match(form, /name="title" type="text" value="Website refresh for Example Plumbing"/);
  assert.match(form, /name="value" type="text" value="1500"/);
  assert.match(form, /name="next_step" type="text" value="Discovery call"/);
  assert.match(form, /name="next_at\.date" type="date" value="\d{4}-\d{2}-\d{2}"/);
  assert.match(form, /name="next_at\.time" type="time" value="14:00"/);
  assert.doesNotMatch(form, /name="stage"/);
  assert.match(mainOf(body), /Move to/);

  const outside = await load(env, "/deals/dl_seed02/edit");
  assert.match(outside.body, /<h1>Edit deal dl_seed02<\/h1>/);
  assert.match(outside.body, /<label for="deal-title">Deal title <span class="field-required">\(required\)<\/span><\/label> <span class="outside" id="deal-title-outside">From outside<\/span>/);
  assert.doesNotMatch(titleOf(outside.body), OUTSIDE_NAMES);
});

test("New deal for a contact: named safely, a required title, and no person fields", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const { body } = await load(env, "/contacts/ct_seed07/deals/new");
  assert.match(body, /<h1>New deal for Alex Sample<\/h1>/);
  const form = formOf(body, "/contacts/ct_seed07/deals/new");
  assertLabelled(form, "new deal");
  assert.match(form, /<label for="deal-title">Deal title <span class="field-required">\(required\)<\/span><\/label>/);
  assert.doesNotMatch(form, /name="email"/);
  assert.match((await load(env, "/contacts/ct_seed02/deals/new")).body, /<h1>New deal for contact ct_seed02<\/h1>/);
});

test("a form page for a record that doesn't exist, or an id of the wrong shape, is the 404 page", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  for (const path of ["/contacts/ct_nothing0000/edit", "/deals/dl_nothing0000/edit", "/contacts/ct_nothing0000/deals/new", "/contacts/bad/edit", "/deals/%3Cx%3E/edit"]) {
    assert.equal((await load(env, path)).res.status, 404, path);
  }
});

test("an archived contact gets no new deal: no Add a deal link, and the page and its post are 404", async () => {
  const db = await seededDb();
  db.exec("UPDATE contacts SET archived = 1 WHERE id = 'ct_seed07'");
  const env = devEnv(db);
  assert.doesNotMatch((await load(env, "/contacts/ct_seed07")).body, /deals\/new/);
  assert.equal((await load(env, "/contacts/ct_seed07/deals/new")).res.status, 404);
  assert.equal((await post(env, "/contacts/ct_seed07/deals/new", { title: "More" })).res.status, 404);
});

test("the deal page offers Edit deal, Add a task and Log, and each task card has Done and Snooze", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const { body } = await load(env, "/deals/dl_seed01");
  assert.match(body, /<a href="\/deals\/dl_seed01\/edit">Edit deal<\/a>/);
  const task = formOf(body, "/deals/dl_seed01/tasks");
  assertLabelled(task, "add task");
  for (const action of ["/deals/dl_seed01/tasks", "/deals/dl_seed01/log"]) {
    assert.match(formOf(body, action, "inline-form"), new RegExp(`action="${action}" novalidate>`), action);
  }
  assert.match(body, /<form class="snooze-until" method="post" action="\/tasks\/tk_seed01\/snooze" novalidate>/);
  assert.match(task, /<button class="button button-small" type="submit">Add task<\/button>/);
  const log = formOf(body, "/deals/dl_seed01/log", "inline-form");
  assertLabelled(log, "log");
  assert.match(log, /<select id="log-dl_seed01-type" name="type">\n<option value="note" selected>Note<\/option>\n<option value="call">Call<\/option>/);
  assert.match(formOf(body, "/tasks/tk_seed01/complete"), /<button class="button button-quiet button-small" type="submit">Done<span class="visually-hidden">: Prepare questions for Pat&#39;s call<\/span><\/button>/);
  const presets = formOf(body, "/tasks/tk_seed01/snooze");
  assert.match(presets, /<button class="button button-quiet button-small" type="submit" name="preset" value="tomorrow">Tomorrow morning<span class="visually-hidden">: Prepare questions/);
  assert.match(presets, /value="next_week">Next week/);
  assert.match(body, /<summary>Snooze<span class="visually-hidden">: Prepare questions for Pat&#39;s call<\/span><\/summary>/);
});

test("the contact page offers Edit details, Add a deal, Add a task and Log", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const { body } = await load(env, "/contacts/ct_seed01");
  assert.match(body, /<a href="\/contacts\/ct_seed01\/edit">Edit details<\/a>/);
  assert.match(body, /<a href="\/contacts\/ct_seed01\/deals\/new">Add a deal<\/a>/);
  assertLabelled(formOf(body, "/contacts/ct_seed01/tasks"), "contact add task");
  assertLabelled(formOf(body, "/contacts/ct_seed01/log", "inline-form"), "contact log");
  assert.ok(formOf(body, "/tasks/tk_seed01/complete"), "task cards have Done");
});

test("an outside task title never names a button: the task's id does", async () => {
  const db = await seededDb();
  db.exec(`UPDATE tasks SET title = 'Robin Sample says hi', untrusted_fields = '["title"]' WHERE id = 'tk_seed01'`);
  const { body } = await load(devEnv(db), "/deals/dl_seed01");
  assert.match(body, /Done<span class="visually-hidden">: task tk_seed01<\/span>/);
  assert.doesNotMatch(body, /visually-hidden">: Robin/);
});

test("Today, Pipeline and Contacts each have Add a deal and Add a lead buttons that say where Cancel goes back to", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  for (const [path, from] of [["/", "today"], ["/pipeline", "pipeline"], ["/contacts", "contacts"]] as const) {
    // Each has Import too (decisions 0036, 0037): tasks from Today, deals from Pipeline, people from Contacts (and from
    // Leads, new people come in as leads).
    const module = { today: "tasks", pipeline: "deals", contacts: "people" }[from];
    const importing = `<a class="button button-quiet" href="/import\\?module=${module}">Import</a>`;
    // Contacts has Add contact too (decision 0041).
    const contact = from === "contacts" ? `<a class="button button-quiet" href="/contacts/new\\?from=contacts">Add contact</a>` : "";
    assert.match(
      (await load(env, path)).body,
      new RegExp(`<p class="page-action"><a class="button" href="/deals/new\\?from=${from}">Add a deal</a>${contact}<a class="button button-quiet" href="/leads/new\\?from=${from}">Add a lead</a>${importing}</p>`),
      path,
    );
  }
  assert.match(
    (await load(env, "/leads")).body,
    /<p class="page-action"><a class="button" href="\/leads\/new\?from=leads">Add a lead<\/a><a class="button button-quiet" href="\/import\?module=people&amp;as=leads">Import<\/a><\/p>/,
  );
  const today = (await load(env, "/")).body;
  assert.ok(formOf(today, "/tasks/tk_seed01/complete"), "Today's task cards have Done");
});

test("Today shows a standalone task with no Deal or Contact line, and its Done goes back to Today", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const due = new Date(Date.now() - 2 * 86_400_000).toISOString();
  db.exec(`INSERT INTO tasks (id, title, due_at) VALUES ('tk_mine', 'Buy printer ink', '${due}')`);
  db.exec(`INSERT INTO tasks (id, title, due_at, untrusted_fields) VALUES ('tk_mine2', 'Robin Sample says hi', '${due}', '["title"]')`);
  const { res, body } = await load(env, "/");
  assert.equal(res.status, 200);
  assert.equal(h1Count(body), 1);
  assert.doesNotMatch(body, /undefined|null/);
  const card = (id: string) => {
    const end = body.indexOf(`action="/tasks/${id}/complete"`);
    return body.slice(body.lastIndexOf('<li class="card">', end), body.indexOf("</li>", end));
  };
  assert.match(card("tk_mine"), /<h3 class="card-title">Buy printer ink<\/h3>/);
  assert.doesNotMatch(card("tk_mine"), /<dt>(Deal|Contact)<\/dt>/);
  assert.match(card("tk_mine"), /Done<span class="visually-hidden">: Buy printer ink<\/span>/);
  assert.match(card("tk_mine2"), /Done<span class="visually-hidden">: task tk_mine2<\/span>/);
  assert.doesNotMatch(titleOf(body), /Robin|printer/);

  const done = await post(env, "/tasks/tk_mine/complete", { return_to: "/" });
  assert.equal(done.res.status, 303);
  assert.match(done.location, /^\/\?change=chg_/);
  assert.notEqual(await db.prepare("SELECT done_at FROM tasks WHERE id = 'tk_mine'").first("done_at"), null);
});

test("empty states say what can be done on the board now", async () => {
  const env = devEnv(await createTestDb());
  const today = (await load(env, "/")).body;
  assert.match(today, /<p class="empty-title">Nothing to do\.<\/p><p>Add a to-do above, or add a task on a deal or contact page\.<\/p>/);
  assert.match((await load(env, "/pipeline")).body, /Add one with Add a deal, or by talking to your AI app\. Inquiries from your website form/);
  assert.match((await load(env, "/contacts")).body, /Add one with Add a deal, Add contact or Add a lead, or by talking to your AI app\./);
  assert.match(today, /<footer class="app-footer">\n<p>Add leads, edit contacts and deals, and move, log and undo here, or change anything by talking to your AI app\.<\/p>/);
});
