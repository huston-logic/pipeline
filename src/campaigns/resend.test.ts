import assert from "node:assert/strict";
import { test } from "node:test";
import { type ResendEmail, sendBatch, sendOne } from "./resend.ts";

const email = (n: number): ResendEmail => ({
  from: "News <news@mail.example.com>",
  to: [`person${n}@example.com`],
  reply_to: "owner@example.com",
  subject: `Hello ${n}`,
  html: "<p>Hi</p>",
  text: "Hi",
  headers: { "List-Unsubscribe": `<https://board.example.com/unsubscribe/tok${n}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  tags: [{ name: "campaign", value: "cp_test01" }],
});

type Seen = { url: string; init: RequestInit };
function fakeFetch(respond: () => Response | Promise<Response>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const impl = (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(respond());
  };
  return { fetch: impl as typeof fetch, seen };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("sendBatch posts the array with the key, the user agent and a manual redirect", async () => {
  const { fetch, seen } = fakeFetch(() => json(200, { data: [{ id: "r1" }, { id: "r2" }] }));
  const emails = [email(1), email(2)];
  const out = await sendBatch("re_key", emails, "cb_one", fetch);
  assert.deepEqual(out, { kind: "sent", ids: ["r1", "r2"] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, "https://api.resend.com/emails/batch");
  const init = seen[0]?.init;
  assert.equal(init?.method, "POST");
  assert.deepEqual(init?.headers, {
    Authorization: "Bearer re_key",
    "Content-Type": "application/json",
    "Idempotency-Key": "cb_one",
    "User-Agent": "pipeline-engine",
  });
  assert.equal(init?.body, JSON.stringify(emails));
  assert.equal(init?.redirect, "manual");
  assert.ok(init?.signal instanceof AbortSignal);
});

test("a 2xx with the wrong shape or length is uncertain", async () => {
  for (const body of [{ data: [{ id: "r1" }] }, { data: "x" }, { data: [{ id: 1 }, { id: "r2" }] }, {}, null]) {
    const { fetch } = fakeFetch(() => json(200, body));
    assert.deepEqual(await sendBatch("k", [email(1), email(2)], "cb_one", fetch), { kind: "uncertain", status: "200" });
  }
  const { fetch } = fakeFetch(() => new Response("not json", { status: 200 }));
  assert.deepEqual(await sendBatch("k", [email(1)], "cb_one", fetch), { kind: "uncertain", status: "200" });
});

test("5xx and 3xx are retry_later", async () => {
  for (const status of [500, 502, 503, 301, 302, 307]) {
    const { fetch } = fakeFetch(() => new Response("", { status }));
    assert.deepEqual(await sendBatch("k", [email(1)], "cb_one", fetch), { kind: "retry_later", status: String(status) });
  }
});

test("a network error and a timeout are retry_later with fixed phrases", async () => {
  const boom = (async () => {
    throw new TypeError("connect to person1@example.com failed");
  }) as typeof fetch;
  assert.deepEqual(await sendBatch("k", [email(1)], "cb_one", boom), { kind: "retry_later", status: "network error" });
  const slow = (async () => {
    throw new DOMException("timed out", "TimeoutError");
  }) as typeof fetch;
  assert.deepEqual(await sendBatch("k", [email(1)], "cb_one", slow), { kind: "retry_later", status: "timeout" });
});

test("409 concurrent_idempotent_requests is retry_later; any other 409 is uncertain", async () => {
  const concurrent = fakeFetch(() => json(409, { name: "concurrent_idempotent_requests", message: "x" }));
  assert.deepEqual(await sendBatch("k", [email(1)], "cb_one", concurrent.fetch), { kind: "retry_later", status: "409" });
  for (const body of [{ name: "invalid_idempotent_request" }, { name: "other" }, {}]) {
    const { fetch } = fakeFetch(() => json(409, body));
    assert.deepEqual(await sendBatch("k", [email(1)], "cb_one", fetch), { kind: "uncertain", status: "409" });
  }
  const { fetch } = fakeFetch(() => new Response("nope", { status: 409 }));
  assert.deepEqual(await sendBatch("k", [email(1)], "cb_one", fetch), { kind: "uncertain", status: "409" });
});

test("429 returns the batch without pausing; 400, 401, 403, 404 and 422 return it and pause", async () => {
  const limited = fakeFetch(() => json(429, { name: "daily_quota_exceeded" }));
  assert.deepEqual(await sendBatch("k", [email(1)], "cb_one", limited.fetch), { kind: "returned", status: "429", pause: false });
  for (const status of [400, 401, 403, 404, 422]) {
    const { fetch } = fakeFetch(() => json(status, { name: "validation_error" }));
    assert.deepEqual(await sendBatch("k", [email(1)], "cb_one", fetch), { kind: "returned", status: String(status), pause: true });
  }
});

test("any other status is uncertain, never a retry that could send twice", async () => {
  for (const status of [201, 402, 410]) {
    const { fetch } = fakeFetch(() => new Response("", { status }));
    assert.deepEqual(await sendBatch("k", [email(1)], "cb_one", fetch), { kind: "uncertain", status: String(status) });
  }
});

test("sendOne posts one email to /emails and answers with one id", async () => {
  const { fetch, seen } = fakeFetch(() => json(200, { id: "r9" }));
  const one = email(1);
  assert.deepEqual(await sendOne("re_key", one, "cb_two", fetch), { kind: "sent", ids: ["r9"] });
  assert.equal(seen[0]?.url, "https://api.resend.com/emails");
  assert.equal(seen[0]?.init.body, JSON.stringify(one));
  assert.equal((seen[0]?.init.headers as Record<string, string>)["Idempotency-Key"], "cb_two");
  const bad = fakeFetch(() => json(200, { id: 5 }));
  assert.deepEqual(await sendOne("k", one, "cb_two", bad.fetch), { kind: "uncertain", status: "200" });
});
