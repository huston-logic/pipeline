import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { clearSuppression } from "../campaigns/suppressions.ts";
import { verifySvix } from "../campaigns/svix.ts";
import { createTestDb, type SqliteD1 } from "../db/sqlite-d1.ts";
import type { Env } from "../env.ts";
import worker from "../index.ts";
import { handleResendWebhook } from "./resend-webhook.ts";

const NOW = new Date("2026-11-24T18:00:00.000Z");
const SECRET_BYTES = Buffer.from("example-webhook-key-0123456789ab");
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
const stamp = (date: Date): string => String(Math.floor(date.getTime() / 1000));

const sign = (id: string, timestamp: string, body: string, secret = SECRET_BYTES): string =>
  `v1,${createHmac("sha256", secret).update(`${id}.${timestamp}.${body}`).digest("base64")}`;

async function setup(secret: string = SECRET, status = "sent"): Promise<{ db: SqliteD1; env: Env }> {
  const db = await createTestDb();
  db.exec(`UPDATE settings SET campaigns = 0;
    INSERT INTO contacts (id, name, email, person_status, sub_status) VALUES ('ct_hook1', 'Pat Example', 'pat@example.com', 'contact', NULL);
    INSERT INTO campaigns (id, name, status, audience) VALUES ('cp_hook1', 'News', 'sent', '{"kind":"people","people":["ct_hook1"]}');
    INSERT INTO campaign_steps (id, campaign_id, position, subject, body) VALUES ('cs_hook1', 'cp_hook1', 1, 'Hi', 'Hi.');
    INSERT INTO campaign_recipients (id, campaign_id, step_id, contact_id, email, status, unsub_token, resend_id)
      VALUES ('rc_hook1', 'cp_hook1', 'cs_hook1', 'ct_hook1', 'pat@example.com', '${status}', 'tok', 'em_one')`);
  const env: Env = { ENVIRONMENT: "production", DB: db, ASSETS: { fetch: async () => new Response("") }, ...(secret ? { CAMPAIGN_WEBHOOK_SECRET: secret } : {}) };
  return { db, env };
}

function post(env: Env, body: string, over: { id?: string; timestamp?: string; signature?: string; method?: string } = {}): Promise<Response> {
  const id = over.id ?? "msg_1";
  const timestamp = over.timestamp ?? stamp(NOW);
  return handleResendWebhook(
    new Request("https://pipeline.example.com/hooks/resend", {
      method: over.method ?? "POST",
      headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": over.signature ?? sign(id, timestamp, body) },
      body: over.method === "GET" ? undefined : body,
    }),
    env,
    NOW,
  );
}

const event = (type: string, data: Record<string, unknown> = {}, emailId = "em_one"): string => JSON.stringify({ type, data: { email_id: emailId, ...data } });

const recipient = (db: SqliteD1) => db.prepare("SELECT status, delivered_at, bounced_at, complained_at FROM campaign_recipients WHERE id = 'rc_hook1'").first<Record<string, string | null>>();
const count = async (db: SqliteD1, sql: string): Promise<number> => (await db.prepare(sql).first<{ n: number }>())?.n ?? -1;

test("verifySvix accepts an independently computed signature, among several entries", async () => {
  const body = '{"type":"email.delivered"}';
  const headers = { id: "msg_9", timestamp: stamp(NOW), signature: "" };
  const good = sign(headers.id, headers.timestamp, body);
  assert.equal(await verifySvix(SECRET, { ...headers, signature: `v1,AAAA ${good}` }, body, NOW), true);
  assert.equal(await verifySvix(SECRET, { ...headers, signature: good.replace("v1,", "v2,") }, body, NOW), false);
  assert.equal(await verifySvix(SECRET, { ...headers, signature: good }, `${body} `, NOW), false);
  assert.equal(await verifySvix("not-a-secret", { ...headers, signature: good }, body, NOW), false);
});

test("a wrong secret, tampered body or timestamp 6 minutes off either way is 401", async () => {
  const { env } = await setup();
  const body = event("email.delivered");
  assert.equal((await post(env, body, { signature: sign("msg_1", stamp(NOW), body, Buffer.from("another-key")) })).status, 401);
  assert.equal((await post(env, body, { signature: sign("msg_1", stamp(NOW), "{}") })).status, 401);
  for (const offset of [-360_000, 360_000]) {
    const timestamp = stamp(new Date(NOW.getTime() + offset));
    assert.equal((await post(env, body, { timestamp, signature: sign("msg_1", timestamp, body) })).status, 401);
  }
});

test("no secret is 503, a GET is 405, missing headers 400, a body over 64 KB 413", async () => {
  const { env } = await setup("");
  assert.equal((await post(env, "{}")).status, 503);
  const set = await setup();
  assert.equal((await post(set.env, "{}", { method: "GET" })).status, 405);
  const bare = await handleResendWebhook(new Request("https://pipeline.example.com/hooks/resend", { method: "POST", body: "{}" }), set.env, NOW);
  assert.equal(bare.status, 400);
  const big = "x".repeat(64 * 1024 + 1);
  assert.equal((await post(set.env, big)).status, 413);
});

test("bad JSON or a missing type or email id is 400, signed", async () => {
  const { env } = await setup();
  assert.equal((await post(env, "not json")).status, 400);
  assert.equal((await post(env, JSON.stringify({ data: { email_id: "em_one" } }))).status, 400);
  assert.equal((await post(env, JSON.stringify({ type: "email.delivered", data: {} }))).status, 400);
});

test("delivered moves sent to delivered once, with no audit row", async () => {
  const { db, env } = await setup();
  const res = await post(env, event("email.delivered"));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok\n");
  const row = await recipient(db);
  assert.equal(row?.status, "delivered");
  assert.equal(row?.delivered_at, NOW.toISOString());
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM audit_log WHERE tool = 'campaign_webhook'"), 0);
  await post(env, event("email.delivered"), {});
  assert.equal((await recipient(db))?.status, "delivered");
});

test("a permanent bounce marks the row and blocks the address in one audited change", async () => {
  const { db, env } = await setup();
  assert.equal((await post(env, event("email.bounced", { bounce: { type: "Permanent" } }))).status, 200);
  assert.equal((await recipient(db))?.status, "bounced");
  assert.equal((await recipient(db))?.bounced_at, NOW.toISOString());
  const block = await db.prepare("SELECT email, reason, contact_id, campaign_id FROM email_suppressions").first<Record<string, string>>();
  assert.deepEqual(block, { email: "pat@example.com", reason: "bounced", contact_id: "ct_hook1", campaign_id: "cp_hook1" });
  const audit = await db.prepare("SELECT actor, summary FROM audit_log WHERE tool = 'campaign_webhook'").all<{ actor: string; summary: string }>();
  assert.equal(audit.results.length, 1);
  assert.equal(audit.results[0]?.actor, "system");
  assert.match(audit.results[0]?.summary ?? "", /^Stopped campaign emails to contact ct_hook1: the address bounced \(change chg_\w+\)$/);
  await post(env, event("email.bounced", { bounce: { type: "Permanent" } }));
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM email_suppressions"), 1);
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM audit_log WHERE tool = 'campaign_webhook'"), 1);
});

test("a temporary bounce is ignored", async () => {
  const { db, env } = await setup();
  assert.equal((await post(env, event("email.bounced", { bounce: { type: "Temporary" } }))).status, 200);
  assert.equal((await recipient(db))?.status, "sent");
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM email_suppressions"), 0);
});

test("a delivered after a bounce does not move it back", async () => {
  const { db, env } = await setup();
  await post(env, event("email.bounced", { bounce: { type: "Permanent" } }));
  await post(env, event("email.delivered"));
  assert.equal((await recipient(db))?.status, "bounced");
});

test("a complaint marks the row and blocks the address", async () => {
  const { db, env } = await setup(SECRET, "delivered");
  assert.equal((await post(env, event("email.complained"))).status, 200);
  assert.equal((await recipient(db))?.status, "complained");
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM email_suppressions WHERE reason = 'complained'"), 1);
  const audit = await db.prepare("SELECT summary FROM audit_log WHERE tool = 'campaign_webhook'").first<{ summary: string }>();
  assert.match(audit?.summary ?? "", /^Stopped campaign emails to contact ct_hook1: they marked an email as spam \(change /);
});

test("an existing unsubscribe means no second block, but the status still moves", async () => {
  const { db, env } = await setup();
  db.exec("INSERT INTO email_suppressions (id, email, reason) VALUES ('su_old1', 'pat@example.com', 'unsubscribed')");
  await post(env, event("email.complained"));
  assert.equal((await recipient(db))?.status, "complained");
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM email_suppressions"), 1);
});

test("suppressed fails the row and blocks the address; failed only fails it", async () => {
  const { db, env } = await setup();
  await post(env, event("email.suppressed"));
  assert.equal((await recipient(db))?.status, "failed");
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM email_suppressions WHERE reason = 'bounced'"), 1);
  const other = await setup();
  await post(other.env, event("email.failed"));
  assert.equal((await recipient(other.db))?.status, "failed");
  assert.equal(await count(other.db, "SELECT COUNT(*) AS n FROM email_suppressions"), 0);
});

test("a permanent bounce on a failed row still blocks the address, and a repeat adds nothing", async () => {
  const { db, env } = await setup(SECRET, "failed");
  await post(env, event("email.bounced", { bounce: { type: "Permanent" } }));
  assert.equal((await recipient(db))?.status, "failed");
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM email_suppressions WHERE reason = 'bounced'"), 1);
  await post(env, event("email.bounced", { bounce: { type: "Permanent" } }));
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM email_suppressions"), 1);
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM audit_log WHERE tool = 'campaign_webhook'"), 1);
});

test("a complaint on an already bounced row blocks the address when no block stands", async () => {
  const { db, env } = await setup(SECRET, "bounced");
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM email_suppressions"), 0);
  await post(env, event("email.complained"));
  assert.equal((await recipient(db))?.status, "bounced");
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM email_suppressions WHERE reason = 'complained'"), 1);
});

const unsubscribed = (db: SqliteD1): void =>
  db.exec(`UPDATE settings SET campaigns = 1; INSERT INTO email_suppressions (id, email, reason, contact_id) VALUES ('su_old1', 'pat@example.com', 'unsubscribed', 'ct_hook1')`);

const clear = (db: SqliteD1) => clearSuppression({ db, now: NOW, actor: "owner", tool: "clear_suppression" }, "ct_hook1");

test("a complaint after an unsubscribe upgrades the block, so the owner cannot clear it", async () => {
  const { db, env } = await setup();
  unsubscribed(db);
  await post(env, event("email.complained"));
  const live = await db.prepare("SELECT id, reason, version FROM email_suppressions WHERE cleared_at IS NULL").all<Record<string, string | number>>();
  assert.deepEqual(live.results, [{ id: "su_old1", reason: "complained", version: 2 }]);
  const audit = await db.prepare("SELECT actor, summary FROM audit_log WHERE tool = 'campaign_webhook'").all<{ actor: string; summary: string }>();
  assert.equal(audit.results.length, 1);
  assert.match(audit.results[0]?.summary ?? "", /^Stopped campaign emails to contact ct_hook1: they marked an email as spam \(change /);
  await assert.rejects(clear(db), /no unsubscribe to clear/);
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM email_suppressions WHERE cleared_at IS NULL"), 1);
});

test("a permanent bounce after an unsubscribe upgrades it the same way", async () => {
  const { db, env } = await setup();
  unsubscribed(db);
  await post(env, event("email.bounced", { bounce: { type: "Permanent" } }));
  assert.equal((await db.prepare("SELECT reason FROM email_suppressions").first<{ reason: string }>())?.reason, "bounced");
  await assert.rejects(clear(db), /no unsubscribe to clear/);
});

test("a complaint after a bounce changes nothing", async () => {
  const { db, env } = await setup();
  await post(env, event("email.bounced", { bounce: { type: "Permanent" } }));
  await post(env, event("email.complained"));
  const live = await db.prepare("SELECT reason, version FROM email_suppressions").all<Record<string, string | number>>();
  assert.deepEqual(live.results, [{ reason: "bounced", version: 1 }]);
});

test("an uncertain row with no resend id is found by the campaign tag and address", async () => {
  const { db, env } = await setup(SECRET, "uncertain");
  db.exec("UPDATE campaign_recipients SET resend_id = NULL");
  const tagged = { tags: { campaign: "cp_hook1" }, to: ["Pat@Example.com"] };
  assert.equal((await post(env, event("email.complained", tagged, "em_never_stored"))).status, 200);
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM email_suppressions WHERE reason = 'complained'"), 1);
  assert.equal((await recipient(db))?.status, "uncertain");
});

test("the list form of tags works, and a wrong campaign tag or a non-blocking event blocks nothing", async () => {
  const { db, env } = await setup(SECRET, "uncertain");
  db.exec("UPDATE campaign_recipients SET resend_id = NULL");
  await post(env, event("email.complained", { tags: { campaign: "cp_other" }, to: ["pat@example.com"] }, "em_x"));
  await post(env, event("email.delivered", { tags: { campaign: "cp_hook1" }, to: ["pat@example.com"] }, "em_x"));
  await post(env, event("email.bounced", { bounce: { type: "Temporary" }, tags: { campaign: "cp_hook1" }, to: ["pat@example.com"] }, "em_x"));
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM email_suppressions"), 0);
  await post(env, event("email.bounced", { bounce: { type: "Permanent" }, tags: [{ name: "campaign", value: "cp_hook1" }], to: ["pat@example.com"] }, "em_x"));
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM email_suppressions WHERE reason = 'bounced'"), 1);
});

test("the signature covers the raw bytes: a BOM or invalid UTF-8 verifies, then is a 400", async () => {
  const { db, env } = await setup();
  for (const body of [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(event("email.delivered"))]), Buffer.from([0x7b, 0xff, 0xfe, 0x7d])]) {
    const timestamp = stamp(NOW);
    const signature = `v1,${createHmac("sha256", SECRET_BYTES).update(Buffer.concat([Buffer.from(`msg_1.${timestamp}.`), body])).digest("base64")}`;
    const res = await handleResendWebhook(
      new Request("https://pipeline.example.com/hooks/resend", {
        method: "POST",
        headers: { "svix-id": "msg_1", "svix-timestamp": timestamp, "svix-signature": signature },
        body,
      }),
      env,
      NOW,
    );
    assert.equal(res.status, 400);
  }
  assert.equal((await recipient(db))?.status, "sent");
});

test("an unknown id and an ignored event type are 200 and write nothing", async () => {
  const { db, env } = await setup();
  assert.equal((await post(env, event("email.delivered", {}, "em_unknown"))).status, 200);
  assert.equal((await post(env, event("email.opened"))).status, 200);
  assert.equal((await recipient(db))?.status, "sent");
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM email_suppressions"), 0);
});

test("the Worker answers /hooks/resend before any sign-in, with campaigns off", async () => {
  const { env } = await setup();
  const body = event("email.delivered");
  const timestamp = stamp(new Date());
  const res = await worker.fetch(
    new Request("https://pipeline.example.com/hooks/resend", {
      method: "POST",
      headers: { "svix-id": "msg_1", "svix-timestamp": timestamp, "svix-signature": sign("msg_1", timestamp, body) },
      body,
    }),
    env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
  assert.equal(res.status, 200);
});
