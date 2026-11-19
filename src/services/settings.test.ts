import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db } from "../db/db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import type { Ctx } from "./change.ts";
import { UserError } from "./errors.ts";
import { getSettings, updateSettings } from "./settings.ts";
import { undoChange } from "./undo.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const LATER = new Date("2026-11-19T19:00:00.000Z");
const ctxFor = (db: Db, tool = "update_settings", now = NOW): Ctx => ({ db, now, actor: "ai", tool });

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => assert.fail("expected a refusal"),
    (e: unknown) => e,
  );
  assert.ok(error instanceof UserError, `expected a UserError, got ${String(error)}`);
  return error.message;
}

test("getSettings shows the settings with the owner emails as a list", async () => {
  const db = await openTestDb();
  await db.prepare("UPDATE settings SET owner_emails = ? WHERE id = 1").bind('["owner@example.com"]').run();
  assert.deepEqual(await getSettings(db), {
    timezone: "America/Los_Angeles",
    briefHour: 7,
    briefEmail: null,
    briefEnabled: false,
    ownerEmails: ["owner@example.com"],
    lastBriefAt: null,
    lastBriefSentAt: null,
  });
});

test("updateSettings changes only what is given, in one audited change", async () => {
  const db = await openTestDb();
  await db.prepare("UPDATE settings SET owner_emails = ? WHERE id = 1").bind('["me@example.com"]').run();
  const result = await updateSettings(ctxFor(db), {
    timezone: "Europe/London",
    briefHour: 8,
    briefEmail: " me@example.com ",
    briefEnabled: true,
  });

  assert.equal(
    result.summary,
    `Updated settings: timezone to Europe/London, brief hour to 8:00, brief email to me@example.com and the daily brief on (change ${result.changeId})`,
  );
  assert.deepEqual(await getSettings(db), {
    timezone: "Europe/London",
    briefHour: 8,
    briefEmail: "me@example.com",
    briefEnabled: true,
    ownerEmails: ["me@example.com"],
    lastBriefAt: null,
    lastBriefSentAt: null,
  });
  const row = await db.prepare("SELECT version, updated_at FROM settings").first<{ version: number; updated_at: string }>();
  assert.deepEqual(row, { version: 2, updated_at: NOW.toISOString() });
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>())?.n, 1);

  const cleared = await updateSettings(ctxFor(db), { briefEmail: null, briefEnabled: false });
  assert.match(cleared.summary, /^Updated settings: brief email cleared and the daily brief off \(change /);
});

test("updateSettings checks the timezone, the hour and the email, and refuses a no-op", async () => {
  const db = await openTestDb();
  assert.match(await refusal(updateSettings(ctxFor(db), { timezone: "Pacific Time" })), /^"Pacific Time" isn't a timezone I know\. Use an IANA name such as America\/Los_Angeles or Europe\/London\.$/);
  assert.match(await refusal(updateSettings(ctxFor(db), { briefHour: 24 })), /between 0 and 23/);
  assert.match(await refusal(updateSettings(ctxFor(db), { briefHour: 7.5 })), /between 0 and 23/);
  assert.match(await refusal(updateSettings(ctxFor(db), { briefEmail: "nope" })), /doesn't look like an email address/);
  assert.match(await refusal(updateSettings(ctxFor(db), {})), /Nothing to change/);
  assert.match(await refusal(updateSettings(ctxFor(db), { timezone: "America/Los_Angeles", briefHour: 7 })), /Nothing to change/);
  assert.equal((await getSettings(db)).timezone, "America/Los_Angeles");
});

test("a timezone is stored in its canonical spelling", async () => {
  const db = await openTestDb();
  await updateSettings(ctxFor(db), { timezone: "europe/paris" });
  assert.equal((await getSettings(db)).timezone, "Europe/Paris");
});

test("the settings patch has no way to change the owner emails", async () => {
  const db = await openTestDb();
  // @ts-expect-error ownerEmails is deliberately not part of SettingsPatch (decision 0005).
  const result = await updateSettings(ctxFor(db), { ownerEmails: ["intruder@example.com"], briefHour: 9 });
  assert.match(result.summary, /^Updated settings: brief hour to 9:00/);
  assert.deepEqual((await getSettings(db)).ownerEmails, []);
});

test("a settings change is undoable", async () => {
  const db = await openTestDb();
  const changed = await updateSettings(ctxFor(db), { timezone: "Europe/London", briefHour: 9 });
  const undone = await undoChange(ctxFor(db, "undo_change", LATER), changed.changeId);
  assert.match(undone.summary, /^Undid chg_[a-z2-7]{12}: Put back the earlier timezone and brief hour on the settings/);
  assert.equal((await getSettings(db)).timezone, "America/Los_Angeles");
  assert.equal((await getSettings(db)).briefHour, 7);
});

test("the brief email must be one of the owner emails, in the settings or the OWNER_EMAILS var, ignoring case", async () => {
  const db = await openTestDb();
  await db.prepare("UPDATE settings SET owner_emails = ? WHERE id = 1").bind('["Owner@Example.com"]').run();
  assert.equal(
    await refusal(updateSettings(ctxFor(db), { briefEmail: "someone@example.test" })),
    "The brief can only go to an owner email (owner@example.com), and someone@example.test isn't one. Use an owner " +
      "email, or null to clear it.",
  );
  assert.equal((await getSettings(db)).briefEmail, null);

  const ok = await updateSettings(ctxFor(db), { briefEmail: "owner@EXAMPLE.com" });
  assert.match(ok.summary, /brief email to owner@EXAMPLE\.com/);
  const fromVar = await updateSettings(ctxFor(db), { briefEmail: "second@example.com" }, { extraOwnerEmails: ["Second@example.com"] });
  assert.match(fromVar.summary, /brief email to second@example\.com/);
});

test("with no owner emails at all, a brief email is refused", async () => {
  const db = await openTestDb();
  assert.match(
    await refusal(updateSettings(ctxFor(db), { briefEmail: "me@example.com" })),
    /^The brief can only go to an owner email \(none are set yet\), and me@example\.com isn't one\./,
  );
});

test("getSettings takes the last brief times from the briefs log", async () => {
  const db = await openTestDb();
  const insert = "INSERT INTO briefs (id, local_date, composed_at, text, sent_at, send_status) VALUES (?, ?, ?, '', ?, ?)";
  await db.prepare(insert).bind("br_a", "2026-11-17", "2026-11-17T15:00:00.000Z", "2026-11-17T15:00:01.000Z", "sent").run();
  await db.prepare(insert).bind("br_b", "2026-11-18", "2026-11-18T15:00:00.000Z", null, "off: brief_enabled is off").run();
  const settings = await getSettings(db);
  assert.equal(settings.lastBriefAt, "2026-11-18T15:00:00.000Z", "the latest brief composed");
  assert.equal(settings.lastBriefSentAt, "2026-11-17T15:00:01.000Z", "the latest brief emailed");
});
