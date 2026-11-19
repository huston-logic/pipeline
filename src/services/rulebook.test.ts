import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditRow, Db } from "../db/db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import type { Ctx } from "./change.ts";
import { UserError } from "./errors.ts";
import { getRulebook, updateRulebook } from "./rulebook.ts";
import { undoChange } from "./undo.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const LATER = new Date("2026-11-19T19:00:00.000Z");
const ctxFor = (db: Db, tool = "update_rulebook", now = NOW): Ctx => ({ db, now, actor: "ai", tool });

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => assert.fail("expected a refusal"),
    (e: unknown) => e,
  );
  assert.ok(error instanceof UserError, `expected a UserError, got ${String(error)}`);
  return error.message;
}

test("updateRulebook replaces one document, bumps its version and logs one audited change", async () => {
  const db = await openTestDb();
  const result = await updateRulebook(ctxFor(db), "voice", "# Voice\n\nWarm and brief.");

  assert.equal(result.summary, `Updated rulebook document "voice" (change ${result.changeId})`);
  const [voice] = await getRulebook(db, "voice");
  assert.equal(voice?.markdown, "# Voice\n\nWarm and brief.");
  assert.equal(voice?.version, 2);
  assert.equal(voice?.updated_at, NOW.toISOString());
  assert.equal((await getRulebook(db)).length, 3, "the other documents are untouched");
  const audit = await db.prepare("SELECT * FROM audit_log").first<AuditRow>();
  assert.equal(audit?.tool, "update_rulebook");
  assert.equal(audit?.target_table, "rulebook");
  assert.equal(audit?.target_id, "voice");
});

test("a new name creates a document; the name is normalized to lower case", async () => {
  const db = await openTestDb();
  const result = await updateRulebook(ctxFor(db), " Pricing-Notes ", "Quote from the price sheet only.");
  assert.equal(result.summary, `Added rulebook document "pricing-notes" (change ${result.changeId})`);
  const [doc] = await getRulebook(db, "pricing-notes");
  assert.equal(doc?.version, 1);
  assert.deepEqual((await getRulebook(db)).map((d) => d.name), ["voice", "pipeline", "guardrails", "pricing-notes"]);
});

test("updateRulebook checks the name and the text, and refuses a no-op", async () => {
  const db = await openTestDb();
  assert.match(await refusal(updateRulebook(ctxFor(db), "my voice!", "x")), /name.*letters, numbers, "-" and "_"/);
  assert.match(await refusal(updateRulebook(ctxFor(db), "", "x")), /needs a name/);
  assert.match(await refusal(updateRulebook(ctxFor(db), "a".repeat(41), "x")), /at most 40 characters/);
  assert.match(await refusal(updateRulebook(ctxFor(db), "voice", "   ")), /can't be blank/);
  assert.match(await refusal(updateRulebook(ctxFor(db), "voice", "x".repeat(20_001))), /at most 20,000 characters \(got 20001\)/);
  await updateRulebook(ctxFor(db), "voice", "x".repeat(20_000));
  assert.match(await refusal(updateRulebook(ctxFor(db), "voice", "x".repeat(20_000))), /Nothing to change/);
});

test("updating and adding a document are each undoable", async () => {
  const db = await openTestDb();
  const [before] = await getRulebook(db, "voice");

  const updated = await updateRulebook(ctxFor(db), "voice", "New voice.");
  const undoneUpdate = await undoChange(ctxFor(db, "undo_change", LATER), updated.changeId);
  assert.match(undoneUpdate.summary, /^Undid chg_[a-z2-7]{12}: Put back the earlier markdown on rulebook "voice"/);
  assert.equal((await getRulebook(db, "voice"))[0]?.markdown, before?.markdown);

  const added = await updateRulebook(ctxFor(db), "extra", "More.");
  const undoneAdd = await undoChange(ctxFor(db, "undo_change", LATER), added.changeId);
  assert.match(undoneAdd.summary, /^Undid chg_[a-z2-7]{12}: Removed rulebook "extra"/);
  assert.deepEqual(await getRulebook(db, "extra"), []);
});
