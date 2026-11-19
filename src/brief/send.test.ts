import assert from "node:assert/strict";
import { test } from "node:test";
import type { SettingsRow } from "../db/db.ts";
import type { Env } from "../env.ts";
import { sendBlocker, sendBrief } from "./send.ts";

const brief = { subject: "Pipeline brief for Thursday Nov 19", text: "Pipeline brief for Thursday Nov 19\n\nNothing due today." };
const settings = { brief_enabled: 1, brief_email: "owner@example.test", owner_emails: '["Owner@Example.test"]' } as SettingsRow;
const ready = { BRIEF_SENDING: "on", RESEND_API_KEY: "re_fake_key", BRIEF_FROM: "brief@example.test" } as Env;

type Call = { url: string; init: RequestInit };

function mockFetch(t: { mock: { method: typeof import("node:test").mock.method } }, respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  });
  return calls;
}

test("sending posts plain text to Resend only when every switch is on", async (t) => {
  const calls = mockFetch(t, () => new Response('{"id":"x"}', { status: 200 }));
  assert.deepEqual(await sendBrief(ready, brief, settings), { sent: true });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call?.url, "https://api.resend.com/emails");
  assert.equal(call?.init.method, "POST");
  const headers = call?.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer re_fake_key");
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(String(call?.init.body)), {
    from: "brief@example.test",
    to: ["owner@example.test"],
    subject: brief.subject,
    text: brief.text,
  });
});

test("each missing switch keeps sending off and says which, without calling the network", async (t) => {
  const calls = mockFetch(t, () => new Response("{}", { status: 200 }));
  const cases: [Env, SettingsRow, string][] = [
    [ready, { ...settings, brief_enabled: 0 }, "off: brief_enabled is off"],
    [{ ...ready, BRIEF_SENDING: undefined }, settings, "off: BRIEF_SENDING is not on"],
    [{ ...ready, BRIEF_SENDING: "yes" }, settings, "off: BRIEF_SENDING is not on"],
    [{ ...ready, RESEND_API_KEY: undefined }, settings, "off: RESEND_API_KEY is not set"],
    [{ ...ready, BRIEF_FROM: "" }, settings, "off: BRIEF_FROM is not set"],
    [ready, { ...settings, brief_email: null }, "off: no brief_email is set in the settings"],
    [ready, { ...settings, brief_email: "someone@example.test" }, "off: brief address isn't an owner email"],
    [ready, { ...settings, owner_emails: "[]" }, "off: brief address isn't an owner email"],
  ];
  for (const [env, row, reason] of cases) {
    assert.equal(sendBlocker(env, row), reason);
    assert.deepEqual(await sendBrief(env, brief, row), { sent: false, reason });
  }
  assert.equal(sendBlocker(ready, settings), null);
  assert.equal(calls.length, 0);
});

test("a failed send records only the HTTP status, never the response body or the key", async (t) => {
  mockFetch(t, () => new Response('{"message":"bad key re_fake_key for owner@example.test"}', { status: 403 }));
  const result = await sendBrief(ready, brief, settings);
  assert.deepEqual(result, { sent: false, reason: "failed: 403" });
});

test("a network error is recorded without its message", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("connect ECONNREFUSED owner@example.test re_fake_key");
  });
  assert.deepEqual(await sendBrief(ready, brief, settings), { sent: false, reason: "failed: network error" });
});

test("the brief address is re-checked at send time: a non-owner address (say, put back by an undo) is never sent to", async (t) => {
  const calls = mockFetch(t, () => new Response("{}", { status: 200 }));
  const restored = { ...settings, brief_email: "old-address@example.test" } as SettingsRow;
  assert.deepEqual(await sendBrief(ready, brief, restored), { sent: false, reason: "off: brief address isn't an owner email" });
  assert.equal(calls.length, 0);

  const viaVar = { ...ready, OWNER_EMAILS: "other@example.test, OLD-address@example.test" } as Env;
  assert.equal(sendBlocker(viaVar, restored), null, "an owner email from the OWNER_EMAILS var counts too");
});
