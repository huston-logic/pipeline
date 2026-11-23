// A bulk change (decision 0035) on real local D1 (workerd, via wrangler's getPlatformProxy): the json_each inserts and
// the UPDATE ... FROM json_each statements run only on the node:sqlite shim in the unit tests, so this writes and
// updates contacts across several chunks on D1 itself, reads them back, and undoes them.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { getPlatformProxy } from "wrangler";
import { buildChange, commitChange, type Ctx, type Row, type RowChange } from "../../src/services/change.ts";
import { undoChange } from "../../src/services/undo.ts";
import { prepareState, ROOT } from "./harness.ts";

let stateDir: string;
let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;

before(async () => {
  stateDir = prepareState("pipeline-d1-bulk-");
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: join(ROOT, "wrangler.jsonc"),
    persist: { path: join(stateDir, "v3") },
    envFiles: [],
    remoteBindings: false,
  });
});

after(async () => {
  await proxy?.dispose();
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
});

const NOW = new Date("2026-11-22T18:00:00.000Z");
const ctx = (tool = "import"): Ctx => ({ db: proxy.env.DB, now: NOW, actor: "owner", tool });

const person = (i: number): Row => ({
  id: `ct_bulk${String(i).padStart(7, "0")}`,
  name: `Bulk Person ${i} O'Example 🌱`,
  email: `bulk.${i}@example.com`,
  phone: null,
  business: null,
  source: "trade list",
  notes: `It's "note" ${i}: ${"x".repeat(600)}`,
  fields: '{"size":12}',
  untrusted_fields: '["name","email","notes"]',
  archived: 0,
  version: 1,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
  lead_status: "new",
  lead_status_at: NOW.toISOString(),
});

const stored = async () =>
  (await proxy.env.DB.prepare("SELECT * FROM contacts WHERE id LIKE 'ct_bulk%' ORDER BY id").all<Row>()).results.map((row) => ({ ...row }));

test("a bulk insert and a bulk update across several chunks read back exactly on real D1; the update undoes", async () => {
  const rows = Array.from({ length: 400 }, (_, i) => person(i));
  const insert = {
    target: { table: "contacts" as const, id: String(rows[0]?.id) },
    summary: "Imported 400 contacts and filled details on 0",
    changes: rows.map((row): RowChange => ({ table: "contacts", id: String(row.id), before: null, after: row })),
    bulk: true,
  };
  const inserts = buildChange(ctx(), insert).writes.filter((statement) => statement.sql.startsWith("INSERT INTO contacts"));
  assert.ok(inserts.length >= 2, `${inserts.length} insert chunks`);
  const added = await commitChange(ctx(), insert);
  assert.deepEqual(await stored(), rows, "every value and type as written");

  const changed = rows.map((row, i) => ({ ...row, phone: `555-01${String(i % 100).padStart(2, "0")}`, notes: `Changed ${i} ${"y".repeat(600)}`, version: 2 }));
  const update = {
    target: { table: "contacts" as const, id: String(rows[0]?.id) },
    summary: "Filled phones",
    changes: rows.map((row, i): RowChange => ({ table: "contacts", id: String(row.id), before: row, after: changed[i] ?? null })),
    bulk: true,
  };
  const updates = buildChange(ctx(), update).writes.filter((statement) => statement.sql.startsWith("UPDATE contacts"));
  assert.ok(updates.length >= 2, `${updates.length} update chunks`);
  const filled = await commitChange(ctx(), update);
  assert.deepEqual(await stored(), changed);

  const undoFill = await undoChange(ctx("undo_change"), filled.changeId);
  assert.equal(undoFill.summary, `Undid ${filled.changeId}: Put back the earlier values on 400 contacts (change ${undoFill.changeId})`);
  assert.deepEqual(
    await stored(),
    rows.map((row) => ({ ...row, version: 3 })),
    "the earlier values are back, with a new version",
  );

  // The insert can't be undone now: its rows were changed (and put back) since, each with a new version.
  await assert.rejects(undoChange(ctx("undo_change"), added.changeId), {
    message: /^Can't undo chg_[a-z2-7]{12}: contact ct_bulk\d+ changed since/,
  });
});

test("a bulk insert across several chunks undoes in one change on real D1", async () => {
  const rows = Array.from({ length: 400 }, (_, i) => person(1_000 + i));
  const added = await commitChange(ctx(), {
    target: { table: "contacts", id: String(rows[0]?.id) },
    summary: "Imported 400 contacts and filled details on 0",
    changes: rows.map((row): RowChange => ({ table: "contacts", id: String(row.id), before: null, after: row })),
    bulk: true,
  });
  const audit = await proxy.env.DB.prepare("SELECT parts FROM audit_log WHERE id = ?").bind(added.changeId).first<{ parts: number }>();
  assert.ok((audit?.parts ?? 0) >= 2, "the snapshot is in parts");
  const undo = await undoChange(ctx("undo_change"), added.changeId);
  assert.equal(undo.summary, `Undid ${added.changeId}: Removed 400 contacts (change ${undo.changeId})`);
  assert.equal((await stored()).filter((row) => String(row.id) >= "ct_bulk0001000").length, 0);
});
