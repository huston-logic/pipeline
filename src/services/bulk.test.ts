// One change at any size (decision 0035): a 2,000-row import is one audited change in one batch, its snapshot is
// kept in audit_parts, every statement stays under D1's 100 KB (bound in the Worker, rendered for `wrangler d1
// execute --file`), and undo reverses it in one change with the same refusals as a small undo.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditRow, ContactRow, Db } from "../db/db.ts";
import { applyMigrations, applySqlFile, SqliteD1, type SqliteStatement } from "../db/sqlite-d1.ts";
import { IMPORT_ACTOR, importChange, renderImport } from "../import/change.ts";
import { planImport } from "../import/plan.ts";
import { MAX_STATEMENT_BYTES, renderStatement } from "../import/sql.ts";
import { addDeal } from "./add-deal.ts";
import { CHUNK_BYTES, chunkRows, sqlBytes } from "./bulk.ts";
import { racing } from "../../tests/helpers/race-db.ts";
import { buildChange, type ChangeInput, commitChange, readSnapshot, type Row, StaleWriteError } from "./change.ts";
import { updateContact } from "./contacts.ts";
import { UserError } from "./errors.ts";
import { undoChange } from "./undo.ts";

const NOW = new Date("2026-11-22T18:00:00.000Z");
const LATER = new Date("2026-11-22T19:00:00.000Z");
const LATEST = new Date("2026-11-22T20:00:00.000Z");

/** The shim, counting the D1 calls a service makes: statements run on their own, and batches. */
class CountingD1 extends SqliteD1 {
  reads = 0;
  batches = 0;
  #inBatch = false;

  override execute(statement: SqliteStatement): ReturnType<SqliteD1["execute"]> {
    if (!this.#inBatch) this.reads += 1;
    return super.execute(statement);
  }

  override async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.batches += 1;
    this.#inBatch = true;
    try {
      return await super.batch<T>(statements);
    } finally {
      this.#inBatch = false;
    }
  }

  reset(): void {
    this.reads = 0;
    this.batches = 0;
  }
}

async function freshDb(): Promise<CountingD1> {
  const db = new CountingD1();
  await applyMigrations(db);
  applySqlFile(db, "seed/defaults.sql");
  return db;
}

/** `old` contacts already on file (old.N@example.com, no phone), so an import fills in their phone. */
function addOldContacts(db: SqliteD1, old: number): void {
  for (let i = 0; i < old; i++) {
    db.exec(`INSERT INTO contacts (id, name, email, untrusted_fields, created_at, updated_at)
      VALUES ('ct_old${String(i).padStart(9, "0")}', 'Old Person ${i}', 'old.${i}@example.com', '[]',
        '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`);
  }
}

/** A CSV of `rows` people: the first `old` rows match the contacts addOldContacts adds, the rest are new. */
function peopleCsv(rows: number, old = 0, name = (i: number) => `Person ${i}`): string {
  const lines = ["name,email,phone,business,source,notes"];
  for (let i = 0; i < rows; i++) {
    const email = i < old ? `old.${i}@example.com` : `person.${i}@example.com`;
    lines.push(`"${name(i).replaceAll('"', '""')}",${email},555-01${String(i % 100).padStart(2, "0")},Shop ${i},trade list,Met at the fair`);
  }
  return `${lines.join("\r\n")}\r\n`;
}

const contacts = async (db: Db) =>
  (await db.prepare("SELECT * FROM contacts ORDER BY rowid").all<ContactRow>()).results.map((row) => ({ ...row }));
const count = async (db: Db, table: string) =>
  (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? -1;
const auditOf = async (db: Db, id: string) => db.prepare("SELECT * FROM audit_log WHERE id = ?").bind(id).first<AuditRow>();

async function plannedImport(db: Db, csv: string): Promise<ChangeInput> {
  const existing = await contacts(db);
  const input = importChange(planImport(csv, existing), existing, NOW);
  assert.ok(input, "the import writes something");
  return input;
}

async function imported(db: CountingD1, rows = 2_000, old = 0) {
  addOldContacts(db, old);
  const input = await plannedImport(db, peopleCsv(rows, old));
  return commitChange({ db, now: NOW, ...IMPORT_ACTOR }, input);
}

const undoCtx = (db: Db, now = LATER) => ({ db, now, actor: "ai" as const, tool: "undo_change" });

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => assert.fail("expected a refusal"),
    (e: unknown) => e,
  );
  assert.ok(error instanceof UserError, `expected a UserError, got ${String(error)}`);
  return error.message;
}

/** Every table's rows, to show a refusal wrote nothing. */
async function everything(db: Db): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of ["contacts", "deals", "activities", "tasks", "audit_log", "audit_parts", "write_guard"]) {
    out[table] = (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results.map((row) => ({ ...(row as object) }));
  }
  return out;
}

test("sqlBytes counts UTF-8 bytes plus one per apostrophe", () => {
  assert.equal(sqlBytes(""), 0);
  assert.equal(sqlBytes("abc"), 3);
  assert.equal(sqlBytes("a'é🌱"), 1 + 2 + 2 + 4);
  assert.equal(sqlBytes("''"), 4);
  assert.equal(CHUNK_BYTES, 90_000);
});

test("chunks stay under the limit when every name is quotes and emoji", () => {
  const names = Array.from({ length: 2_000 }, (_, i) => `O'Brien ''${i}'' 🌱👩🏽‍💻 "quoted" é`.repeat(12).slice(0, 480));
  const rows: Row[] = names.map((name, i) => ({ id: `ct_${String(i).padStart(12, "0")}`, name, notes: "'".repeat(400), version: 1 }));
  const chunks = chunkRows(rows);
  assert.ok(chunks.length > 10, `${chunks.length} chunks`);
  assert.deepEqual(chunks.flat(), rows, "every row once, in order");
  for (const chunk of chunks) {
    const json = JSON.stringify(chunk);
    assert.ok(sqlBytes(json) <= CHUNK_BYTES, `a chunk measures ${sqlBytes(json)}`);
    const literal = renderStatement({ sql: "SELECT ?", params: [json] });
    assert.ok(new TextEncoder().encode(literal).byteLength <= CHUNK_BYTES + 20, "rendered as SQL text it is still under");
  }
  assert.deepEqual(chunkRows([]), []);
  assert.throws(() => chunkRows([{ id: "ct_big", notes: "x".repeat(100) }], 50), /too large/);

  // The same names (cut to fit a 1 MB file) through a whole import: every statement, bound or rendered, stays under
  // D1's limits.
  const csv = peopleCsv(2_000, 0, (i) => (names[i] ?? "").slice(0, 280));
  assert.ok(new TextEncoder().encode(csv).byteLength > 850_000);
  const input = importChange(planImport(csv, []), [], NOW);
  assert.ok(input);
  const built = buildChange({ ...IMPORT_ACTOR, now: NOW }, input);
  for (const statement of [...built.writes, ...built.audit]) {
    assert.ok(statement.params.length <= 100, "D1 allows 100 bound parameters");
    for (const param of statement.params) if (typeof param === "string") assert.ok(sqlBytes(param) <= CHUNK_BYTES);
    assert.ok(new TextEncoder().encode(renderStatement(statement)).byteLength <= MAX_STATEMENT_BYTES);
  }
});

test("a 2,000-row import is one change with parts and one batch", async () => {
  const db = await freshDb();
  addOldContacts(db, 40);
  const input = await plannedImport(db, peopleCsv(2_000, 40));
  assert.equal(input.bulk, true, "the import builds a bulk change");
  db.reset();
  const result = await commitChange({ db, now: NOW, ...IMPORT_ACTOR }, input);

  assert.equal(db.batches, 1, "one D1 batch");
  assert.equal(db.reads, 0);
  assert.equal(result.summary, `Imported 1960 contacts and filled details on 40 (change ${result.changeId})`);
  assert.equal(await count(db, "contacts"), 2_000);
  assert.equal(await count(db, "audit_log"), 1);
  assert.equal(await count(db, "write_guard"), 0);
  const audit = await auditOf(db, result.changeId);
  assert.ok(audit);
  assert.equal(audit.before_json, "{}");
  assert.equal(audit.after_json, "{}");
  assert.ok(audit.parts > 1, `${audit.parts} parts`);
  assert.equal(await count(db, "audit_parts"), audit.parts);
  const snapshot = await readSnapshot(db, audit);
  assert.equal(Object.keys(snapshot.after).length, 2_000);
  const merged = snapshot.before["contacts:ct_old000000007"];
  assert.equal(merged?.phone, null, "the before of a merged contact is kept");
  assert.equal(snapshot.after["contacts:ct_old000000007"]?.phone, "555-0107");
  const stored = await contacts(db);
  for (const row of stored.filter((c) => !c.id.startsWith("ct_old"))) {
    assert.deepEqual(row, snapshot.after[`contacts:${row.id}`], "each new row is stored exactly as its snapshot");
  }
});

test("bulk and per-row writes store identical values and types", async () => {
  const typed = async (db: Db, table: string) => {
    const columns = (await db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()).results.map((c) => c.name);
    const select = columns.map((c) => `${c}, typeof(${c}) AS "${c}:type"`).join(", ");
    return (await db.prepare(`SELECT ${select} FROM ${table} ORDER BY id`).all()).results.map((row) => ({ ...(row as object) }));
  };
  const contact: Row = {
    id: "ct_typed00001", name: "Pat O'Example 🌱", email: null, phone: "555 0101", business: "it's \"quoted\"",
    source: null, notes: "line one\nline two\t'tab'", fields: '{"size":12,"role":"Owner\'s"}', untrusted_fields: '["name"]',
    archived: 0, version: 1, created_at: NOW.toISOString(), updated_at: NOW.toISOString(), lead_status: "new",
    lead_status_at: NOW.toISOString(),
  };
  const deals: Row[] = [5000, 12.5, null, 0].map((value, i) => ({
    id: `dl_typed0000${i}`, contact_id: "ct_typed00001", title: `Deal ${i}`, stage_key: "new_inquiry", value,
    next_step: null, next_at: null, status: "open", fields: "{}", stage_entered_at: NOW.toISOString(),
    last_activity_at: null, untrusted_fields: "[]", archived: 0, version: 1, created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  }));
  const write = async (bulk: boolean) => {
    const db = await freshDb();
    const ctx = { db, now: NOW, ...IMPORT_ACTOR };
    await commitChange(ctx, {
      target: { table: "contacts", id: "ct_typed00001" },
      summary: "Typed rows",
      changes: [contact, ...deals].map((row) => ({ table: row === contact ? "contacts" : "deals", id: String(row.id), before: null, after: row })),
      bulk,
    });
    const [first] = deals;
    assert.ok(first);
    await commitChange(ctx, {
      target: { table: "deals", id: String(first.id) },
      summary: "Typed update",
      changes: [{ table: "deals", id: String(first.id), before: first, after: { ...first, value: 7, title: "Now 'seven'", version: 2 } }],
      bulk,
    });
    return { contacts: await typed(db, "contacts"), deals: await typed(db, "deals") };
  };
  const perRow = await write(false);
  const bulk = await write(true);
  assert.deepEqual(bulk, perRow);
  assert.equal((perRow.deals[0] as Record<string, unknown>)["value:type"], "real");
  assert.equal((perRow.deals[2] as Record<string, unknown>)["value:type"], "null");
  assert.equal((perRow.contacts[0] as Record<string, unknown>)["version:type"], "integer");
});

test("bulk accepts only tables with a version column", () => {
  const firing: Row = { id: "rf_x", rule_id: "ru_x", deal_id: "dl_x", contact_id: null, fire_key: "k", task_id: null, fired_at: NOW.toISOString() };
  assert.throws(
    () =>
      buildChange({ ...IMPORT_ACTOR, now: NOW }, {
        target: { table: "rule_firings", id: "rf_x" },
        summary: "x",
        changes: [{ table: "rule_firings", id: "rf_x", before: null, after: firing }],
        bulk: true,
      }),
    /rule_firings/,
  );
});

test("undo of a 2,000-row import removes every row in one change", async () => {
  const db = await freshDb();
  addOldContacts(db, 40);
  const original = await contacts(db);
  const input = await plannedImport(db, peopleCsv(2_000, 40));
  const done = await commitChange({ db, now: NOW, ...IMPORT_ACTOR }, input);
  db.reset();

  const undo = await undoChange(undoCtx(db), done.changeId);

  assert.equal(
    undo.summary,
    `Undid ${done.changeId}: Removed 1,960 contacts and put back the earlier values on 40 contacts (change ${undo.changeId})`,
  );
  assert.equal(db.batches, 1, "one D1 batch");
  const reads = db.reads;
  const after = await contacts(db);
  assert.equal(after.length, 40);
  after.forEach((row, i) => {
    const was = original[i] as ContactRow;
    assert.deepEqual({ ...row, version: was.version, updated_at: was.updated_at }, was, "every value is back as it was");
    assert.equal(row.version, was.version + 2);
  });
  assert.equal(await count(db, "write_guard"), 0);
  assert.equal((await auditOf(db, done.changeId))?.undone_by, undo.changeId);
  const undoRow = await auditOf(db, undo.changeId);
  assert.equal(undoRow?.undo_of, done.changeId);
  assert.ok((undoRow?.parts ?? 0) > 1, "the undo's own snapshot is in parts too");

  // The reads are set-based: a 100-row import's undo reads as many times as the 2,000-row one.
  const small = await freshDb();
  addOldContacts(small, 40);
  const smallDone = await commitChange({ db: small, now: NOW, ...IMPORT_ACTOR }, await plannedImport(small, peopleCsv(100, 40)));
  small.reset();
  await undoChange(undoCtx(small), smallDone.changeId);
  assert.equal(reads, small.reads, "the same number of reads whatever the size");
});

test("undo refuses a bulk import when one row changed", async () => {
  const db = await freshDb();
  const done = await imported(db);
  const target = (await contacts(db))[1_234] as ContactRow;
  await updateContact({ db, now: LATER, actor: "owner", tool: "update_contact" }, target.id, { phone: "555 0199" });
  const snapshot = await everything(db);

  const message = await refusal(undoChange(undoCtx(db, LATEST), done.changeId));

  assert.equal(
    message,
    `Can't undo ${done.changeId}: contact ${target.id} changed since (see recent_changes). Undo the later changes first, or leave it.`,
  );
  assert.deepEqual(await everything(db), snapshot, "nothing was written");
  assert.equal((await auditOf(db, done.changeId))?.undone_at, null);
});

test("undo refuses when a deal was added to an imported person since", async () => {
  const db = await freshDb();
  const done = await imported(db);
  const person = (await contacts(db))[1_500] as ContactRow;
  await addDeal({ db, now: LATER, actor: "owner", tool: "add_deal" }, { contact: person.id, dealTitle: "Website refresh" });
  const snapshot = await everything(db);

  const message = await refusal(undoChange(undoCtx(db, LATEST), done.changeId));

  assert.equal(message, `Can't undo ${done.changeId}: other records now depend on it (1 deal). Change those first, or leave it.`);
  assert.deepEqual(await everything(db), snapshot, "nothing was written");
});

test("undo twice says already undone", async () => {
  const db = await freshDb();
  const done = await imported(db);
  const first = await undoChange(undoCtx(db), done.changeId);
  assert.equal(first.summary, `Undid ${done.changeId}: Removed 2,000 contacts (change ${first.changeId})`);
  const message = await refusal(undoChange(undoCtx(db, LATEST), done.changeId));
  assert.equal(message, `${done.changeId} was already undone (by ${first.changeId}). Nothing to do.`);
  assert.equal(await count(db, "contacts"), 0);
});

/** What `wrangler d1 execute --file` does: every statement in one batch, so a failure writes nothing. */
function runFile(db: SqliteD1, sql: string): void {
  db.exec("BEGIN");
  try {
    db.exec(sql);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

test("a 2,000-row import renders as SQL with no statement over 100 KB", async () => {
  const db = await freshDb();
  addOldContacts(db, 40);
  const input = await plannedImport(db, peopleCsv(2_000, 40));
  assert.throws(() => renderImport({ ...input, bulk: false }, NOW), /too large for one change/, "one row at a time it was refused");

  const built = buildChange({ ...IMPORT_ACTOR, now: NOW }, { ...input, changeId: "chg_bulkfile0001" });
  const sizes = [...built.writes, ...built.audit].map((statement) => new TextEncoder().encode(renderStatement(statement)).byteLength);
  assert.ok(Math.max(...sizes) <= MAX_STATEMENT_BYTES, `the largest statement is ${Math.max(...sizes)} bytes`);
  assert.ok(sizes.length < 60, `${sizes.length} statements`);

  const rendered = renderImport({ ...input, changeId: "chg_bulkfile0001" }, NOW);
  runFile(db, rendered.sql);
  assert.equal(await count(db, "contacts"), 2_000);
  assert.equal(await count(db, "audit_log"), 1);

  const viaWorker = await freshDb();
  addOldContacts(viaWorker, 40);
  await commitChange({ db: viaWorker, now: NOW, ...IMPORT_ACTOR }, { ...input, changeId: "chg_bulkfile0001" });
  assert.deepEqual(await everything(db), await everything(viaWorker), "the file writes exactly what the Worker would");

  const undo = await undoChange(undoCtx(db), "chg_bulkfile0001");
  assert.match(undo.summary, /^Undid chg_bulkfile0001: Removed 1,960 contacts and put back the earlier values on 40 contacts/);
  assert.equal(await count(db, "contacts"), 40);
});

const plainContact = (i: number): Row => ({
  id: `ct_g${String(i).padStart(10, "0")}`, name: `Person ${i}`, email: `p${i}@example.com`, untrusted_fields: "[]",
  version: 1, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
});

test("a row edited between read and commit stops a bulk change across chunks: nothing written, no audit row", async () => {
  const db = await freshDb();
  const ctx = { db, now: NOW, ...IMPORT_ACTOR };
  const rows = Array.from({ length: 3_000 }, (_, i) => plainContact(i));
  await commitChange(ctx, {
    target: { table: "contacts", id: String(rows[0]?.id) },
    summary: "Added people",
    changes: rows.map((row) => ({ table: "contacts", id: String(row.id), before: null, after: row })),
    bulk: true,
  });
  const update: ChangeInput = {
    target: { table: "contacts", id: String(rows[0]?.id) },
    summary: "Renamed people",
    changes: rows.map((row) => ({ table: "contacts", id: String(row.id), before: row, after: { ...row, name: `Renamed ${String(row.id)}`, version: 2 } })),
    bulk: true,
  };
  const guards = buildChange(ctx, update).writes.filter((statement) => statement.sql.startsWith("INSERT INTO write_guard"));
  assert.ok(guards.length >= 2, `${guards.length} guard statements`);
  // Someone edits a row the second guard chunk covers.
  db.exec(`UPDATE contacts SET version = 2 WHERE id = '${String(rows[2_900]?.id)}'`);
  const snapshot = await everything(db);

  await assert.rejects(commitChange(ctx, update), (error: unknown) => {
    assert.ok(error instanceof StaleWriteError);
    assert.equal((error as Error).message, "A record this change touches changed since you read it. Read it again and retry.");
    return true;
  });
  assert.deepEqual(await everything(db), snapshot, "no row and no audit row written");
});

test("two undos of a bulk change at once: one wins, the other is told it was already undone", async () => {
  const db = await freshDb();
  const done = await imported(db, 200);
  const rival = racing(db, () => undoChange(undoCtx(db), done.changeId));

  const message = await refusal(undoChange(undoCtx(rival), done.changeId));

  assert.match(message, new RegExp(`^${done.changeId} was already undone \\(by chg_[a-z2-7]{12}\\)\\. Nothing to do\\.$`));
  assert.equal(await count(db, "contacts"), 0, "removed once");
  assert.equal(await count(db, "audit_log"), 2, "the import and one undo");
  assert.equal(await count(db, "write_guard"), 0);
});
