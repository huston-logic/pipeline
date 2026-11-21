import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditRow, ContactRow, Db, RulebookRow, SettingsRow, StageRow } from "../db/db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import {
  commitChange,
  type Ctx,
  isDuplicateEmailFailure,
  isForeignKeyFailure,
  isGuardFailure,
  type RowChange,
  StaleWriteError,
  updatedRow,
} from "./change.ts";
import { UserError } from "./errors.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const CHANGE_SUFFIX = / \(change chg_[a-z2-7]{12}\)$/;

const ctxFor = (db: Db): Ctx => ({ db, now: NOW, actor: "ai", tool: "test_tool" });

function contactRow(id: string, name: string): ContactRow {
  return {
    id,
    name,
    email: null,
    phone: null,
    business: null,
    source: null,
    notes: null,
    fields: "{}",
    untrusted_fields: "[]",
    archived: 0,
    version: 1,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    lead_status: null,
    lead_status_at: null,
  };
}

const count = async (db: Db, table: string) =>
  (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? -1;

const audits = async (db: Db) => (await db.prepare("SELECT * FROM audit_log ORDER BY rowid").all<AuditRow>()).results;

test("a commit writes its rows and exactly one audit row, and the summary ends with the change id", async () => {
  const db = await openTestDb();
  const row = contactRow("ct_test00000001", "Pat Example");
  const result = await commitChange(ctxFor(db), {
    target: { table: "contacts", id: row.id },
    summary: "Added contact Pat Example",
    changes: [{ table: "contacts", id: row.id, before: null, after: row }],
  });

  assert.match(result.summary, CHANGE_SUFFIX);
  assert.equal(result.summary, `Added contact Pat Example (change ${result.changeId})`);
  assert.deepEqual(await db.prepare("SELECT * FROM contacts").first(), row);

  const [audit, ...rest] = await audits(db);
  assert.equal(rest.length, 0);
  assert.ok(audit);
  assert.equal(audit.id, result.changeId);
  assert.equal(audit.at, NOW.toISOString());
  assert.equal(audit.actor, "ai");
  assert.equal(audit.tool, "test_tool");
  assert.equal(audit.target_table, "contacts");
  assert.equal(audit.target_id, row.id);
  assert.deepEqual(JSON.parse(audit.before_json), { [`contacts:${row.id}`]: null });
  assert.deepEqual(JSON.parse(audit.after_json), { [`contacts:${row.id}`]: row });
  assert.equal(audit.summary, result.summary);
  assert.equal(audit.undo_of, null);
  assert.equal(await count(db, "write_guard"), 0);
});

test("a failing statement leaves no rows and no audit row", async () => {
  const db = await openTestDb();
  const contact = contactRow("ct_test00000002", "Robin Sample");
  const badDeal = {
    id: "dl_test00000002",
    contact_id: contact.id,
    title: "Bakery site",
    stage_key: "no_such_stage",
    value: null,
    next_step: null,
    next_at: null,
    status: "open",
    fields: "{}",
    stage_entered_at: NOW.toISOString(),
    last_activity_at: null,
    archived: 0,
    version: 1,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
  await assert.rejects(
    commitChange(ctxFor(db), {
      target: { table: "deals", id: badDeal.id },
      summary: "Added a lead",
      changes: [
        { table: "contacts", id: contact.id, before: null, after: contact },
        { table: "deals", id: badDeal.id, before: null, after: badDeal },
      ],
    }),
    /FOREIGN KEY/,
  );
  assert.equal(await count(db, "contacts"), 0);
  assert.equal(await count(db, "deals"), 0);
  assert.equal(await count(db, "audit_log"), 0);
});

test("an update is guarded by version: a stale write is a plain UserError and changes nothing", async () => {
  const db = await openTestDb();
  const row = contactRow("ct_test00000003", "Casey Placeholder");
  await commitChange(ctxFor(db), {
    target: { table: "contacts", id: row.id },
    summary: "Added contact",
    changes: [{ table: "contacts", id: row.id, before: null, after: row }],
  });

  const fresh = updatedRow(row, { phone: "555-0103" }, NOW);
  assert.equal(fresh.version, 2);
  await commitChange(ctxFor(db), {
    target: { table: "contacts", id: row.id },
    summary: "Updated phone",
    changes: [{ table: "contacts", id: row.id, before: row, after: fresh }],
  });

  const stale = updatedRow(row, { phone: "555-0199" }, NOW);
  const error = await commitChange(ctxFor(db), {
    target: { table: "contacts", id: row.id },
    summary: "Updated phone again",
    changes: [{ table: "contacts", id: row.id, before: row, after: stale }],
  }).catch((e: unknown) => e);
  assert.ok(error instanceof StaleWriteError);
  assert.ok(error instanceof UserError);
  assert.equal(error.message, `Contact ${row.id} changed since you read it. Read it again and retry.`);
  assert.equal((await db.prepare("SELECT phone FROM contacts").first<{ phone: string }>())?.phone, "555-0103");
  assert.equal(await count(db, "audit_log"), 2);
  assert.equal(await count(db, "write_guard"), 0);
});

test("an update must bump the version", async () => {
  const db = await openTestDb();
  const row = contactRow("ct_test00000004", "Jordan Fake");
  await db.prepare("INSERT INTO contacts (id, name) VALUES (?, ?)").bind(row.id, row.name).run();
  const current = await db.prepare("SELECT * FROM contacts").first<ContactRow>();
  assert.ok(current);
  await assert.rejects(
    commitChange(ctxFor(db), {
      target: { table: "contacts", id: row.id },
      summary: "Bad update",
      changes: [{ table: "contacts", id: row.id, before: current, after: { ...current, phone: "1" } }],
    }),
    /version/,
  );
});

test("tables keyed by key, name and id = 1 update too", async () => {
  const db = await openTestDb();
  const stage = await db.prepare("SELECT * FROM stages WHERE key = 'replied'").first<StageRow>();
  const rulebook = await db.prepare("SELECT * FROM rulebook WHERE name = 'voice'").first<RulebookRow>();
  const settings = await db.prepare("SELECT * FROM settings").first<SettingsRow>();
  assert.ok(stage && rulebook && settings);
  const changes: RowChange[] = [
    { table: "stages", id: "replied", before: stage, after: updatedRow(stage, { label: "Wrote back" }, NOW) },
    { table: "rulebook", id: "voice", before: rulebook, after: updatedRow(rulebook, { markdown: "# Voice" }, NOW) },
    { table: "settings", id: "1", before: settings, after: updatedRow(settings, { brief_hour: 8 }, NOW) },
  ];
  await commitChange(ctxFor(db), { target: { table: "settings", id: "1" }, summary: "Several", changes });

  assert.equal((await db.prepare("SELECT label FROM stages WHERE key = 'replied'").first("label")), "Wrote back");
  assert.equal((await db.prepare("SELECT markdown FROM rulebook WHERE name = 'voice'").first("markdown")), "# Voice");
  assert.equal((await db.prepare("SELECT brief_hour FROM settings").first("brief_hour")), 8);
  assert.equal((await db.prepare("SELECT version FROM settings").first("version")), 2);
  const [audit] = await audits(db);
  assert.deepEqual(Object.keys(JSON.parse(audit?.after_json ?? "{}")), ["stages:replied", "rulebook:voice", "settings:1"]);
});

test("a delete removes the row, guarded by version", async () => {
  const db = await openTestDb();
  const row = contactRow("ct_test00000005", "Taylor Testcase");
  await commitChange(ctxFor(db), {
    target: { table: "contacts", id: row.id },
    summary: "Added",
    changes: [{ table: "contacts", id: row.id, before: null, after: row }],
  });
  await assert.rejects(
    commitChange(ctxFor(db), {
      target: { table: "contacts", id: row.id },
      summary: "Removed",
      changes: [{ table: "contacts", id: row.id, before: { ...row, version: 7 }, after: null }],
    }),
    StaleWriteError,
  );
  await commitChange(ctxFor(db), {
    target: { table: "contacts", id: row.id },
    summary: "Removed",
    changes: [{ table: "contacts", id: row.id, before: row, after: null }],
  });
  assert.equal(await count(db, "contacts"), 0);
});

test("only known tables and plain column names are accepted", async () => {
  const db = await openTestDb();
  const row = contactRow("ct_test00000006", "Morgan Demo");
  await assert.rejects(
    commitChange(ctxFor(db), {
      target: { table: "contacts", id: row.id },
      summary: "Bad table",
      changes: [{ table: "audit_log" as "contacts", id: row.id, before: null, after: row }],
    }),
    /table/,
  );
  await assert.rejects(
    commitChange(ctxFor(db), {
      target: { table: "contacts", id: row.id },
      summary: "Bad column",
      changes: [{ table: "contacts", id: row.id, before: null, after: { ...row, "name) --": "x" } }],
    }),
    /column/,
  );
  await assert.rejects(
    commitChange(ctxFor(db), {
      target: { table: "contacts", id: row.id },
      summary: "Wrong id",
      changes: [{ table: "contacts", id: "ct_other", before: null, after: row }],
    }),
    /id/,
  );
  assert.equal(await count(db, "contacts"), 0);
  assert.equal(await count(db, "audit_log"), 0);
});

test("extra statements run in the same batch, and a failing one rolls everything back", async () => {
  const db = await openTestDb();
  const row = contactRow("ct_test00000007", "Alex Sample");
  await commitChange(ctxFor(db), {
    target: { table: "contacts", id: row.id },
    summary: "Added",
    changes: [{ table: "contacts", id: row.id, before: null, after: row }],
    extra: [db.prepare("UPDATE rulebook SET markdown = 'extra ran' WHERE name = 'voice'")],
  });
  assert.equal(await db.prepare("SELECT markdown FROM rulebook WHERE name = 'voice'").first("markdown"), "extra ran");

  const second = contactRow("ct_test00000008", "Sam Example");
  await assert.rejects(
    commitChange(ctxFor(db), {
      target: { table: "contacts", id: second.id },
      summary: "Added",
      changes: [{ table: "contacts", id: second.id, before: null, after: second }],
      extra: [db.prepare("INSERT INTO write_guard (ok) VALUES (0)")],
    }),
  );
  assert.equal(await count(db, "contacts"), 1);
  assert.equal(await count(db, "audit_log"), 1);
});

test("a summary is always one line", async () => {
  const db = await openTestDb();
  const row = contactRow("ct_test00000009", "Pat\nExample");
  const result = await commitChange(ctxFor(db), {
    target: { table: "contacts", id: row.id },
    summary: "Added contact Pat\nExample\r\n  today ",
    changes: [{ table: "contacts", id: row.id, before: null, after: row }],
  });
  assert.equal(result.summary, `Added contact Pat Example today (change ${result.changeId})`);
});

test("guard and foreign-key failures are recognized anywhere in the cause chain", () => {
  const guard = new Error("D1_ERROR: CHECK constraint failed: ok = 1: SQLITE_CONSTRAINT");
  const wrapped = new Error("Failed query", { cause: new Error("batch failed", { cause: guard }) });
  assert.equal(isGuardFailure(wrapped), true);
  assert.equal(isGuardFailure(new Error("Failed query", { cause: new Error("nope") })), false);
  assert.equal(isForeignKeyFailure(new Error("outer", { cause: new Error("FOREIGN KEY constraint failed") })), true);
  assert.equal(
    isDuplicateEmailFailure(new Error("outer", { cause: new Error("UNIQUE constraint failed: index 'contacts_email'") })),
    true,
  );
  assert.equal(isDuplicateEmailFailure(new Error("UNIQUE constraint failed: rule_firings.fire_key")), false);
});
