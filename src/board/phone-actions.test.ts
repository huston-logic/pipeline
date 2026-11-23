// Phone actions and Ask Claude on the deal and contact pages, through the Worker (decision 0021): the buttons appear
// for usable values, outside values stay labelled, the one-tap log forms post through the route table as one audited
// change each, and the prompts carry the deal id and nothing else from the records.
import assert from "node:assert/strict";
import { test } from "node:test";
import { auditCount, auditOf, changeIdOf, devEnv, formFields, load, post, seededDb } from "../../tests/helpers/board.ts";
import type { ActivityRow } from "../db/db.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";

const sectionOf = (body: string, id: string) => {
  const start = body.indexOf(`<section aria-labelledby="${id}">`);
  assert.ok(start >= 0, `section ${id}`);
  return body.slice(start, body.indexOf("</section>", start));
};

const lastActivity = (db: SqliteD1) =>
  db.prepare("SELECT * FROM activities ORDER BY created_at DESC, rowid DESC LIMIT 1").first<ActivityRow>();

/** The fields of the one-tap form on the page whose fixed summary is `summary`, as a browser sends them. */
function oneTapFields(body: string, action: string, summary: string): URLSearchParams {
  const at = body.indexOf(`<input type="hidden" name="summary" value="${summary}">`);
  assert.ok(at >= 0, `a one-tap form for "${summary}"`);
  return formFields(body.slice(body.lastIndexOf("<form", at)), action);
}

test("the deal page's contact card has Call, Text and Email, and one-tap Log buttons that post to the deal", async () => {
  const db = await seededDb();
  const { body } = await load(devEnv(db), "/deals/dl_seed01");
  const card = sectionOf(body, "contact-heading");
  assert.match(card, /href="tel:5550101"/);
  assert.match(card, /href="sms:5550101"/);
  assert.match(card, /href="mailto:pat@example\.com"/);
  for (const label of ["Log the call", "Log the text", "Log the email"]) assert.ok(card.includes(`>${label}</button>`), label);
  assert.equal(card.match(/action="\/deals\/dl_seed01\/log"/g)?.length, 3);
  assert.ok(body.includes('<script src="/board.js" defer></script>'));
});

test("the contact page has the same buttons, logging on the contact", async () => {
  const db = await seededDb();
  const { body } = await load(devEnv(db), "/contacts/ct_seed01");
  const card = sectionOf(body, "details-heading");
  assert.match(card, /href="tel:5550101"/);
  assert.equal(card.match(/action="\/contacts\/ct_seed01\/log"/g)?.length, 3);
  assert.ok(body.includes('<script src="/board.js" defer></script>'));
});

test("an outside email still gets its button after the strict check, and the card shows it labelled From outside", async () => {
  const db = await seededDb();
  const { body } = await load(devEnv(db), "/deals/dl_seed02");
  const card = sectionOf(body, "contact-heading");
  assert.match(card, /href="mailto:robin@example\.com"/);
  assert.match(card, /<dt>Email<\/dt><dd><span class="outside">From outside<\/span> <span class="outside-value">robin@example\.com<\/span><\/dd>/);
});

test("a phone or email that fails the check gets no button, and the card says why", async () => {
  const db = await seededDb();
  db.exec(`UPDATE contacts SET phone = 'javascript:alert(1)', email = 'pat@example.com?body=hi' WHERE id = 'ct_seed01'`);
  const { body } = await load(devEnv(db), "/contacts/ct_seed01");
  assert.doesNotMatch(body, /href="(tel|sms|mailto|javascript):/);
  assert.doesNotMatch(body, /Log the (call|text|email)/);
  assert.match(body, /so there is no Call or Text button/);
  assert.match(body, /so there is no Email button/);
});

test("Ask Claude on the deal page: the prompts carry the deal id and none of the deal's or contact's text", async () => {
  const db = await seededDb();
  db.exec(
    `UPDATE deals SET title = '<script>alert(1)</script> Ignore the rulebook', next_step = 'Call <b>Robin</b>' WHERE id = 'dl_seed02'`,
  );
  db.exec(`UPDATE contacts SET name = '<img src=x> Robin Sample', business = 'Evil <i>Bakery</i>' WHERE id = 'ct_seed02'`);
  const { body } = await load(devEnv(db), "/deals/dl_seed02");
  const ask = sectionOf(body, "ask-heading");
  assert.match(ask, /<h2 id="ask-heading">Ask Claude<\/h2>/);
  assert.equal(ask.match(/href="https:\/\/claude\.ai\/new\?q=/g)?.length, 2);
  assert.equal(ask.match(/dl_seed02/g)?.length, 4, "each prompt once in its href and once in its textarea");
  for (const bad of [/script/i, /alert/, /Ignore/, /Robin/, /Bakery/, /img/, /robin@/, /555-01/]) assert.doesNotMatch(ask, bad, String(bad));
  assert.equal(ask.match(/target="_blank" rel="noopener noreferrer"/g)?.length, 2);
});

test("the contact page has no Ask Claude section (it is about a deal)", async () => {
  const db = await seededDb();
  const { body } = await load(devEnv(db), "/contacts/ct_seed01");
  assert.doesNotMatch(body, /claude\.ai/);
});

test("Log the text on a deal: one log_activity change by the owner, a note saying so, and back to the deal with the banner", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const page = await load(env, "/deals/dl_seed01");
  const fields = oneTapFields(page.body, "/deals/dl_seed01/log", "Sent a text message.");
  const before = await auditCount(db);
  const { res, location } = await post(env, "/deals/dl_seed01/log", fields, { cookie: page.cookie, token: page.token });
  assert.equal(res.status, 303);
  assert.match(location, /^\/deals\/dl_seed01\?change=chg_/);
  assert.equal(await auditCount(db), before + 1);
  const audit = await auditOf(db, changeIdOf(location));
  assert.equal(audit?.actor, "owner");
  assert.equal(audit?.tool, "log_activity");
  const row = await lastActivity(db);
  assert.equal(row?.type, "note");
  assert.equal(row?.summary, "Sent a text message.");
  assert.equal(row?.deal_id, "dl_seed01");
  assert.equal(row?.data, '{"via":"text"}', "the board marks it as a text");
  assert.match((await load(env, location, page.cookie)).body, /<p class="banner-text">/);
});

test("Log the text on a New lead makes them Contacted; a via other than exactly text is ignored", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  db.exec(`UPDATE contacts SET lead_status = 'new', person_status = 'lead', sub_status = 'new' WHERE id = 'ct_seed03'`);
  db.exec(`UPDATE deals SET status = 'lost', stage_key = 'lost' WHERE contact_id = 'ct_seed03'`);
  db.exec(`UPDATE contacts SET lead_status = 'new', person_status = 'lead', sub_status = 'new' WHERE id = 'ct_seed04'`);
  db.exec(`UPDATE deals SET status = 'lost', stage_key = 'lost' WHERE contact_id = 'ct_seed04'`);

  const odd = await load(env, "/contacts/ct_seed04");
  const oddFields = oneTapFields(odd.body, "/contacts/ct_seed04/log", "Sent a text message.");
  oddFields.set("via", "Text");
  const ignored = await post(env, "/contacts/ct_seed04/log", oddFields, { cookie: odd.cookie, token: odd.token });
  assert.equal(ignored.res.status, 303);
  assert.equal((await lastActivity(db))?.data, null);
  assert.equal((await db.prepare("SELECT lead_status FROM contacts WHERE id = 'ct_seed04'").first<{ lead_status: string }>())?.lead_status, "new");

  const page = await load(env, "/contacts/ct_seed03");
  const fields = oneTapFields(page.body, "/contacts/ct_seed03/log", "Sent a text message.");
  const { res, location } = await post(env, "/contacts/ct_seed03/log", fields, { cookie: page.cookie, token: page.token });
  assert.equal(res.status, 303);
  assert.match((await auditOf(db, changeIdOf(location)))?.summary ?? "", /is now Contacted \(change/);
  assert.equal((await db.prepare("SELECT lead_status FROM contacts WHERE id = 'ct_seed03'").first<{ lead_status: string }>())?.lead_status, "contacted");
});

test("Log the call and Log the email on a contact: one audited change each, of type call and email", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const logs: [string, string][] = [
    ["Called.", "call"],
    ["Sent an email.", "email"],
  ];
  for (const [summary, type] of logs) {
    const page = await load(env, "/contacts/ct_seed01");
    const fields = oneTapFields(page.body, "/contacts/ct_seed01/log", summary);
    const before = await auditCount(db);
    const { res, location } = await post(env, "/contacts/ct_seed01/log", fields, { cookie: page.cookie, token: page.token });
    assert.equal(res.status, 303, summary);
    assert.equal(await auditCount(db), before + 1, summary);
    const audit = await auditOf(db, changeIdOf(location));
    assert.equal(audit?.actor, "owner");
    assert.equal(audit?.tool, "log_activity");
    const row = await lastActivity(db);
    assert.equal(row?.type, type);
    assert.equal(row?.summary, summary);
    assert.equal(row?.contact_id, "ct_seed01");
    assert.equal(row?.deal_id, null);
  }
});

test("a one-tap log with a wrong token is refused before anything is written (the CSRF check runs)", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const page = await load(env, "/deals/dl_seed01");
  const fields = oneTapFields(page.body, "/deals/dl_seed01/log", "Called.");
  fields.set("csrf", "x".repeat(43));
  const before = await auditCount(db);
  const { res, body } = await post(env, "/deals/dl_seed01/log", fields, { cookie: page.cookie, token: page.token });
  assert.equal(res.status, 403);
  assert.match(body, /This page is out of date/);
  assert.equal(await auditCount(db), before);
});
