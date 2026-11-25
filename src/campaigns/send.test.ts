import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { countingDb } from "../../tests/helpers/counting-db.ts";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { CampaignBatchRow, CampaignRecipientRow, CampaignRow, CampaignStepRow, Db } from "../db/db.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import type { Env } from "../env.ts";
import { parseAudience, resolveAudience } from "./audience.ts";
import { addCampaignDraft } from "./drafts.ts";
import { approveCampaign, cancelCampaign, fingerprint, pauseCampaign } from "./freeze.ts";
import { runCampaigns } from "./send.ts";

const NOW = new Date("2026-11-24T18:00:00.000Z");
const DAY = 86_400_000;
const MINUTE = 60_000;
const BASE_URL = "https://board.example.com";

type Sent = { url: string; headers: Record<string, string>; text: string; emails: { to: string[]; reply_to: string; subject: string; text: string; headers: Record<string, string> }[] };

interface World {
  db: SqliteD1;
  env: Env;
  id: string;
  /** Every request the mocked fetch saw, in order. */
  sent: Sent[];
  /** What the next requests answer: a function of the request number and its emails. Default: 200 with one id each. */
  answer: { fn: (call: number, count: number) => Response };
}

const okAnswer = (call: number, count: number): Response =>
  new Response(JSON.stringify({ data: Array.from({ length: count }, (_, i) => ({ id: `re_${call}_${i}` })) }), { status: 200 });

function envFor(db: Db): Env {
  return {
    DB: db,
    CAMPAIGN_SENDING: "on",
    CAMPAIGN_FROM: "News <news@mail.example.com>",
    CAMPAIGN_RESEND_API_KEY: "re_test_key",
    OWNER_EMAILS: "owner@example.com",
  } as unknown as Env;
}

/** A campaign approved at NOW for `people` fake people (ct_p0 ...), ready to send. */
async function world(t: TestContext, people: number, options: { limit?: number; scheduledFor?: Date } = {}): Promise<World> {
  const db = await timeDb(NOW);
  const rows = Array.from({ length: people }, (_, n) => `('ct_p${n}', 'Person${n} Example', 'p${n}@example.com', 'partner')`);
  db.exec(`UPDATE settings SET campaigns = 1, postal_address = '1 Example Road', business_name = 'Example Bakery',
    owner_emails = '["owner@example.com"]', campaign_daily_limit = ${options.limit ?? 90};`);
  db.exec(`INSERT INTO contacts (id, name, email, person_status) VALUES ${rows.join(", ")};`);
  const added = await addCampaignDraft(
    { db, now: NOW, actor: "ai", tool: "add_campaign_draft" },
    { name: "Autumn news", recipients: { kind: "people", people: Array.from({ length: people }, (_, n) => `ct_p${n}`) }, subject: "Hello {{first_name}}", body: "News inside." },
  );
  const campaign = await db.prepare("SELECT * FROM campaigns WHERE id = ?").bind(added.campaignId).first<CampaignRow>();
  const step = await db.prepare("SELECT * FROM campaign_steps WHERE campaign_id = ?").bind(added.campaignId).first<CampaignStepRow>();
  assert.ok(campaign && step);
  const print = await fingerprint(campaign, step, await resolveAudience(db, NOW, parseAudience(campaign.audience)));
  const scheduled = options.scheduledFor !== undefined;
  await approveCampaign({ db, now: NOW, actor: "owner", tool: scheduled ? "campaign_schedule" : "campaign_approve" }, added.campaignId, {
    fingerprint: print,
    sendAfter: options.scheduledFor ?? NOW,
    baseUrl: BASE_URL,
    scheduled,
  });
  const sent: Sent[] = [];
  const answer = { fn: okAnswer };
  t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Sent["emails"];
    sent.push({ url, headers: init.headers as Record<string, string>, text: String(init.body), emails: body });
    return Promise.resolve(answer.fn(sent.length, body.length));
  });
  return { db, env: envFor(db), id: added.campaignId, sent, answer };
}

const all = async <T>(db: Db, sql: string, ...params: (string | number)[]): Promise<T[]> => (await db.prepare(sql).bind(...params).all<T>()).results;
const count = async (db: Db, sql: string, ...params: (string | number)[]): Promise<number> => (await db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).bind(...params).first<number>("n")) ?? -1;
const statusCounts = async (db: Db, id: string): Promise<Record<string, number>> =>
  Object.fromEntries((await all<{ status: string; n: number }>(db, "SELECT status, COUNT(*) AS n FROM campaign_recipients WHERE campaign_id = ? GROUP BY status", id)).map((r) => [r.status, r.n]));
const campaignOf = (db: Db, id: string) => db.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first<CampaignRow>();
const batchesOf = (db: Db, id: string) => all<CampaignBatchRow>(db, "SELECT * FROM campaign_batches WHERE campaign_id = ? ORDER BY created_at, id", id);
const activitiesOf = (db: Db, id: string) => count(db, "SELECT id FROM activities WHERE json_extract(data, '$.campaign') = ?", id);
const at = (ms: number) => new Date(NOW.getTime() + ms);

test("a run sends one batch: the headers, each person's own unsubscribe link, and the reply-to", async (t) => {
  const w = await world(t, 3);
  const counts = await runCampaigns(w.env, NOW);
  assert.deepEqual(counts, { claimed: 3, sent: 3 });
  assert.equal(w.sent.length, 1);
  const [request] = w.sent;
  assert.equal(request?.url, "https://api.resend.com/emails/batch");
  const batch = (await batchesOf(w.db, w.id))[0];
  assert.deepEqual(request?.headers, {
    Authorization: "Bearer re_test_key",
    "Content-Type": "application/json",
    "Idempotency-Key": batch?.id ?? "",
    "User-Agent": "pipeline-engine",
  });
  const tokens = await all<{ email: string; unsub_token: string }>(w.db, "SELECT email, unsub_token FROM campaign_recipients WHERE campaign_id = ?", w.id);
  assert.equal(request?.emails.length, 3);
  for (const email of request?.emails ?? []) {
    const token = tokens.find((row) => row.email === email.to[0])?.unsub_token;
    assert.ok(token);
    assert.equal(email.headers["List-Unsubscribe"], `<${BASE_URL}/unsubscribe/${token}>`);
    assert.equal(email.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    assert.equal(email.reply_to, "owner@example.com");
    assert.equal(email.subject, "Hello there");
    assert.ok(email.text.includes(`/unsubscribe/${token}`));
  }
  assert.deepEqual((request?.emails ?? []).map((email) => email.to[0]).toSorted(), ["p0@example.com", "p1@example.com", "p2@example.com"]);
});

test("done means sent: rows, batch, campaign, one activity each, one audited change, and a second run does nothing", async (t) => {
  const w = await world(t, 3);
  await runCampaigns(w.env, NOW);
  const rows = await all<CampaignRecipientRow>(w.db, "SELECT * FROM campaign_recipients WHERE campaign_id = ? ORDER BY id", w.id);
  assert.ok(rows.every((row) => row.status === "sent" && row.sent_at === NOW.toISOString() && row.resend_id?.startsWith("re_1_")));
  // Each person's Resend id is the one at their position in the request.
  w.sent[0]?.emails.forEach((email, i) => assert.equal(rows.find((row) => row.email === email.to[0])?.resend_id, `re_1_${i}`));
  const [batch] = await batchesOf(w.db, w.id);
  assert.deepEqual([batch?.status, batch?.attempts, batch?.last_status, batch?.kind], ["done", 1, "200", "send"]);
  const campaign = await campaignOf(w.db, w.id);
  assert.deepEqual([campaign?.status, campaign?.completed_at], ["sent", NOW.toISOString()]);
  assert.equal(await activitiesOf(w.db, w.id), 3);
  const activity = await w.db.prepare("SELECT * FROM activities WHERE json_extract(data, '$.campaign') = ? LIMIT 1").bind(w.id).first<{ type: string; actor: string; deal_id: string | null; summary: string }>();
  assert.deepEqual([activity?.type, activity?.actor, activity?.deal_id, activity?.summary], ["email", "system", null, "Campaign: Autumn news"]);
  const audit = await w.db.prepare("SELECT summary, actor, tool FROM audit_log WHERE tool = 'campaign_send'").first<{ summary: string; actor: string; tool: string }>();
  assert.match(audit?.summary ?? "", new RegExp(`^Sent campaign ${w.id} to 3 people \\(change chg_`));
  assert.equal(audit?.actor, "system");
  const again = await runCampaigns(w.env, at(15 * MINUTE));
  assert.deepEqual(again, {});
  assert.equal(w.sent.length, 1);
  assert.equal(await activitiesOf(w.db, w.id), 3);
});

test("campaign emails do not count as reaching the person", async (t) => {
  const w = await world(t, 1);
  await runCampaigns(w.env, NOW);
  const lead = await w.db.prepare("SELECT lead_status FROM contacts WHERE id = 'ct_p0'").first<string>("lead_status");
  assert.notEqual(lead, "contacted");
});

test("nothing is sent while campaigns are off or the Worker is not set up", async (t) => {
  const w = await world(t, 2);
  w.db.exec("UPDATE settings SET campaigns = 0");
  assert.deepEqual(await runCampaigns(w.env, NOW), { skipped: 1 });
  w.db.exec("UPDATE settings SET campaigns = 1");
  for (const off of [{ CAMPAIGN_SENDING: undefined }, { CAMPAIGN_RESEND_API_KEY: undefined }, { CAMPAIGN_FROM: "not an address" }]) {
    assert.deepEqual(await runCampaigns({ ...w.env, ...off }, NOW), { skipped: 1 });
  }
  w.db.exec("UPDATE settings SET postal_address = NULL");
  assert.deepEqual(await runCampaigns(w.env, NOW), { skipped: 1 });
  assert.equal(w.sent.length, 0);
  assert.deepEqual(await statusCounts(w.db, w.id), { queued: 2 });
});

test("a retry after retry_later sends the same key and a byte-identical body, and logs each person once", async (t) => {
  const w = await world(t, 3);
  w.answer.fn = () => new Response("", { status: 503 });
  assert.deepEqual(await runCampaigns(w.env, NOW), { claimed: 3, retry_later: 1 });
  assert.deepEqual(await statusCounts(w.db, w.id), { sending: 3 });
  assert.equal((await batchesOf(w.db, w.id))[0]?.status, "in_flight");
  assert.equal(await activitiesOf(w.db, w.id), 0);
  w.answer.fn = () => new Response(JSON.stringify({ name: "concurrent_idempotent_requests" }), { status: 409 });
  assert.deepEqual(await runCampaigns(w.env, at(15 * MINUTE)), { resent: 1, retry_later: 1 });
  w.answer.fn = okAnswer;
  assert.deepEqual(await runCampaigns(w.env, at(30 * MINUTE)), { resent: 1, sent: 3 });
  assert.equal(w.sent.length, 3);
  const keys = new Set(w.sent.map((s) => s.headers["Idempotency-Key"]));
  assert.equal(keys.size, 1);
  assert.equal(w.sent[1]?.text, w.sent[0]?.text);
  assert.equal(w.sent[2]?.text, w.sent[0]?.text);
  const [batch] = await batchesOf(w.db, w.id);
  assert.deepEqual([batch?.status, batch?.attempts], ["done", 3]);
  assert.equal(await activitiesOf(w.db, w.id), 3);
  assert.equal(await count(w.db, "SELECT id FROM campaign_batches"), 1);
});

test("a network error and a 500 leave the batch in flight", async (t) => {
  const w = await world(t, 2);
  w.answer.fn = () => {
    throw new TypeError("offline");
  };
  assert.deepEqual(await runCampaigns(w.env, NOW), { claimed: 2, retry_later: 1 });
  assert.equal((await batchesOf(w.db, w.id))[0]?.last_status, "network error");
  w.answer.fn = () => new Response("", { status: 500 });
  await runCampaigns(w.env, at(15 * MINUTE));
  assert.equal((await batchesOf(w.db, w.id))[0]?.last_status, "500");
  assert.deepEqual(await statusCounts(w.db, w.id), { sending: 2 });
});

test("a batch in flight for over 20 hours becomes uncertain and is never sent again", async (t) => {
  const w = await world(t, 3);
  w.answer.fn = () => new Response("", { status: 502 });
  await runCampaigns(w.env, NOW);
  const calls = w.sent.length;
  w.answer.fn = okAnswer;
  assert.deepEqual(await runCampaigns(w.env, at(21 * 3_600_000)), { expired: 1, uncertain: 1 });
  assert.equal(w.sent.length, calls);
  assert.deepEqual(await statusCounts(w.db, w.id), { uncertain: 3 });
  const [batch] = await batchesOf(w.db, w.id);
  assert.equal(batch?.status, "uncertain");
  assert.equal((await campaignOf(w.db, w.id))?.status, "sent");
  assert.deepEqual(await runCampaigns(w.env, at(22 * 3_600_000)), {});
  assert.equal(w.sent.length, calls);
  assert.equal(await activitiesOf(w.db, w.id), 0);
});

test("just under 20 hours it is still sent again", async (t) => {
  const w = await world(t, 2);
  w.answer.fn = () => new Response("", { status: 502 });
  await runCampaigns(w.env, NOW);
  w.answer.fn = okAnswer;
  assert.deepEqual(await runCampaigns(w.env, at(19 * 3_600_000)), { resent: 1, sent: 2 });
});

test("429 puts the rows back without pausing, and the next run sends them in a new batch", async (t) => {
  const w = await world(t, 3);
  w.answer.fn = () => new Response(JSON.stringify({ name: "daily_quota_exceeded" }), { status: 429 });
  assert.deepEqual(await runCampaigns(w.env, NOW), { claimed: 3, returned: 1 });
  assert.deepEqual(await statusCounts(w.db, w.id), { queued: 3 });
  const rows = await all<CampaignRecipientRow>(w.db, "SELECT * FROM campaign_recipients WHERE campaign_id = ?", w.id);
  assert.ok(rows.every((row) => row.batch_id === null && row.claimed_at === null));
  assert.deepEqual([(await batchesOf(w.db, w.id))[0]?.status, (await batchesOf(w.db, w.id))[0]?.last_status], ["returned", "429"]);
  const campaign = await campaignOf(w.db, w.id);
  assert.deepEqual([campaign?.status, campaign?.send_error], ["sending", null]);
  w.answer.fn = okAnswer;
  assert.deepEqual(await runCampaigns(w.env, at(15 * MINUTE)), { claimed: 3, sent: 3 });
  assert.equal(await count(w.db, "SELECT id FROM campaign_batches"), 2);
  assert.notEqual(w.sent[0]?.headers["Idempotency-Key"], w.sent[1]?.headers["Idempotency-Key"]);
  assert.equal(await activitiesOf(w.db, w.id), 3);
});

test("a refused request (422) puts the rows back, pauses the campaign with a fixed sentence, and stops the run", async (t) => {
  const w = await world(t, 3);
  w.answer.fn = () => new Response(JSON.stringify({ name: "validation_error", message: "p1@example.com is bad" }), { status: 422 });
  assert.deepEqual(await runCampaigns(w.env, NOW), { claimed: 3, returned: 1, paused: 1 });
  assert.deepEqual(await statusCounts(w.db, w.id), { queued: 3 });
  const campaign = await campaignOf(w.db, w.id);
  assert.deepEqual([campaign?.status, campaign?.send_error], ["paused", "Resend refused the last batch (status 422). Nothing in it was sent. Resume to try again."]);
  const audit = await w.db.prepare("SELECT actor, summary FROM audit_log WHERE tool = 'campaign_send'").first<{ actor: string; summary: string }>();
  assert.equal(audit?.actor, "system");
  assert.doesNotMatch(JSON.stringify(audit), /@example\.com/);
  // Paused: the next run sends nothing; after Resume it does.
  assert.deepEqual(await runCampaigns(w.env, at(15 * MINUTE)), {});
  w.db.exec("UPDATE campaigns SET status = 'sending', send_error = NULL, version = version + 1");
  w.answer.fn = okAnswer;
  assert.deepEqual(await runCampaigns(w.env, at(30 * MINUTE)), { claimed: 3, sent: 3 });
  assert.equal(await activitiesOf(w.db, w.id), 3);
});

test("400, 401, 403 and 404 pause too", async (t) => {
  for (const status of [400, 401, 403, 404]) {
    const w = await world(t, 1);
    w.answer.fn = () => new Response("{}", { status });
    assert.deepEqual(await runCampaigns(w.env, NOW), { claimed: 1, returned: 1, paused: 1 }, String(status));
    assert.match((await campaignOf(w.db, w.id))?.send_error ?? "", new RegExp(`\\(status ${status}\\)`));
  }
});

test("an unconfirmed answer (409 invalid_idempotent_request, or a malformed 200) makes the batch and its rows uncertain", async (t) => {
  for (const respond of [() => new Response(JSON.stringify({ name: "invalid_idempotent_request" }), { status: 409 }), () => new Response(JSON.stringify({ data: [] }), { status: 200 })]) {
    const w = await world(t, 3);
    w.answer.fn = respond;
    assert.deepEqual(await runCampaigns(w.env, NOW), { claimed: 3, uncertain: 1 });
    assert.deepEqual(await statusCounts(w.db, w.id), { uncertain: 3 });
    assert.equal((await batchesOf(w.db, w.id))[0]?.status, "uncertain");
    assert.equal(await activitiesOf(w.db, w.id), 0);
    assert.deepEqual(await runCampaigns(w.env, at(15 * MINUTE)), {});
    assert.equal(w.sent.length, 1);
  }
});

test("someone suppressed or archived after approval is skipped at claim, and gets nothing", async (t) => {
  const w = await world(t, 5);
  w.db.exec(`INSERT INTO email_suppressions (id, email, reason, contact_id) VALUES
      ('su_a', 'p0@example.com', 'bounced', NULL),
      ('su_b', 'other@example.com', 'unsubscribed', 'ct_p1'),
      ('su_c', 'p2@example.com', 'unsubscribed', 'ct_p2'),
      ('su_d', 'p3@example.com', 'complained', NULL);
    UPDATE email_suppressions SET cleared_at = '2026-11-24T00:00:00.000Z' WHERE id = 'su_c';
    UPDATE contacts SET archived = 1 WHERE id = 'ct_p4';`);
  assert.deepEqual(await runCampaigns(w.env, NOW), { claimed: 1, sent: 1 });
  assert.deepEqual(w.sent[0]?.emails.map((email) => email.to[0]), ["p2@example.com"]);
  const rows = await all<CampaignRecipientRow>(w.db, "SELECT * FROM campaign_recipients WHERE campaign_id = ? ORDER BY email", w.id);
  assert.deepEqual(
    rows.map((row) => [row.email, row.status, row.skip_reason, row.unsub_token === null]),
    [
      ["p0@example.com", "skipped", "bounced", true],
      ["p1@example.com", "skipped", "unsubscribed", true],
      ["p2@example.com", "sent", null, false],
      ["p3@example.com", "skipped", "complained", true],
      ["p4@example.com", "skipped", "archived", true],
    ],
  );
  assert.equal(await activitiesOf(w.db, w.id), 1);
  assert.equal((await campaignOf(w.db, w.id))?.status, "sent");
});

test("the claim's suppression rule agrees with the audience's", async (t) => {
  const w = await world(t, 6);
  w.db.exec(`INSERT INTO email_suppressions (id, email, reason, contact_id) VALUES
      ('su_a', 'p0@example.com', 'bounced', NULL),
      ('su_b', 'new@example.com', 'unsubscribed', 'ct_p1'),
      ('su_c', 'new2@example.com', 'bounced', 'ct_p2'),
      ('su_d', 'p3@example.com', 'complained', 'ct_p5'),
      ('su_e', 'p4@example.com', 'unsubscribed', NULL);
    UPDATE email_suppressions SET cleared_at = '2026-11-24T00:00:00.000Z' WHERE id = 'su_e';`);
  const resolved = await resolveAudience(w.db, NOW, { kind: "people", people: Array.from({ length: 6 }, (_, n) => `ct_p${n}`) });
  await runCampaigns(w.env, NOW);
  const skipped = await all<{ contact_id: string; skip_reason: string }>(w.db, "SELECT contact_id, skip_reason FROM campaign_recipients WHERE status = 'skipped' ORDER BY contact_id");
  assert.deepEqual(skipped.map((r) => r.contact_id), resolved.skipped.map((m) => m.contactId).toSorted());
  for (const row of skipped) assert.equal(row.skip_reason, resolved.skipped.find((m) => m.contactId === row.contact_id)?.reason);
});

test("a 250-person campaign with a limit of 90 sends 90 a UTC day over three days and never more", async (t) => {
  const w = await world(t, 250, { limit: 90 });
  const total = () => w.sent.reduce((sum, s) => sum + s.emails.length, 0);
  assert.deepEqual(await runCampaigns(w.env, NOW), { claimed: 90, sent: 90 });
  // Later runs the same UTC day, including the last minute of it, send nothing.
  for (const ms of [15 * MINUTE, 3_600_000, 6 * 3_600_000 - MINUTE]) {
    assert.deepEqual(await runCampaigns(w.env, at(ms)), { no_room: 1 });
  }
  assert.equal(total(), 90);
  const day2 = new Date("2026-11-25T00:05:00.000Z");
  assert.deepEqual(await runCampaigns(w.env, day2), { claimed: 90, sent: 90 });
  assert.deepEqual(await runCampaigns(w.env, new Date(day2.getTime() + MINUTE)), { no_room: 1 });
  assert.equal(total(), 180);
  const day3 = new Date(NOW.getTime() + 2 * DAY);
  assert.deepEqual(await runCampaigns(w.env, day3), { claimed: 70, sent: 70 });
  assert.equal(total(), 250);
  assert.equal((await campaignOf(w.db, w.id))?.status, "sent");
  const emails = w.sent.flatMap((s) => s.emails.map((e) => e.to[0]));
  assert.equal(new Set(emails).size, 250);
  assert.equal(await activitiesOf(w.db, w.id), 250);
});

test("a batch is at most 100 emails whatever the limit", async (t) => {
  const w = await world(t, 130, { limit: 5000 });
  assert.deepEqual(await runCampaigns(w.env, NOW), { claimed: 100, sent: 100 });
  assert.deepEqual(await runCampaigns(w.env, at(15 * MINUTE)), { claimed: 30, sent: 30 });
});

test("today's test sends use up room", async (t) => {
  const w = await world(t, 100, { limit: 90 });
  w.db.exec(`INSERT INTO campaign_batches (id, campaign_id, kind, status, created_at) VALUES
      ('cb_t1', '${w.id}', 'test', 'done', '2026-11-24T09:00:00.000Z'),
      ('cb_t2', '${w.id}', 'test', 'done', '2026-11-24T10:00:00.000Z'),
      ('cb_t0', '${w.id}', 'test', 'done', '2026-11-23T23:59:59.000Z');`);
  assert.deepEqual(await runCampaigns(w.env, NOW), { claimed: 88, sent: 88 });
});

test("a returned batch gives its room back", async (t) => {
  const w = await world(t, 100, { limit: 90 });
  w.answer.fn = () => new Response("", { status: 429 });
  await runCampaigns(w.env, NOW);
  w.answer.fn = okAnswer;
  assert.deepEqual(await runCampaigns(w.env, at(15 * MINUTE)), { claimed: 90, sent: 90 });
});

test("two overlapping runs claim different people and nobody is emailed twice", async (t) => {
  const w = await world(t, 150, { limit: 5000 });
  const counts = await Promise.all([runCampaigns(w.env, NOW), runCampaigns(w.env, NOW)]);
  const claimed = counts.reduce((sum, c) => sum + (c.claimed ?? 0), 0);
  assert.equal(claimed, 150);
  const emails = w.sent.flatMap((s) => s.emails.map((e) => e.to[0]));
  assert.equal(emails.length, 150);
  assert.equal(new Set(emails).size, 150);
  assert.equal(new Set(w.sent.map((s) => s.headers["Idempotency-Key"])).size, w.sent.length);
  assert.equal(await activitiesOf(w.db, w.id), 150);
  assert.deepEqual(await statusCounts(w.db, w.id), { sent: 150 });
});

test("pause stops new batches but the batch in flight still resolves", async (t) => {
  const w = await world(t, 150, { limit: 5000 });
  w.answer.fn = () => new Response("", { status: 503 });
  await runCampaigns(w.env, NOW);
  await pauseCampaign({ db: w.db, now: at(MINUTE), actor: "owner", tool: "campaign_pause" }, w.id);
  w.answer.fn = okAnswer;
  assert.deepEqual(await runCampaigns(w.env, at(15 * MINUTE)), { resent: 1, sent: 100 });
  assert.deepEqual(await statusCounts(w.db, w.id), { queued: 50, sent: 100 });
  const campaign = await campaignOf(w.db, w.id);
  assert.equal(campaign?.status, "paused");
  assert.deepEqual(await runCampaigns(w.env, at(30 * MINUTE)), {});
  assert.equal(w.sent.length, 2);
});

test("cancel after the claim leaves the claimed rows to resolve, and the campaign stays cancelled", async (t) => {
  const w = await world(t, 150, { limit: 5000 });
  w.answer.fn = () => new Response("", { status: 503 });
  await runCampaigns(w.env, NOW);
  await cancelCampaign({ db: w.db, now: at(MINUTE), actor: "owner", tool: "campaign_cancel" }, w.id);
  w.answer.fn = okAnswer;
  assert.deepEqual(await runCampaigns(w.env, at(15 * MINUTE)), { resent: 1, sent: 100 });
  assert.deepEqual(await statusCounts(w.db, w.id), { cancelled: 50, sent: 100 });
  assert.equal((await campaignOf(w.db, w.id))?.status, "cancelled");
  assert.equal(w.sent.length, 2);
});

test("a batch another run resolved first is not logged twice", async (t) => {
  const w = await world(t, 3);
  // While Resend answers, a competing run resolves the same batch.
  w.answer.fn = (call, n) => {
    w.db.exec("UPDATE campaign_recipients SET status = 'sent' WHERE status = 'sending'; UPDATE campaign_batches SET status = 'done'");
    return okAnswer(call, n);
  };
  assert.deepEqual(await runCampaigns(w.env, NOW), { claimed: 3, stale: 1 });
  assert.equal(await activitiesOf(w.db, w.id), 0);
  assert.equal(await count(w.db, "SELECT id FROM audit_log WHERE tool = 'campaign_send'"), 0);
});

test("a scheduled campaign starts when its time comes", async (t) => {
  const w = await world(t, 3, { scheduledFor: at(2 * 3_600_000) });
  assert.deepEqual(await runCampaigns(w.env, at(3_600_000)), {});
  assert.equal(w.sent.length, 0);
  assert.deepEqual(await runCampaigns(w.env, at(2 * 3_600_000 + 5 * MINUTE)), { promoted: 1, claimed: 3, sent: 3 });
  assert.equal(await count(w.db, "SELECT id FROM audit_log WHERE summary LIKE ?", `Started sending campaign ${w.id}%`), 1);
  assert.equal((await campaignOf(w.db, w.id))?.status, "sent");
});

test("a run makes at most 12 D1 calls, sending 100 emails", async (t) => {
  const w = await world(t, 100, { limit: 5000 });
  const db = countingDb(w.db);
  const env = envFor(db);
  const started = performance.now();
  assert.deepEqual(await runCampaigns(env, NOW), { claimed: 100, sent: 100 });
  t.diagnostic(`100-email run: ${db.calls} D1 calls: ${db.log.join(" | ")}; ${(performance.now() - started).toFixed(0)} ms in Node, fetch mocked`);
  assert.ok(db.calls <= 12, `${db.calls} calls: ${db.log.join(" | ")}`);
  db.reset();
  await runCampaigns(env, at(MINUTE));
  assert.ok(db.calls <= 12);
  assert.equal(db.calls, 1);
});

test("a resend plus a new batch stays within 12 D1 calls", async (t) => {
  const w = await world(t, 200, { limit: 5000 });
  w.answer.fn = () => new Response("", { status: 503 });
  await runCampaigns(w.env, NOW);
  w.answer.fn = okAnswer;
  const db = countingDb(w.db);
  await runCampaigns(envFor(db), at(15 * MINUTE));
  t.diagnostic(`resend plus new batch: ${db.calls} D1 calls: ${db.log.join(" | ")}`);
  assert.ok(db.calls <= 12, `${db.calls} calls: ${db.log.join(" | ")}`);
});

test("a run with nothing to do is one D1 call", async (t) => {
  const w = await world(t, 1);
  const db = countingDb(w.db);
  w.db.exec("UPDATE settings SET campaigns = 0");
  await runCampaigns(envFor(db), NOW);
  assert.equal(db.calls, 1);
});

test("nothing in the log or the database holds the API key or a response body", async (t) => {
  const w = await world(t, 2);
  w.answer.fn = () => new Response(JSON.stringify({ name: "validation_error", message: "secret detail p0@example.com" }), { status: 422 });
  await runCampaigns(w.env, NOW);
  const dump = JSON.stringify([
    await all(w.db, "SELECT * FROM audit_log"),
    await all(w.db, "SELECT * FROM campaign_batches"),
    await all(w.db, "SELECT send_error FROM campaigns"),
  ]);
  assert.equal(dump.includes("re_test_key"), false);
  assert.equal(dump.includes("secret detail"), false);
});

test("a refusal of a RESEND never re-queues: 503 then 401 makes the rows uncertain, pauses, and sends nothing new", async (t) => {
  const w = await world(t, 3);
  w.answer.fn = () => new Response("", { status: 503 });
  await runCampaigns(w.env, NOW);
  w.answer.fn = () => new Response("{}", { status: 401 });
  assert.deepEqual(await runCampaigns(w.env, at(15 * MINUTE)), { resent: 1, uncertain: 1, paused: 1 });
  assert.deepEqual(await statusCounts(w.db, w.id), { uncertain: 3 });
  assert.equal((await batchesOf(w.db, w.id))[0]?.status, "uncertain");
  const campaign = await campaignOf(w.db, w.id);
  assert.equal(campaign?.status, "paused");
  assert.match(campaign?.send_error ?? "", /\(status 401\)\. It may have been sent/);
  w.db.exec("UPDATE campaigns SET status = 'sending', send_error = NULL, version = version + 1");
  w.answer.fn = okAnswer;
  await runCampaigns(w.env, at(30 * MINUTE));
  assert.equal(w.sent.length, 2);
  assert.equal(new Set(w.sent.map((s) => s.headers["Idempotency-Key"])).size, 1);
  assert.equal(await count(w.db, "SELECT id FROM campaign_batches"), 1);
  assert.equal(await activitiesOf(w.db, w.id), 0);
});

test("503 then 429 on the resend stays in flight, and after 20 hours becomes uncertain", async (t) => {
  const w = await world(t, 3);
  w.answer.fn = () => new Response("", { status: 503 });
  await runCampaigns(w.env, NOW);
  w.answer.fn = () => new Response("{}", { status: 429 });
  assert.deepEqual(await runCampaigns(w.env, at(15 * MINUTE)), { resent: 1, retry_later: 1 });
  const [batch] = await batchesOf(w.db, w.id);
  assert.deepEqual([batch?.status, batch?.last_status, batch?.attempts], ["in_flight", "429", 2]);
  assert.deepEqual(await statusCounts(w.db, w.id), { sending: 3 });
  assert.equal((await campaignOf(w.db, w.id))?.status, "sending");
  assert.deepEqual(await runCampaigns(w.env, at(21 * 3_600_000)), { expired: 1, uncertain: 1 });
  assert.deepEqual(await statusCounts(w.db, w.id), { uncertain: 3 });
  assert.equal(await count(w.db, "SELECT id FROM campaign_batches"), 1);
});

test("the first attempt's 422 still re-queues and pauses", async (t) => {
  const w = await world(t, 2);
  w.answer.fn = () => new Response("{}", { status: 422 });
  await runCampaigns(w.env, NOW);
  assert.deepEqual(await statusCounts(w.db, w.id), { queued: 2 });
  assert.equal((await campaignOf(w.db, w.id))?.status, "paused");
});

test("two concurrent runs never claim more than the day's limit", async (t) => {
  const w = await world(t, 20, { limit: 5 });
  await Promise.all([runCampaigns(w.env, NOW), runCampaigns(w.env, NOW), runCampaigns(w.env, NOW)]);
  assert.equal(await count(w.db, "SELECT id FROM campaign_recipients WHERE claimed_at IS NOT NULL"), 5);
  assert.equal(w.sent.reduce((n, s) => n + s.emails.length, 0), 5);
  assert.equal(await count(w.db, "SELECT id FROM campaign_batches WHERE status = 'in_flight'"), 0);
  assert.equal(await count(w.db, "SELECT id FROM campaign_batches"), 1);
});

test("a batch in flight is resent even when 51 other campaigns are sending", async (t) => {
  const w = await world(t, 3);
  w.answer.fn = () => new Response("", { status: 503 });
  await runCampaigns(w.env, NOW);
  w.db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 51)
    INSERT INTO campaigns (id, name, status, audience, approved_at, base_url)
    SELECT 'cp_x' || i, 'Other ' || i, 'sending', '{"kind":"people","people":[]}', '2026-01-01T00:00:00.000Z', '${BASE_URL}' FROM n;`);
  w.answer.fn = okAnswer;
  assert.deepEqual(await runCampaigns(w.env, at(15 * MINUTE)), { resent: 1, sent: 3 });
  assert.equal((await batchesOf(w.db, w.id))[0]?.status, "done");
});

test("a first attempt answered 429 after another run resent and was accepted leaves the rows sent, never queued", async (t) => {
  const w = await world(t, 3);
  const real = globalThis.fetch;
  const gate: { open: () => void } = { open: () => {} };
  const second = new Promise<void>((resolve) => (gate.open = resolve));
  let requests = 0;
  let runB: Promise<unknown> = Promise.resolve();
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requests += 1;
    if (requests === 1) {
      // Run A's request. Run B loads the batch as in flight and sends it again; Resend accepts B's and answers A's 429.
      runB = runCampaigns(w.env, at(MINUTE));
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response("{}", { status: 429 });
    }
    await second;
    return real(url, init);
  });
  await runCampaigns(w.env, NOW);
  // A has written its answer first; now B's 200 arrives.
  assert.deepEqual(await statusCounts(w.db, w.id), { sending: 3 });
  gate.open();
  await runB;
  assert.equal(requests, 2);
  assert.deepEqual(await statusCounts(w.db, w.id), { sent: 3 });
  const [batch] = await batchesOf(w.db, w.id);
  assert.deepEqual([batch?.status, batch?.attempts], ["done", 2]);
  assert.equal(await count(w.db, "SELECT id FROM campaign_batches"), 1);
  assert.equal(await activitiesOf(w.db, w.id), 3);
});

test("a run that finds another run already took over a batch in flight skips it", async (t) => {
  const w = await world(t, 3);
  w.answer.fn = () => new Response("", { status: 503 });
  await runCampaigns(w.env, NOW);
  const calls = w.sent.length;
  // Another run bumps the attempts after this one read them.
  const real = w.db.batch.bind(w.db);
  let bumped = false;
  t.mock.method(w.db, "batch", (statements: D1PreparedStatement[]) => {
    if (!bumped) {
      bumped = true;
      const result = real(statements);
      w.db.exec("UPDATE campaign_batches SET attempts = attempts + 1");
      return result;
    }
    return real(statements);
  });
  w.answer.fn = okAnswer;
  assert.deepEqual(await runCampaigns(w.env, at(15 * MINUTE)), {});
  assert.equal(w.sent.length, calls);
});
