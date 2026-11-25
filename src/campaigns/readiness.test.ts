import assert from "node:assert/strict";
import { test } from "node:test";
import type { SettingsRow } from "../db/db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import type { Env } from "../env.ts";
import { getSettings as getSettingsRow } from "../db/queries.ts";
import { replyTo, sendingBlocker } from "./readiness.ts";

const READY_ENV = {
  CAMPAIGN_SENDING: "on",
  CAMPAIGN_RESEND_API_KEY: "re_test_key",
  CAMPAIGN_FROM: "Example Co <hello@example.com>",
  OWNER_EMAILS: "owner@example.com",
} as unknown as Env;

async function readySettings(): Promise<SettingsRow> {
  const row = await getSettingsRow(await openTestDb());
  return { ...row, postal_address: "12 Example Road", owner_emails: '["me@example.com"]' };
}

const withEnv = (extra: Record<string, string | undefined>): Env => ({ ...READY_ENV, ...extra }) as Env;

test("a fully set up copy has no blocker", async () => {
  assert.equal(sendingBlocker(READY_ENV, await readySettings()), null);
});

test("each missing piece gives its sentence, in order", async () => {
  const settings = await readySettings();
  const bare = {} as unknown as Env;
  assert.equal(
    sendingBlocker(bare, { ...settings, postal_address: null }),
    "Add your business's postal address on Campaign settings. Every campaign email shows it.",
  );
  assert.equal(
    sendingBlocker(withEnv({ CAMPAIGN_SENDING: undefined }), settings),
    "Sending isn't set up for this copy yet: it needs its sending switch. Whoever installed this app sets it.",
  );
  assert.equal(
    sendingBlocker(withEnv({ CAMPAIGN_SENDING: "off" }), settings),
    "Sending isn't set up for this copy yet: it needs its sending switch. Whoever installed this app sets it.",
  );
  assert.equal(
    sendingBlocker(withEnv({ CAMPAIGN_RESEND_API_KEY: undefined }), settings),
    "Sending isn't set up for this copy yet: it needs its Resend key. Whoever installed this app sets it.",
  );
  assert.equal(
    sendingBlocker(withEnv({ CAMPAIGN_FROM: undefined }), settings),
    "Sending isn't set up for this copy yet: it needs its from address. Whoever installed this app sets it.",
  );
  assert.equal(
    sendingBlocker({ ...READY_ENV, OWNER_EMAILS: undefined } as Env, { ...settings, owner_emails: "[]" }),
    "Add an owner email to the settings so replies reach you.",
  );
});

test("a malformed CAMPAIGN_FROM blocks; a plain address and Name <address> pass", async () => {
  const settings = await readySettings();
  const bad = [
    "not an address",
    "Example <hello@example.com",
    'Ex"ample <hello@example.com>',
    "Example <hello@example.com>\r\nBcc: x@example.com",
    "hello@example.com\n",
    "<hello@example.com>",
    "Ex<a> <hello@example.com>",
  ];
  for (const from of bad) {
    assert.match(sendingBlocker(withEnv({ CAMPAIGN_FROM: from }), settings) ?? "", /its from address/, from);
  }
  assert.equal(sendingBlocker(withEnv({ CAMPAIGN_FROM: "hello@example.com" }), settings), null);
});

test("replyTo is the first stored owner email, else the first OWNER_EMAILS one, else null", async () => {
  const settings = await readySettings();
  assert.equal(replyTo(READY_ENV, { ...settings, owner_emails: '["a@example.com","b@example.com"]' }), "a@example.com");
  assert.equal(replyTo(withEnv({ OWNER_EMAILS: "X@Example.com, y@example.com" }), { ...settings, owner_emails: "[]" }), "x@example.com");
  assert.equal(replyTo(withEnv({ OWNER_EMAILS: undefined }), { ...settings, owner_emails: "[]" }), null);
});
