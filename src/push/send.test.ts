import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditRow, Db, PushSubscriptionRow } from "../db/db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import type { Env } from "../env.ts";
import { toBase64Url } from "./bytes.ts";
import { BRIEF_PAYLOAD, sendBriefPush } from "./send.ts";
import { subscribePush } from "./subscriptions.ts";

const NOW = new Date("2026-11-19T15:00:00.000Z");

async function fakeSecrets() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return { VAPID_PUBLIC_KEY: toBase64Url(raw), VAPID_PRIVATE_KEY: jwk.d ?? "", VAPID_SUBJECT: "mailto:owner@example.com" };
}

/** A real browser-side key pair, so the encrypted body is built exactly as for a phone. */
async function browserKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { p256dh: toBase64Url(raw), auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) };
}

async function subscribe(db: Db, n: number) {
  await subscribePush({ db, now: NOW, actor: "owner", tool: "push_subscribe" }, { endpoint: `https://push.example.net/send/device-${n}`, ...(await browserKeys()) });
}

type Call = { url: string; method: string; headers: Record<string, string>; body: Uint8Array; redirect?: string; signal: unknown };

function mockFetch(t: { mock: { method: typeof import("node:test").mock.method } }, statusFor: (url: string) => number | "throw" = () => 201) {
  const calls: Call[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: new Uint8Array(init.body as ArrayBuffer),
      redirect: init.redirect,
      signal: init.signal,
    });
    const status = statusFor(url);
    if (status === "throw") throw new TypeError("network down");
    return new Response(null, { status });
  });
  return calls;
}

const envFor = (db: Db, extra: Partial<Env> = {}) => ({ DB: db, ...extra }) as unknown as Env;

test("without all three keys nothing is sent and the result says so", async (t) => {
  const calls = mockFetch(t);
  const db = await openTestDb();
  await subscribe(db, 1);
  const secrets = await fakeSecrets();
  assert.deepEqual(await sendBriefPush(db, envFor(db), NOW), { sent: 0, gone: 0, failed: 0, skipped: "no_keys" });
  assert.deepEqual(await sendBriefPush(db, envFor(db, { ...secrets, VAPID_SUBJECT: undefined }), NOW), {
    sent: 0,
    gone: 0,
    failed: 0,
    skipped: "no_keys",
  });
  assert.equal(calls.length, 0);
});

test("a test push to two subscriptions: one encrypted POST each, with VAPID, TTL, Urgency and aes128gcm", async (t) => {
  const calls = mockFetch(t);
  const db = await openTestDb();
  await subscribe(db, 1);
  await subscribe(db, 2);
  const secrets = await fakeSecrets();
  assert.deepEqual(await sendBriefPush(db, envFor(db, secrets), NOW), { sent: 2, gone: 0, failed: 0 });
  assert.deepEqual(calls.map((c) => c.url).toSorted(), ["https://push.example.net/send/device-1", "https://push.example.net/send/device-2"]);
  for (const call of calls) {
    assert.equal(call.method, "POST");
    assert.equal(call.redirect, "manual", "a redirect is never followed");
    assert.ok(call.signal instanceof AbortSignal, "each push has a timeout");
    assert.equal(call.headers.ttl, "86400");
    assert.equal(call.headers.urgency, "normal");
    assert.equal(call.headers["content-encoding"], "aes128gcm");
    assert.equal(call.headers["content-type"], "application/octet-stream");
    assert.match(call.headers.authorization ?? "", new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${secrets.VAPID_PUBLIC_KEY}$`));
    // 86-byte header, the payload plus its delimiter, and the 16-byte tag: nothing else rides along.
    assert.equal(call.body.length, 86 + new TextEncoder().encode(BRIEF_PAYLOAD).length + 1 + 16);
  }
  assert.equal(BRIEF_PAYLOAD, '{"kind":"brief"}');
});

test("404 and 410 mark the subscription gone in a system change; other failures are counted and kept", async (t) => {
  const statuses: Record<string, number | "throw"> = {
    "https://push.example.net/send/device-1": 410,
    "https://push.example.net/send/device-2": 404,
    "https://push.example.net/send/device-3": 500,
    "https://push.example.net/send/device-4": "throw",
    "https://push.example.net/send/device-5": 201,
    "https://push.example.net/send/device-6": 302,
  };
  const calls = mockFetch(t, (url) => statuses[url] ?? 201);
  const logs: string[] = [];
  t.mock.method(console, "log", (line: string) => logs.push(line));
  t.mock.method(console, "error", (line: string) => logs.push(line));
  const db = await openTestDb();
  for (const n of [1, 2, 3, 4, 5, 6]) await subscribe(db, n);
  assert.deepEqual(await sendBriefPush(db, envFor(db, await fakeSecrets()), NOW), { sent: 1, gone: 2, failed: 3 }, "a 302 is a failure");
  assert.equal(calls.length, 6);

  const live = (await db.prepare("SELECT endpoint FROM push_subscriptions WHERE gone_at IS NULL ORDER BY endpoint").all<PushSubscriptionRow>()).results;
  assert.deepEqual(live.map((r) => r.endpoint.slice(-8)), ["device-3", "device-4", "device-5", "device-6"]);
  const gone = (await db.prepare("SELECT * FROM audit_log WHERE tool = 'push_send' ORDER BY id").all<AuditRow>()).results;
  assert.equal(gone.length, 2);
  for (const row of gone) {
    assert.equal(row.actor, "system");
    assert.doesNotMatch(row.summary, /example\.net/);
  }
  assert.doesNotMatch(logs.join("\n"), /example\.net/, "no endpoint in any log line");

  // The next send skips the gone ones.
  const again = mockFetch(t);
  await sendBriefPush(db, envFor(db, await fakeSecrets()), NOW);
  assert.equal(again.length, 4);
});

test("a database failure while marking a device gone keeps the counts and leaves the device on", async (t) => {
  mockFetch(t, (url) => (url.endsWith("device-1") ? 410 : 201));
  const logs: string[] = [];
  t.mock.method(console, "error", (line: string) => logs.push(line));
  const db = await openTestDb();
  await subscribe(db, 1);
  await subscribe(db, 2);
  const failing: Db = {
    prepare: (sql) => db.prepare(sql),
    batch: () => Promise.reject(new Error("D1 is down")),
  };
  assert.deepEqual(await sendBriefPush(failing, envFor(failing, await fakeSecrets()), NOW), { sent: 1, gone: 1, failed: 0 });
  const live = (await db.prepare("SELECT id FROM push_subscriptions WHERE gone_at IS NULL").all()).results;
  assert.equal(live.length, 2, "nothing was written, so the device is tried again next time");
  assert.doesNotMatch(logs.join("\n"), /example\.net|D1 is down/, "no endpoint and no raw error in the log");
  assert.equal(logs.length, 1);
});

test("a timeout that has already fired by the time the push is made counts the device as failed, without hanging", async (t) => {
  t.mock.method(globalThis, "fetch", (_url: string, init: RequestInit) => {
    const signal = init.signal;
    if (!signal) return Promise.reject(new Error("no timeout signal"));
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const db = await openTestDb();
  await subscribe(db, 1);
  const aborted = () => AbortSignal.abort(new DOMException("The push timed out.", "TimeoutError"));
  assert.deepEqual(await sendBriefPush(db, envFor(db, await fakeSecrets()), NOW, { timeoutSignal: aborted }), { sent: 0, gone: 0, failed: 1 });
});

test("with no subscriptions nothing is sent", async (t) => {
  const calls = mockFetch(t);
  const db = await openTestDb();
  assert.deepEqual(await sendBriefPush(db, envFor(db, await fakeSecrets()), NOW), { sent: 0, gone: 0, failed: 0 });
  assert.equal(calls.length, 0);
});
