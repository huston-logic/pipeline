// "Send test to me" on the campaign review page: one email to the signed-in owner, never to the list.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { auditCount, devEnv, formFields, load, post, seededDb } from "../../tests/helpers/board.ts";
import { addCampaignDraft } from "../campaigns/drafts.ts";
import { runCampaigns } from "../campaigns/send.ts";
import type { CampaignBatchRow } from "../db/db.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import type { Env } from "../env.ts";

const READY = {
  CAMPAIGN_SENDING: "on",
  CAMPAIGN_FROM: "News <news@mail.example.com>",
  CAMPAIGN_RESEND_API_KEY: "re_fake_key_for_tests",
  OWNER_EMAILS: "owner@example.com",
};

const envOf = (db: SqliteD1, extra: Partial<Env> = {}): Env => ({ ...devEnv(db), ...READY, ...extra });

async function world(t: TestContext, answer: () => Response = () => new Response(JSON.stringify({ id: "re_1" }), { status: 200 })) {
  const db = await seededDb(new Date());
  db.exec(`UPDATE settings SET campaigns = 1, postal_address = '1 Example Road', business_name = 'Example Bakery', owner_emails = '["owner@example.com"]';
    INSERT INTO contacts (id, name, email, person_status, sub_status, lead_status) VALUES
      ('ct_amy', 'Amy Example', 'amy@example.com', 'contact', NULL, 'qualified')`);
  const added = await addCampaignDraft(
    { db, now: new Date(), actor: "ai", tool: "add_campaign_draft" },
    { name: "Autumn news", recipients: { kind: "people", people: ["ct_amy"] }, subject: "News for {{first_name}}", body: "Hi {{first_name}},\n\nNews inside." },
  );
  const requests: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => {
    requests.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return Promise.resolve(answer());
  });
  return { db, id: added.campaignId, requests };
}

const path = (id: string) => `/campaigns/${id}/test`;
const batches = async (db: SqliteD1) => (await db.prepare("SELECT * FROM campaign_batches ORDER BY created_at, id").all<CampaignBatchRow>()).results;

async function sendTest(env: Env, id: string) {
  const page = await load(env, `/campaigns/${id}`);
  return post(env, path(id), formFields(page.body, path(id)), { cookie: page.cookie, token: page.token });
}

test("the review page offers the form, with its hint, only when no blocker shows", async (t) => {
  const { db, id } = await world(t);
  const page = await load(envOf(db), `/campaigns/${id}`);
  assert.match(page.body, /action="\/campaigns\/cp_[a-z0-9]+\/test"/);
  assert.match(page.body, />Send test to me</);
  assert.match(page.body, /Sends one email to you, with “Test: ” before the subject\./);
  const blocked = await load(envOf(db, { CAMPAIGN_SENDING: undefined }), `/campaigns/${id}`);
  assert.doesNotMatch(blocked.body, /action="\/campaigns\/cp_[a-z0-9]+\/test"/);
});

test("a test goes only to the signed-in owner, with Test: before the subject and the test unsubscribe link", async (t) => {
  const { db, id, requests } = await world(t);
  const sent = await sendTest(envOf(db), id);
  assert.equal(sent.res.status, 303);
  assert.equal(sent.location, `/campaigns/${id}?test=sent`);
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request?.url, "https://api.resend.com/emails");
  assert.deepEqual(request?.body.to, ["owner@example.test"]);
  assert.equal(request?.body.subject, "Test: News for there");
  assert.equal(request?.body.reply_to, "owner@example.com");
  assert.equal(request?.body.from, "News <news@mail.example.com>");
  assert.match(String(request?.body.text), /\/unsubscribe\/test/);
  assert.match(String(request?.body.html), /\/unsubscribe\/test/);
  assert.match((request?.body.headers as Record<string, string>)["List-Unsubscribe"] ?? "", /\/unsubscribe\/test>$/);
  assert.deepEqual(request?.body.tags, [{ name: "campaign", value: id }]);
  assert.doesNotMatch(JSON.stringify(request?.body), /amy@example\.com/);
  const rows = await batches(db);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]?.kind, rows[0]?.status, rows[0]?.last_status], ["test", "done", "200"]);
  assert.equal(request?.headers["Idempotency-Key"], rows[0]?.id);
  const after = await load(envOf(db), sent.location, sent.cookie);
  assert.match(after.body, /A test is on its way to you\./);
});

test("a test writes no audit change and does not touch the campaign's version", async (t) => {
  const { db, id } = await world(t);
  const before = await auditCount(db);
  const version = (await db.prepare("SELECT version FROM campaigns WHERE id = ?").bind(id).first<{ version: number }>())?.version;
  await sendTest(envOf(db), id);
  assert.equal(await auditCount(db), before);
  assert.equal((await db.prepare("SELECT version FROM campaigns WHERE id = ?").bind(id).first<{ version: number }>())?.version, version);
});

test("the 11th test in a UTC day is refused and sends nothing", async (t) => {
  const { db, id, requests } = await world(t);
  const env = envOf(db);
  for (let n = 0; n < 10; n++) assert.equal((await sendTest(env, id)).res.status, 303);
  const refused = await sendTest(env, id);
  assert.equal(refused.res.status, 422);
  assert.match(refused.body, /You&#39;ve sent 10 tests today\. Try again tomorrow\./);
  assert.equal(requests.length, 10);
  assert.equal((await batches(db)).length, 10);
});

test("a test is refused when the day's sending limit is used up", async (t) => {
  const { db, id, requests } = await world(t);
  db.exec("UPDATE settings SET campaign_daily_limit = 1");
  assert.equal((await sendTest(envOf(db), id)).res.status, 303);
  const refused = await sendTest(envOf(db), id);
  assert.equal(refused.res.status, 422);
  assert.match(refused.body, /Today&#39;s sending limit is used up\. Try again tomorrow\./);
  assert.equal(requests.length, 1);
});

test("a post when sending isn't ready is refused with the readiness sentence", async (t) => {
  const { db, id, requests } = await world(t);
  const page = await load(envOf(db), `/campaigns/${id}`);
  const refused = await post(envOf(db, { CAMPAIGN_SENDING: undefined }), path(id), formFields(page.body, path(id)), { cookie: page.cookie, token: page.token });
  assert.equal(refused.res.status, 422);
  assert.match(refused.body, /Sending isn&#39;t set up for this copy yet: it needs its sending switch\./);
  assert.equal(requests.length, 0);
  assert.equal((await batches(db)).length, 0);
});

test("a refusal from Resend is a 422 with its status, and the batch is returned", async (t) => {
  const { db, id } = await world(t, () => new Response("{}", { status: 422 }));
  const refused = await sendTest(envOf(db), id);
  assert.equal(refused.res.status, 422);
  assert.match(refused.body, /The test didn&#39;t go out \(422\)\. Try again in a minute\./);
  assert.deepEqual([(await batches(db))[0]?.status, (await batches(db))[0]?.last_status], ["returned", "422"]);
});

test("a test is a 404 for an unknown, sent or archived campaign and while campaigns are off", async (t) => {
  const { db, id } = await world(t);
  const env = envOf(db);
  const page = await load(env, `/campaigns/${id}`);
  const fields = formFields(page.body, path(id));
  const go = (target: string) => post(env, target, fields, { cookie: page.cookie, token: page.token });
  assert.equal((await go(path("cp_nothere"))).res.status, 404);
  db.exec(`UPDATE campaigns SET status = 'sending' WHERE id = '${id}'`);
  assert.equal((await go(path(id))).res.status, 404);
  db.exec(`UPDATE campaigns SET status = 'draft' WHERE id = '${id}'; UPDATE settings SET campaigns = 0`);
  assert.equal((await go(path(id))).res.status, 404);
  assert.equal((await batches(db)).length, 0);
});

test("the cron never sends a test batch again", async (t) => {
  const { db, id, requests } = await world(t, () => new Response("{}", { status: 503 }));
  const env = envOf(db);
  assert.equal((await sendTest(env, id)).res.status, 422);
  assert.equal((await batches(db))[0]?.status, "in_flight");
  assert.equal(requests.length, 1);
  await runCampaigns(env, new Date(Date.now() + 60_000));
  assert.equal(requests.length, 1);
  assert.equal((await batches(db))[0]?.status, "in_flight");
});
