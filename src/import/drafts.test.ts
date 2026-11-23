import assert from "node:assert/strict";
import { test } from "node:test";
import { openTestDb } from "../db/sqlite-d1.ts";
import type { Db } from "../db/db.ts";
import { CHUNK_BYTES, sqlBytes } from "../services/bulk.ts";
import {
  appliedStatements,
  createDraft,
  deleteExpiredDrafts,
  DRAFT_LIFETIME_MS,
  draftGuard,
  draftText,
  getDraft,
  markApplied,
  saveMapping,
  splitText,
} from "./drafts.ts";

const NOW = new Date("2026-11-22T18:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const CSV = "name,email\r\nPat Example,pat@example.com\r\n";

const parts = async (db: Db, id: string) =>
  (await db.prepare("SELECT seq, text FROM import_draft_parts WHERE draft_id = ? ORDER BY seq").bind(id).all<{ seq: number; text: string }>()).results;

test("a draft is made, read back with its file, and gone once it expires", async () => {
  const db = await openTestDb();
  const id = await createDraft(db, { module: "people", text: CSV, mapping: [{ kind: "builtin", key: "name" }, { kind: "skip" }], asLeads: true, now: NOW });
  assert.match(id, /^im_[a-z2-7]{12}$/);
  const draft = await getDraft(db, id, at(1000));
  assert.deepEqual(draft, {
    id,
    module: "people",
    expiresAt: at(DRAFT_LIFETIME_MS).toISOString(),
    mapping: [{ kind: "builtin", key: "name" }, { kind: "skip" }],
    asLeads: true,
    result: null,
    changeId: null,
    version: 1,
  });
  assert.equal(DRAFT_LIFETIME_MS, 2 * 60 * 60 * 1000);
  assert.equal(await draftText(db, id), CSV);
  assert.equal(await getDraft(db, id, at(DRAFT_LIFETIME_MS)), null, "expired at its expiry time");
  assert.equal(await getDraft(db, "im_nothing00000", NOW), null);

  assert.equal(await deleteExpiredDrafts(db, at(DRAFT_LIFETIME_MS - 1)), 0);
  assert.equal(await deleteExpiredDrafts(db, at(DRAFT_LIFETIME_MS)), 1);
  assert.deepEqual(await parts(db, id), [], "its file goes with it");
});

test("the file is kept in parts of at most CHUNK_BYTES as SQL, never cutting a character in two", async () => {
  const text = `name,notes\r\n${Array.from({ length: 6_000 }, (_, i) => `O'Brien ${i} 🌱,"it's ''quoted'' 漢字 ${"é".repeat(i % 50)}"`).join("\r\n")}`;
  const pieces = splitText(text);
  assert.ok(pieces.length > 1);
  assert.equal(pieces.join(""), text);
  for (const piece of pieces) {
    assert.ok(sqlBytes(piece) <= CHUNK_BYTES, `a part measures ${sqlBytes(piece)}`);
    assert.ok(piece.isWellFormed(), "no lone surrogate at a cut");
  }
  assert.deepEqual(splitText(""), []);
  assert.deepEqual(splitText("🌱🌱🌱", 8), ["🌱🌱", "🌱"]);

  const db = await openTestDb();
  const id = await createDraft(db, { module: "people", text, mapping: [], asLeads: false, now: NOW });
  assert.deepEqual((await parts(db, id)).map((part) => part.text), pieces);
  assert.equal(await draftText(db, id), text);
});

test("a mapping is saved only on the version read, and only before the import is applied", async () => {
  const db = await openTestDb();
  const id = await createDraft(db, { module: "people", text: CSV, mapping: [], asLeads: false, now: NOW });
  const draft = await getDraft(db, id, NOW);
  assert.ok(draft);
  assert.equal(await saveMapping(db, draft, [{ kind: "builtin", key: "name" }, { kind: "notes", label: "Email" }], true), true);
  const saved = await getDraft(db, id, NOW);
  assert.deepEqual([saved?.mapping, saved?.asLeads, saved?.version], [[{ kind: "builtin", key: "name" }, { kind: "notes", label: "Email" }], true, 2]);
  assert.equal(await saveMapping(db, draft, [], false), false, "an older version is refused");

  assert.ok(saved);
  const result = { created: 1, filled: 0, unchanged: 0, skipped: 0, duplicates: 0, fields: 0, people: 0, closed: 0, archived: 0 };
  await db.batch([draftGuard(db, saved, NOW), ...appliedStatements(db, saved, result, "chg_draft0001")]);
  const applied = await getDraft(db, id, NOW);
  assert.deepEqual([applied?.result, applied?.changeId], [result, "chg_draft0001"]);
  assert.deepEqual(await parts(db, id), [], "the file is deleted the moment it is applied");
  await assert.rejects(
    db.batch([draftGuard(db, saved, NOW), ...appliedStatements(db, saved, result, "chg_draft0002")]),
    /CHECK constraint failed/,
    "a second apply fails its guard",
  );
  assert.equal(await saveMapping(db, applied as NonNullable<typeof applied>, [], false), false, "an applied draft keeps its mapping");
  assert.equal(await markApplied(db, applied as NonNullable<typeof applied>, result, NOW), false);
});

test("the apply guard and markApplied refuse a draft that has expired, even one read before it expired", async () => {
  const db = await openTestDb();
  const id = await createDraft(db, { module: "people", text: CSV, mapping: [], asLeads: false, now: NOW });
  const draft = await getDraft(db, id, NOW);
  assert.ok(draft);
  const late = at(DRAFT_LIFETIME_MS);
  await assert.rejects(db.batch([draftGuard(db, draft, late)]), /CHECK constraint failed/);
  const result = { created: 0, filled: 0, unchanged: 1, skipped: 0, duplicates: 0, fields: 0, people: 0, closed: 0, archived: 0 };
  assert.equal(await markApplied(db, draft, result, late), false);
  assert.equal(await markApplied(db, draft, result, NOW), true);
});

test("an import that writes nothing is marked applied once, without a change", async () => {
  const db = await openTestDb();
  const id = await createDraft(db, { module: "people", text: CSV, mapping: [], asLeads: false, now: NOW });
  const draft = await getDraft(db, id, NOW);
  assert.ok(draft);
  const result = { created: 0, filled: 0, unchanged: 1, skipped: 0, duplicates: 0, fields: 0, people: 0, closed: 0, archived: 0 };
  assert.equal(await markApplied(db, draft, result, NOW), true);
  assert.equal(await markApplied(db, draft, result, NOW), false);
  const applied = await getDraft(db, id, NOW);
  assert.deepEqual([applied?.result, applied?.changeId], [result, null]);
  assert.deepEqual(await parts(db, id), []);
});

test("a stored mapping that isn't a list of targets reads as no mapping", async () => {
  const db = await openTestDb();
  const id = await createDraft(db, { module: "people", text: CSV, mapping: [], asLeads: false, now: NOW });
  await db.prepare(`UPDATE import_drafts SET mapping = '[{"kind":"builtin"},{"kind":"evil","key":1}]' WHERE id = ?`).bind(id).run();
  assert.deepEqual((await getDraft(db, id, NOW))?.mapping, []);
});

test("drafts never write a log line, whatever the file holds", async (t) => {
  const lines: unknown[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) t.mock.method(console, method, (...args: unknown[]) => lines.push(args));
  const db = await openTestDb();
  const id = await createDraft(db, { module: "people", text: "name\r\nSecret Person\r\n", mapping: [], asLeads: false, now: NOW });
  const draft = await getDraft(db, id, NOW);
  await draftText(db, id);
  if (draft) await saveMapping(db, draft, [], false);
  await deleteExpiredDrafts(db, at(DRAFT_LIFETIME_MS));
  assert.deepEqual(lines, []);
});
