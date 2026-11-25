// The owner's one way to lift a campaign block: an unsubscribe, on the person's page (decision 0053).
import assert from "node:assert/strict";
import { test } from "node:test";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { EmailSuppressionRow } from "../db/db.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import { UserError } from "../services/errors.ts";
import { undoChange } from "../services/undo.ts";
import { suppressionOf } from "./audience.ts";
import { clearSuppression } from "./suppressions.ts";

const NOW = new Date("2026-11-24T18:00:00.000Z");
const owner = (db: SqliteD1, tool = "clear_suppression") => ({ db, now: NOW, actor: "owner" as const, tool });

async function people(): Promise<SqliteD1> {
  const db = await timeDb(NOW);
  db.exec(`UPDATE settings SET campaigns = 1;
    INSERT INTO contacts (id, name, email, person_status) VALUES
      ('ct_u1', 'Una Example', 'una@example.com', 'partner'),
      ('ct_b1', 'Bo Example', 'bo@example.com', 'partner'),
      ('ct_c1', 'Cy Example', 'cy@example.com', 'partner'),
      ('ct_n1', 'Nia Example', 'nia@example.com', 'partner'),
      ('ct_m1', 'Moved Example', 'new-address@example.com', 'partner');
    INSERT INTO email_suppressions (id, email, reason, contact_id) VALUES
      ('su_u1', 'una@example.com', 'unsubscribed', 'ct_u1'),
      ('su_b1', 'bo@example.com', 'bounced', 'ct_b1'),
      ('su_c1', 'cy@example.com', 'complained', 'ct_c1'),
      ('su_m1', 'old-address@example.com', 'unsubscribed', 'ct_m1');`);
  return db;
}

const suppression = (db: SqliteD1, id: string) => db.prepare("SELECT * FROM email_suppressions WHERE id = ?").bind(id).first<EmailSuppressionRow>();

test("clearing an unsubscribe is one owner change that sets cleared_at and bumps the version", async () => {
  const db = await people();
  const result = await clearSuppression(owner(db), "ct_u1");
  const row = await suppression(db, "su_u1");
  assert.equal(row?.cleared_at, NOW.toISOString());
  assert.equal(row?.version, 2);
  const audit = await db.prepare("SELECT actor, tool, summary FROM audit_log WHERE id = ?").bind(result.changeId).first<{ actor: string; tool: string; summary: string }>();
  assert.deepEqual([audit?.actor, audit?.tool], ["owner", "clear_suppression"]);
  assert.match(audit?.summary ?? "", /^Allowed campaign emails again for contact ct_u1 \(change chg_/);
  assert.doesNotMatch(audit?.summary ?? "", /Una|una@/);
  assert.equal(await suppressionOf(db, { email: "una@example.com", contactId: "ct_u1" }), null);
});

test("an unsubscribe tied to the person clears after they changed address", async () => {
  const db = await people();
  await clearSuppression(owner(db), "ct_m1");
  assert.ok((await suppression(db, "su_m1"))?.cleared_at);
});

test("undo puts the unsubscribe back", async () => {
  const db = await people();
  const result = await clearSuppression(owner(db), "ct_u1");
  await undoChange({ db, now: NOW, actor: "owner", tool: "undo_change" }, result.changeId);
  const row = await suppression(db, "su_u1");
  assert.equal(row?.cleared_at, null);
  assert.equal((await suppressionOf(db, { email: "una@example.com", contactId: "ct_u1" }))?.reason, "unsubscribed");
});

test("a bounce, a complaint, or no block at all is refused and nothing changes", async () => {
  const db = await people();
  const before = (await db.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>())?.n;
  for (const id of ["ct_b1", "ct_c1", "ct_n1"]) {
    await assert.rejects(clearSuppression(owner(db), id), (error: unknown) => error instanceof UserError && /has no unsubscribe to clear\.$/.test(error.message), id);
  }
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>())?.n, before);
  assert.equal((await suppression(db, "su_b1"))?.cleared_at, null);
  assert.equal((await suppression(db, "su_c1"))?.cleared_at, null);
});

test("an unknown person and campaigns being off are plain refusals", async () => {
  const db = await people();
  await assert.rejects(clearSuppression(owner(db), "ct_nobody"), UserError);
  db.exec("UPDATE settings SET campaigns = 0");
  await assert.rejects(clearSuppression(owner(db), "ct_u1"), /Campaigns are off/i);
});
