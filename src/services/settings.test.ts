import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db } from "../db/db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import type { Ctx } from "./change.ts";
import { UserError } from "./errors.ts";
import { getAiEdits, getSettings, updateSettings } from "./settings.ts";
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
    businessName: null,
    accentColor: null,
    aiEdits: "review_first",
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
    businessName: null,
    accentColor: null,
    aiEdits: "review_first",
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

test("business name: trimmed, at most 60 characters, one line; null or blank clears it", async () => {
  const db = await openTestDb();
  const named = await updateSettings(ctxFor(db), { businessName: "  Fernwood Engineering  " });
  assert.equal(named.summary, `Updated settings: business name to "Fernwood Engineering" (change ${named.changeId})`);
  assert.equal((await getSettings(db)).businessName, "Fernwood Engineering");

  assert.equal(
    await refusal(updateSettings(ctxFor(db), { businessName: "x".repeat(61) })),
    "A business name can be at most 60 characters (this one has 61). Give a shorter name.",
  );
  const invisible = {
    "a line feed (C0 control)": "Fernwood\nEngineering",
    "a tab (C0 control)": "Fernwood\tEngineering",
    "a next-line character (C1 control)": "Fernwood\u0085Engineering",
    "a right-to-left override (format character)": "Fernwood‮Engineering",
    "a zero-width joiner (format character)": "Fernwood‍Engineering",
    "a line separator": "Fernwood Engineering",
    "a paragraph separator": "Fernwood Engineering",
  };
  for (const [what, name] of Object.entries(invisible)) {
    assert.equal(
      await refusal(updateSettings(ctxFor(db), { businessName: name })),
      "A business name must be one line of plain text, without line breaks, tabs or invisible formatting characters.",
      what,
    );
  }
  assert.equal((await getSettings(db)).businessName, "Fernwood Engineering");

  const cleared = await updateSettings(ctxFor(db), { businessName: null });
  assert.match(cleared.summary, /^Updated settings: business name cleared \(change /);
  assert.equal((await getSettings(db)).businessName, null);
  await updateSettings(ctxFor(db), { businessName: "Fernwood" });
  await updateSettings(ctxFor(db), { businessName: "   " });
  assert.equal((await getSettings(db)).businessName, null, "blank clears it too");
});

test("accent colour: #rrggbb stored in lower case, refused when too light, null clears it", async () => {
  const db = await openTestDb();
  const set = await updateSettings(ctxFor(db), { accentColor: "#1E4A3D" });
  assert.equal(set.summary, `Updated settings: accent colour to #1e4a3d (change ${set.changeId})`);
  assert.equal((await getSettings(db)).accentColor, "#1e4a3d");

  assert.equal(
    await refusal(updateSettings(ctxFor(db), { accentColor: "teal" })),
    "That isn't a colour I can use: give it as #rrggbb, for example #2b6455.",
  );
  assert.match(await refusal(updateSettings(ctxFor(db), { accentColor: "#88c0a0" })), /too light .* Pick a darker colour\.$/);
  assert.equal((await getSettings(db)).accentColor, "#1e4a3d");

  const cleared = await updateSettings(ctxFor(db), { accentColor: null });
  assert.match(cleared.summary, /^Updated settings: accent colour cleared \(change /);
  assert.equal((await getSettings(db)).accentColor, null);
  assert.match(await refusal(updateSettings(ctxFor(db), { accentColor: null })), /Nothing to change/);
});

test("a business name and accent colour change is one change, and undo puts both back", async () => {
  const db = await openTestDb();
  await updateSettings(ctxFor(db), { businessName: "Fernwood" });
  const changed = await updateSettings(ctxFor(db), { businessName: "Fernwood Engineering", accentColor: "#1e4a3d" });
  assert.match(changed.summary, /^Updated settings: business name to "Fernwood Engineering" and accent colour to #1e4a3d \(change /);
  const undone = await undoChange(ctxFor(db, "undo_change", LATER), changed.changeId);
  assert.match(undone.summary, /^Undid chg_[a-z2-7]{12}: Put back the earlier business name and accent colour on the settings/);
  const after = await getSettings(db);
  assert.equal(after.businessName, "Fernwood");
  assert.equal(after.accentColor, null);
});

test("AI edits: review_first by default, apply_small stored as small, the summary names it, undo puts it back (decision 0045)", async () => {
  const db = await openTestDb();
  assert.equal(await getAiEdits(db), "review");
  const changed = await updateSettings(ctxFor(db), { aiEdits: "apply_small" });
  assert.match(changed.summary, /^Updated settings: AI edits: Apply small changes \(change /);
  assert.equal(await getAiEdits(db), "small");
  assert.equal((await getSettings(db)).aiEdits, "apply_small");
  assert.match(await refusal(updateSettings(ctxFor(db), { aiEdits: "apply_small" })), /Nothing to change/);
  const back = await updateSettings(ctxFor(db), { aiEdits: "review_first", briefHour: 9 });
  assert.match(back.summary, /^Updated settings: brief hour to 9:00 and AI edits: Review first \(change /);
  const undone = await undoChange(ctxFor(db, "undo_change", LATER), back.changeId);
  assert.match(undone.summary, /^Undid chg_[a-z2-7]{12}: Put back the earlier brief hour and AI edits on the settings/);
  assert.equal(await getAiEdits(db), "small");
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
