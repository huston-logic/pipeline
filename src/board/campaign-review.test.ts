// The campaign review page and its actions (decision 0053): the owner's last look before an email goes to real people.
import assert from "node:assert/strict";
import { test } from "node:test";
import { auditCount, auditOf, changeIdOf, devEnv, formFields, h1Count, load, ORIGIN, post, seededDb } from "../../tests/helpers/board.ts";
import { addCampaignDraft, updateCampaignDraft } from "../campaigns/drafts.ts";
import type { CampaignRow } from "../db/db.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import type { Env } from "../env.ts";
import { addDays, DEFAULT_TZ, localDate, zonedToUtc } from "../time.ts";
import { canUndo } from "./banner.ts";

const READY = {
  CAMPAIGN_SENDING: "on",
  CAMPAIGN_FROM: "News <news@mail.example.com>",
  CAMPAIGN_RESEND_API_KEY: "re_fake_key_for_tests",
  OWNER_EMAILS: "owner@example.com",
};

const envOf = (db: SqliteD1, extra: Partial<Env> = {}): Env => ({ ...devEnv(db), ...READY, ...extra });

async function reviewDb(people = ["ct_amy", "ct_bob", "ct_cy", "ct_dee", "ct_eve", "ct_fay"]): Promise<{ db: SqliteD1; id: string }> {
  const db = await seededDb(new Date());
  db.exec(`UPDATE settings SET campaigns = 1, postal_address = '1 Example Road
Springfield', business_name = 'Example Bakery', owner_emails = '["owner@example.com"]';
    INSERT INTO contacts (id, name, email, person_status, sub_status, lead_status) VALUES
      ('ct_amy', 'Amy Example', 'amy@example.com', 'contact', NULL, 'qualified'),
      ('ct_bob', 'Bob Example', 'bob@example.com', 'lead', 'new', 'new'),
      ('ct_cy', 'Cy Example', NULL, 'contact', NULL, 'qualified'),
      ('ct_dee', 'Dee Example', 'dee@example.com', 'contact', NULL, 'qualified'),
      ('ct_eve', 'Eve Example', 'not-an-email', 'contact', NULL, 'qualified'),
      ('ct_fay', 'Fay Example', 'fay@example.com', 'contact', NULL, 'qualified');
    INSERT INTO email_suppressions (id, email, reason) VALUES ('su_dee', 'dee@example.com', 'unsubscribed')`);
  const added = await addCampaignDraft(
    { db, now: new Date(), actor: "ai", tool: "add_campaign_draft" },
    {
      name: "Autumn news",
      recipients: { kind: "people", people },
      subject: "News for {{first_name}}",
      body: "Hi {{first_name}},\n\nRead more at [our site](https://example.com/news) or https://example.org/x.\n\nSee you soon.",
      buttonLabel: "RSVP",
      buttonUrl: "https://example.com/rsvp",
      firstNameFallback: "friend",
    },
  );
  db.exec("UPDATE contacts SET archived = 1 WHERE id = 'ct_fay'");
  return { db, id: added.campaignId };
}

const campaignOf = (db: SqliteD1, id: string) => db.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first<CampaignRow>();
const recipientCount = async (db: SqliteD1, id: string) =>
  (await db.prepare("SELECT COUNT(*) AS n FROM campaign_recipients WHERE campaign_id = ?").bind(id).first<{ n: number }>())?.n ?? 0;

async function open(env: Env, id: string) {
  return load(env, `/campaigns/${id}`);
}

/** Approves through the page's own form; returns the page the 303 leads to. */
async function approved(env: Env, id: string) {
  const page = await open(env, id);
  const sent = await post(env, `/campaigns/${id}/approve`, formFields(page.body, `/campaigns/${id}/approve`), { cookie: page.cookie, token: page.token });
  assert.equal(sent.res.status, 303);
  return sent;
}

const nextMonth = () => addDays(localDate(new Date(), DEFAULT_TZ), 10);

function scheduleFields(page: { body: string }, id: string, date: string, time = "14:30"): URLSearchParams {
  const fields = formFields(page.body, `/campaigns/${id}/schedule`);
  fields.set("send_at.date", date);
  fields.set("send_at.time", time);
  return fields;
}

test("the review page shows every part, in order, with the preview for the first sendable person", async () => {
  const { db, id } = await reviewDb();
  db.exec(`UPDATE campaigns SET suggested_send_at = '2030-01-15T18:00:00.000Z' WHERE id = '${id}'`);
  const { res, body } = await open(envOf(db), id);
  assert.equal(res.status, 200);
  assert.equal(h1Count(body), 1);
  assert.match(body, /<title>Review: Autumn news · Example Bakery<\/title>/);
  assert.match(body, /<h1>Autumn news<\/h1>/);
  assert.match(body, /Draft/);
  assert.match(body, /2 people/);
  assert.match(body, /from people you picked/);
  assert.match(body, /1 of them is a lead you haven't contacted yet\. A first email from a list can land in spam and hurt your sending\./);
  assert.match(body, /Skipped: 4/);
  for (const [heading, who] of [
    ["No email address", "ct_cy"],
    ["Email address can&#39;t be used", "ct_eve"],
    ["Unsubscribed", "ct_dee"],
    ["Archived", "ct_fay"],
  ] as const) {
    assert.match(body, new RegExp(`${heading}[\\s\\S]*?<a href="/contacts/${who}">`), heading);
  }
  assert.doesNotMatch(body, /Bounced before|Marked an earlier email as spam/);
  assert.match(body, /News &lt;news@mail\.example\.com&gt;/);
  assert.match(body, /owner@example\.com/);
  assert.match(body, /News for Amy/);
  const region = /<section aria-labelledby="campaign-preview">[\s\S]*?<\/section>/.exec(body)?.[0] ?? "";
  assert.match(region, /<h2 id="campaign-preview">Preview, as Amy Example will see it<\/h2>/);
  assert.match(region, /Hi Amy,/);
  assert.match(region, /<a href="https:\/\/example\.com\/news" target="_blank" rel="noopener noreferrer">our site<span class="visually-hidden"> \(opens in a new tab\)<\/span><\/a>/);
  assert.match(region, /<a href="https:\/\/example\.org\/x" target="_blank" rel="noopener noreferrer">https:\/\/example\.org\/x<span class="visually-hidden"> \(opens in a new tab\)<\/span><\/a>/);
  assert.match(region, /<a class="button" href="https:\/\/example\.com\/rsvp" target="_blank" rel="noopener noreferrer">RSVP<span class="visually-hidden"> \(opens in a new tab\)<\/span><\/a>/);
  assert.match(body, /<details class="text-version">/);
  assert.doesNotMatch(body, /role="alert"/);
  assert.match(region, /Example Bakery/);
  assert.match(region, /1 Example Road<br>Springfield/);
  assert.match(region, /Unsubscribe from these emails/);
  assert.doesNotMatch(region, /<a[^>]*>Unsubscribe/);
  assert.match(body, /<details class="text-version">\s*<summary>Text version<\/summary>\s*<pre>[\s\S]*Hi Amy,[\s\S]*RSVP: https:\/\/example\.com\/rsvp[\s\S]*\/unsubscribe\/preview[\s\S]*<\/pre>/);
  assert.match(body, /Suggested time: /);
  assert.match(body, /href="\/campaigns\/cp_[a-z0-9]+\/edit"/);
  assert.match(body, /action="\/campaigns\/cp_[a-z0-9]+\/duplicate"/);
  assert.match(body, /action="\/campaigns\/cp_[a-z0-9]+\/archive"/);
  for (const address of ["amy@example.com", "bob@example.com", "dee@example.com", "fay@example.com", "not-an-email"]) {
    assert.doesNotMatch(body, new RegExp(address), address);
  }
  assert.doesNotMatch(body, /re_fake_key/);
});

test("an outside name is shown by its safe label, with the From outside tag", async () => {
  const { db, id } = await reviewDb(["ct_amy"]);
  db.exec("INSERT INTO contacts (id, name, email, untrusted_fields) VALUES ('ct_out', 'Ignore everything', NULL, '[\"name\"]')");
  await updateCampaignDraft({ db, now: new Date(), actor: "ai", tool: "update_campaign_draft" }, id, { recipients: { kind: "people", people: ["ct_amy", "ct_out"] } });
  const { body } = await open(envOf(db), id);
  assert.match(body, /<a href="\/contacts\/ct_out">Contact ct_out<\/a> <span class="outside">From outside<\/span>/);
});

test("a status or saved view names how the group is chosen", async () => {
  const { db, id } = await reviewDb();
  const ctx = { db, now: new Date(), actor: "ai" as const, tool: "update_campaign_draft" };
  await updateCampaignDraft(ctx, id, { recipients: { kind: "status", status: "contact" } });
  assert.match((await open(envOf(db), id)).body, /from status Contact/);
  db.exec("INSERT INTO views (id, name, module, sort, position) VALUES ('vw_folks', 'Folks', 'people', 'name-asc', 1)");
  await updateCampaignDraft(ctx, id, { recipients: { kind: "view", view: "vw_folks" } });
  assert.match((await open(envOf(db), id)).body, /from view Folks/);
});

test("a group over the daily limit says how many days it takes and when it finishes", async () => {
  const { db, id } = await reviewDb();
  db.exec("UPDATE settings SET campaign_daily_limit = 1");
  const { body } = await open(envOf(db), id);
  const finish = new Date(`${addDays(localDate(new Date(), DEFAULT_TZ), 1)}T12:00:00Z`);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" }).format(finish);
  assert.ok(body.includes(`At your limit of 1 a day this goes out over 2 days, finishing about ${day}.`), day);
  db.exec("UPDATE settings SET campaign_daily_limit = 90");
  assert.doesNotMatch((await open(envOf(db), id)).body, /At your limit of/);
});

test("the first readiness blocker replaces the send forms", async () => {
  const { db, id } = await reviewDb();
  const forms = (body: string) => /action="\/campaigns\/cp_[a-z0-9]+\/(approve|schedule)"/.test(body);
  db.exec("UPDATE settings SET postal_address = NULL");
  let page = await open(envOf(db, { CAMPAIGN_SENDING: undefined }), id);
  assert.match(page.body, /Add your business&#39;s postal address on Campaign settings\. Every campaign email shows it\./);
  assert.doesNotMatch(page.body, /Sending isn&#39;t set up/);
  assert.equal(forms(page.body), false);

  db.exec("UPDATE settings SET postal_address = '1 Example Road'");
  page = await open(envOf(db, { CAMPAIGN_SENDING: undefined }), id);
  assert.match(page.body, /Sending isn&#39;t set up for this copy yet: it needs its sending switch\. Whoever installed this app sets it\./);
  assert.equal(forms(page.body), false);

  page = await open(envOf(db), id);
  assert.equal(forms(page.body), true);
  assert.match(page.body, />Approve and send to 2 people</);
  assert.match(page.body, /Goes out within 15 minutes after this time\./);
  assert.match(page.body, /name="send_at\.date"/);
  assert.match(page.body, /name="send_at\.time"/);
  assert.match(page.body, /<input type="hidden" name="fingerprint" value="[0-9a-f]{64}">/);
});

test("nobody sendable shows that sentence in place of the send forms", async () => {
  const { db, id } = await reviewDb(["ct_cy"]);
  const { body } = await open(envOf(db), id);
  assert.match(body, /No one in this group can get the email\./);
  assert.doesNotMatch(body, /action="\/campaigns\/cp_[a-z0-9]+\/approve"/);
  assert.match(body, /Preview<\/h2>/);
});

test("Approve and send freezes the list as the owner, and its banner has no Undo", async () => {
  const { db, id } = await reviewDb();
  const env = envOf(db);
  const sent = await approved(env, id);
  assert.match(sent.location, new RegExp(`^/campaigns/${id}\\?change=chg_[a-z0-9]{12}$`));
  const row = await campaignOf(db, id);
  assert.equal(row?.status, "sending");
  assert.equal(row?.base_url, ORIGIN);
  assert.equal(await recipientCount(db, id), 6);
  const audit = await auditOf(db, changeIdOf(sent.location));
  assert.deepEqual([audit?.actor, audit?.tool], ["owner", "campaign_approve"]);
  const after = await load(env, sent.location, sent.cookie);
  assert.match(after.body, /class="corner-text"/);
  assert.doesNotMatch(after.body, /Undo/);
  assert.match(after.body, /Duplicate/);
});

test("a list or email that changed after the page was drawn makes Approve a 422 that writes nothing", async () => {
  const { db, id } = await reviewDb();
  const env = envOf(db);
  const page = await open(env, id);
  const fields = formFields(page.body, `/campaigns/${id}/approve`);
  await updateCampaignDraft({ db, now: new Date(), actor: "ai", tool: "update_campaign_draft" }, id, { subject: "A different subject" });
  const before = await auditCount(db);
  const refused = await post(env, `/campaigns/${id}/approve`, fields, { cookie: page.cookie, token: page.token });
  assert.equal(refused.res.status, 422);
  assert.match(refused.body, /The list or the email changed since you opened this page\. Check it again\./);
  assert.match(refused.body, /A different subject/);
  assert.equal(await auditCount(db), before);
  assert.equal((await campaignOf(db, id))?.status, "draft");
  assert.equal(await recipientCount(db, id), 0);
});

test("Approve refuses with the readiness sentence when sending was switched off after the page was drawn", async () => {
  const { db, id } = await reviewDb();
  const page = await open(envOf(db), id);
  const refused = await post(envOf(db, { CAMPAIGN_SENDING: undefined }), `/campaigns/${id}/approve`, formFields(page.body, `/campaigns/${id}/approve`), {
    cookie: page.cookie,
    token: page.token,
  });
  assert.equal(refused.res.status, 422);
  assert.match(refused.body, /Sending isn&#39;t set up for this copy yet/);
  assert.equal((await campaignOf(db, id))?.status, "draft");
});

test("Schedule reads the date and time in the owner's timezone and stores UTC", async () => {
  const { db, id } = await reviewDb();
  const env = envOf(db);
  const page = await open(env, id);
  const date = nextMonth();
  const sent = await post(env, `/campaigns/${id}/schedule`, scheduleFields(page, id, date), { cookie: page.cookie, token: page.token });
  assert.equal(sent.res.status, 303);
  assert.match(sent.location, new RegExp(`^/campaigns/${id}\\?change=chg_`));
  const row = await campaignOf(db, id);
  assert.equal(row?.status, "scheduled");
  assert.equal(row?.send_after, zonedToUtc(`${date}T14:30`, DEFAULT_TZ).toISOString());
  assert.equal((await auditOf(db, changeIdOf(sent.location)))?.tool, "campaign_schedule");
  const after = await load(env, sent.location, sent.cookie);
  assert.doesNotMatch(after.body, /Undo/);
  assert.match(after.body, /Scheduled for /);
  assert.match(after.body, /action="\/campaigns\/cp_[a-z0-9]+\/cancel"/);
  assert.match(after.body, /action="\/campaigns\/cp_[a-z0-9]+\/duplicate"/);
  assert.doesNotMatch(after.body, />Approve and send/);
});

test("a scheduled campaign's page shows the list as it was fixed, not the people on file now", async () => {
  const { db, id } = await reviewDb();
  const env = envOf(db);
  const page = await open(env, id);
  const sent = await post(env, `/campaigns/${id}/schedule`, scheduleFields(page, id, nextMonth()), { cookie: page.cookie, token: page.token });
  assert.equal(sent.res.status, 303);
  db.exec("INSERT INTO email_suppressions (id, email, reason) VALUES ('su_amy', 'amy@example.com', 'unsubscribed'); UPDATE contacts SET archived = 1 WHERE id = 'ct_bob'");
  const { res, body } = await load(env, sent.location, sent.cookie);
  assert.equal(res.status, 200);
  assert.match(body, /<dt>To<\/dt>\s*<dd>2 people, from people you picked<\/dd>/);
  assert.match(body, /The list was fixed when you scheduled it\./);
  assert.match(body, /Skipped: 4/);
  for (const [heading, who] of [
    ["No email address", "ct_cy"],
    ["Email address can&#39;t be used", "ct_eve"],
    ["Unsubscribed", "ct_dee"],
    ["Archived", "ct_fay"],
  ] as const) {
    assert.match(body, new RegExp(`${heading}[\\s\\S]*?<a href="/contacts/${who}">`), heading);
  }
  assert.match(body, /Preview, as Amy Example will see it/);
  assert.doesNotMatch(body, /1 of them is a lead/);
});

test("a draft's page still shows the live list", async () => {
  const { db, id } = await reviewDb();
  db.exec("INSERT INTO email_suppressions (id, email, reason) VALUES ('su_amy', 'amy@example.com', 'unsubscribed')");
  const { body } = await open(envOf(db), id);
  assert.match(body, /<dd>1 person, from people you picked<\/dd>/);
  assert.doesNotMatch(body, /The list was fixed/);
});

test("a scheduled campaign still opens after its view is archived", async () => {
  const { db, id: first } = await reviewDb();
  db.exec("INSERT INTO views (id, name, module, sort, position) VALUES ('vw_folks', 'Folks', 'people', 'name-asc', 1)");
  const added = await addCampaignDraft(
    { db, now: new Date(), actor: "ai", tool: "add_campaign_draft" },
    { name: "View news", recipients: { kind: "view", view: "vw_folks" }, subject: "News", body: "Hello." },
  );
  assert.ok(first);
  const env = envOf(db);
  const page = await open(env, added.campaignId);
  const sent = await post(env, `/campaigns/${added.campaignId}/schedule`, scheduleFields(page, added.campaignId, nextMonth()), { cookie: page.cookie, token: page.token });
  assert.equal(sent.res.status, 303);
  db.exec("UPDATE views SET archived = 1 WHERE id = 'vw_folks'");
  const after = await load(env, sent.location, sent.cookie);
  assert.equal(after.res.status, 200);
  assert.match(after.body, /from view Folks/);
  assert.doesNotMatch(after.body, /gone or archived/);
});

test("a Schedule refused because sending isn't set up announces one alert, not two", async () => {
  const { db, id } = await reviewDb();
  const page = await open(envOf(db), id);
  const refused = await post(envOf(db, { CAMPAIGN_SENDING: undefined }), `/campaigns/${id}/schedule`, scheduleFields(page, id, nextMonth()), {
    cookie: page.cookie,
    token: page.token,
  });
  assert.equal(refused.res.status, 422);
  assert.equal(refused.body.match(/role="alert"/g)?.length, 1);
});

test("Schedule refuses a past time, one over 90 days away, and a missing date, writing nothing", async () => {
  const { db, id } = await reviewDb();
  const env = envOf(db);
  const page = await open(env, id);
  const before = await auditCount(db);
  const past = await post(env, `/campaigns/${id}/schedule`, scheduleFields(page, id, addDays(localDate(new Date(), DEFAULT_TZ), -1)), { cookie: page.cookie, token: page.token });
  assert.equal(past.res.status, 422);
  assert.match(past.body, /Pick a time in the next 90 days\./);
  // The form is drawn again with what was typed, the error tied to the fields, and a summary beside the form.
  const yesterday = addDays(localDate(new Date(), DEFAULT_TZ), -1);
  assert.match(past.body, new RegExp(`name="send_at\\.date" type="date" value="${yesterday}" required aria-describedby="schedule-at-hint schedule-at-error" aria-invalid="true"`));
  assert.match(past.body, /name="send_at\.time" type="time" value="14:30" required aria-describedby="schedule-at-hint schedule-at-error" aria-invalid="true"/);
  assert.match(past.body, /<div class="error-summary" role="alert"[\s\S]*Pick a time in the next 90 days\./);
  assert.match(past.body, /Date <span class="field-required">\(required\)<\/span><\/label>/);
  assert.match(past.body, /Time <span class="field-required">\(required\)<\/span><\/label>/);
  const far = await post(env, `/campaigns/${id}/schedule`, scheduleFields(page, id, addDays(localDate(new Date(), DEFAULT_TZ), 91)), { cookie: page.cookie, token: page.token });
  assert.equal(far.res.status, 422);
  assert.match(far.body, /Pick a time in the next 90 days\./);
  const none = scheduleFields(page, id, "");
  const missing = await post(env, `/campaigns/${id}/schedule`, none, { cookie: page.cookie, token: page.token });
  assert.equal(missing.res.status, 422);
  assert.match(missing.body, /Pick a date to send on\./);
  assert.equal(await auditCount(db), before);
  assert.equal((await campaignOf(db, id))?.status, "draft");
});

test("the schedule form is prefilled from the suggested time", async () => {
  const { db, id } = await reviewDb();
  const suggested = zonedToUtc(`${nextMonth()}T09:15`, DEFAULT_TZ);
  db.exec(`UPDATE campaigns SET suggested_send_at = '${suggested.toISOString()}' WHERE id = '${id}'`);
  const { body } = await open(envOf(db), id);
  assert.match(body, new RegExp(`name="send_at\\.date" type="date" value="${nextMonth()}"`));
  assert.match(body, /name="send_at\.time" type="time" value="09:15"/);
});

test("Cancel asks first, then cancels a scheduled campaign", async () => {
  const { db, id } = await reviewDb();
  const env = envOf(db);
  const page = await open(env, id);
  await post(env, `/campaigns/${id}/schedule`, scheduleFields(page, id, nextMonth()), { cookie: page.cookie, token: page.token });
  const scheduled = await open(env, id);
  const fields = formFields(scheduled.body, `/campaigns/${id}/cancel`);
  const before = await auditCount(db);
  const ask = await post(env, `/campaigns/${id}/cancel`, fields, { cookie: scheduled.cookie, token: scheduled.token });
  assert.equal(ask.res.status, 200);
  assert.match(ask.body, /Cancel Autumn news\? People who haven&#39;t been sent it yet won&#39;t get it\. Emails already on their way may still arrive\./);
  assert.equal(await auditCount(db), before);
  const confirm = formFields(ask.body, `/campaigns/${id}/cancel`);
  assert.equal(confirm.get("confirm"), "yes");
  const done = await post(env, `/campaigns/${id}/cancel`, confirm, { cookie: scheduled.cookie, token: scheduled.token });
  assert.equal(done.res.status, 303);
  assert.match(done.location, new RegExp(`^/campaigns/${id}\\?change=chg_`));
  assert.equal((await campaignOf(db, id))?.status, "cancelled");
  const audit = await auditOf(db, changeIdOf(done.location));
  assert.deepEqual([audit?.actor, audit?.tool], ["owner", "campaign_cancel"]);
});

test("Pause asks first, Resume does not, and neither can be undone", async () => {
  const { db, id } = await reviewDb();
  const env = envOf(db);
  const sent = await approved(env, id);
  const running = await load(env, `/campaigns/${id}`, sent.cookie);
  const ask = await post(env, `/campaigns/${id}/pause`, new URLSearchParams(),{ cookie: running.cookie, token: running.token });
  assert.equal(ask.res.status, 200);
  assert.match(ask.body, /Pause Autumn news\? No new emails go out until you resume\. Emails already on their way may still arrive\./);
  assert.equal((await campaignOf(db, id))?.status, "sending");
  const paused = await post(env, `/campaigns/${id}/pause`, formFields(ask.body, `/campaigns/${id}/pause`), { cookie: running.cookie, token: running.token });
  assert.equal(paused.res.status, 303);
  assert.equal((await campaignOf(db, id))?.status, "paused");
  assert.equal((await auditOf(db, changeIdOf(paused.location)))?.tool, "campaign_pause");
  const stopped = await load(env, paused.location, sent.cookie);
  assert.doesNotMatch(stopped.body, /Undo/);
  const resumed = await post(env, `/campaigns/${id}/resume`, new URLSearchParams(),{ cookie: stopped.cookie, token: stopped.token });
  assert.equal(resumed.res.status, 303);
  assert.equal((await campaignOf(db, id))?.status, "sending");
  assert.equal((await auditOf(db, changeIdOf(resumed.location)))?.tool, "campaign_resume");
});

test("an approved campaign shows its results page, with Pause and Duplicate", async () => {
  const { db, id } = await reviewDb();
  const env = envOf(db);
  await approved(env, id);
  const { res, body } = await open(env, id);
  assert.equal(res.status, 200);
  assert.match(body, /<title>Autumn news: results/);
  assert.match(body, /Sending/);
  assert.match(body, /action="\/campaigns\/cp_[a-z0-9]+\/pause"/);
  assert.match(body, /action="\/campaigns\/cp_[a-z0-9]+\/duplicate"/);
  assert.doesNotMatch(body, />Approve and send/);
});

test("Duplicate makes a new draft and Archive hides a draft", async () => {
  const { db, id } = await reviewDb();
  const env = envOf(db);
  const page = await open(env, id);
  const copy = await post(env, `/campaigns/${id}/duplicate`, formFields(page.body, `/campaigns/${id}/duplicate`), { cookie: page.cookie, token: page.token });
  assert.equal(copy.res.status, 303);
  const newId = /^\/campaigns\/(cp_[a-z0-9]+)\?change=chg_/.exec(copy.location)?.[1] ?? "";
  assert.notEqual(newId, "");
  assert.notEqual(newId, id);
  assert.deepEqual([(await campaignOf(db, newId))?.name, (await campaignOf(db, newId))?.status], ["Autumn news (copy)", "draft"]);
  const audit = await auditOf(db, changeIdOf(copy.location));
  assert.deepEqual([audit?.actor, audit?.tool], ["owner", "duplicate_campaign"]);

  const archived = await post(env, `/campaigns/${newId}/archive`, formFields(page.body, `/campaigns/${id}/archive`), { cookie: page.cookie, token: page.token });
  assert.equal(archived.res.status, 303);
  assert.match(archived.location, /^\/campaigns\?change=chg_/);
  assert.equal((await auditOf(db, changeIdOf(archived.location)))?.tool, "archive_campaign");
  assert.equal((await open(env, newId)).res.status, 404);
});

test("approving or scheduling an archived campaign is refused and writes nothing", async () => {
  const { db, id } = await reviewDb();
  const env = envOf(db);
  const page = await open(env, id);
  const fields = formFields(page.body, `/campaigns/${id}/approve`);
  db.exec("UPDATE campaigns SET archived = 1");
  const before = await auditCount(db);
  const approve = await post(env, `/campaigns/${id}/approve`, fields, { cookie: page.cookie, token: page.token });
  assert.equal(approve.res.status, 422);
  assert.match(approve.body, /is archived/);
  const schedule = await post(env, `/campaigns/${id}/schedule`, scheduleFields(page, id, nextMonth()), { cookie: page.cookie, token: page.token });
  assert.equal(schedule.res.status, 422);
  assert.equal(await auditCount(db), before);
  assert.equal((await campaignOf(db, id))?.status, "draft");
  assert.equal(await recipientCount(db, id), 0);
});

test("the confirm page keeps Campaigns in the nav", async () => {
  const { db, id } = await reviewDb();
  const env = envOf(db);
  const page = await open(env, id);
  await post(env, `/campaigns/${id}/schedule`, scheduleFields(page, id, nextMonth()), { cookie: page.cookie, token: page.token });
  const ask = await post(env, `/campaigns/${id}/cancel`, new URLSearchParams(), { cookie: page.cookie, token: page.token });
  assert.match(ask.body, /<a [^>]*href="\/campaigns"/);
});

test("an unknown id, an archived campaign and campaigns being off are all a 404, for GET and POST", async () => {
  const { db, id } = await reviewDb();
  const env = envOf(db);
  const page = await open(env, id);
  assert.equal((await open(env, "cp_nothere")).res.status, 404);
  db.exec("UPDATE settings SET campaigns = 0");
  const before = await auditCount(db);
  assert.equal((await open(env, id)).res.status, 404);
  for (const action of ["approve", "schedule", "cancel", "pause", "resume", "duplicate", "archive"]) {
    assert.equal((await post(env, `/campaigns/${id}/${action}`, { confirm: "yes" }, { cookie: page.cookie, token: page.token })).res.status, 404, action);
  }
  assert.equal(await auditCount(db), before);
  db.exec("UPDATE settings SET campaigns = 1; UPDATE campaigns SET archived = 1");
  assert.equal((await open(env, id)).res.status, 404);
});

test("Undo is not offered for a campaign's sending steps, only for the draft tools", () => {
  const change = { undone: false, undoOf: null };
  for (const tool of ["campaign_approve", "campaign_schedule", "campaign_cancel", "campaign_pause", "campaign_resume", "campaign_send", "unsubscribe"]) {
    assert.equal(canUndo({ ...change, tool }), false, tool);
  }
  for (const tool of ["duplicate_campaign", "archive_campaign", "update_deal"]) assert.equal(canUndo({ ...change, tool }), true, tool);
  assert.equal(canUndo({ undone: true, undoOf: null, tool: "update_deal" }), false);
});
