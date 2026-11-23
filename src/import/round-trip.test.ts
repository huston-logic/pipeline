// The board's CSV export imports back (decision 0037): contacts, deals and tasks exported from one fake copy with the
// real export code come into an empty copy in that order with their ids and custom field values, and into the same
// copy as all unchanged. A contact and a deal archived in the copy are left out both ways ("archived in the file").
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import type { ContactRow, Db, DealRow, TaskRow } from "../db/db.ts";
import { listFieldDefs } from "../db/queries.ts";
import { createTestDb, type SqliteD1 } from "../db/sqlite-d1.ts";
import { exportTableCsv } from "../http/export.ts";
import { commitChange } from "../services/change.ts";
import { DEFAULT_TZ } from "../time.ts";
import { IMPORT_ACTOR } from "./change.ts";
import { mapCsv, planRows } from "./engine.ts";
import { contactsOnFile, dealsOnFile, tasksOnFile } from "./load.ts";
import { dealsModule } from "./modules/deals.ts";
import { peopleModule } from "./modules/people.ts";
import { tasksModule } from "./modules/tasks.ts";

const NOW = new Date("2026-11-23T18:00:00.000Z");

type Counts = { created: number; filled: number; unchanged: number; skipped: number };

async function importPeople(db: Db, csv: string): Promise<Counts> {
  const fieldDefs = await listFieldDefs(db, { includeArchived: true });
  const { rows } = mapCsv(peopleModule, csv, fieldDefs);
  const ctx = await contactsOnFile(db);
  const plan = planRows(peopleModule, rows, ctx, { asLeads: false, allowDuplicates: false, fieldDefs });
  const input = peopleModule.change(plan, ctx, NOW);
  if (input) await commitChange({ db, now: NOW, ...IMPORT_ACTOR }, input);
  return { created: plan.create.length, filled: plan.merge.length, unchanged: plan.unchanged.length, skipped: plan.skipped.length };
}

async function importDeals(db: Db, csv: string): Promise<Counts> {
  const fieldDefs = await listFieldDefs(db, { includeArchived: true });
  const { rows } = mapCsv(dealsModule, csv, fieldDefs);
  const ctx = await dealsOnFile(db, rows);
  const plan = planRows(dealsModule, rows, ctx, { closedAsHistory: true, fieldDefs });
  assert.deepEqual(plan.people, [], "every deal finds its person, imported first");
  const input = dealsModule.change(plan, ctx, NOW);
  if (input) await commitChange({ db, now: NOW, ...IMPORT_ACTOR }, input);
  return { created: plan.create.length, filled: plan.merge.length, unchanged: plan.unchanged.length, skipped: plan.skipped.length };
}

async function importTasks(db: Db, csv: string): Promise<Counts> {
  const { rows } = mapCsv(tasksModule, csv, []);
  const ctx = await tasksOnFile(db, rows);
  const plan = planRows(tasksModule, rows, ctx, { fieldDefs: [] });
  const input = tasksModule.change(plan, ctx, NOW);
  if (input) await commitChange({ db, now: NOW, ...IMPORT_ACTOR }, input);
  return { created: plan.create.length, filled: plan.merge.length, unchanged: plan.unchanged.length, skipped: plan.skipped.length };
}

async function fakeCopy(): Promise<SqliteD1> {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  db.exec(FIELDS);
  // Custom field values, which the export writes only in each row's `fields` JSON column.
  db.exec(`UPDATE contacts SET fields = '{"role":"Owner"}' WHERE id = 'ct_seed01'`);
  db.exec(`UPDATE deals SET fields = '{"budget":"5000","hours":12}' WHERE id = 'dl_seed01'`);
  // An archived person and their (lost) deal; no task names either.
  db.exec("UPDATE contacts SET archived = 1 WHERE id = 'ct_seed08'");
  db.exec("UPDATE deals SET archived = 1 WHERE id = 'dl_seed08'");
  return db;
}

/** The same fields in both copies: an owner who moves copies adds them first. */
const FIELDS = `INSERT INTO field_defs (id, entity, key, label, type) VALUES
  ('fd_role', 'contact', 'role', 'Role', 'text'),
  ('fd_budget', 'deal', 'budget', 'Budget', 'text'),
  ('fd_hours', 'deal', 'hours', 'Hours', 'number')`;

const live = <T extends { archived: number }>(list: readonly T[]) => list.filter((row) => row.archived === 0);

const rows = async <T>(db: Db, table: string) => (await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all<T>()).results;

async function exported(db: Db) {
  return {
    contacts: await exportTableCsv(db, "contacts"),
    deals: await exportTableCsv(db, "deals"),
    tasks: await exportTableCsv(db, "tasks"),
  };
}

const outside = (row: { untrusted_fields: string }) => JSON.parse(row.untrusted_fields) as string[];

test("round trip: export contacts, deals and tasks from one fake copy and import them into an empty one", async () => {
  const source = await fakeCopy();
  const files = await exported(source);
  const target = await createTestDb();
  target.exec(FIELDS);

  assert.deepEqual(await importPeople(target, files.contacts), { created: 7, filled: 0, unchanged: 0, skipped: 1 });
  assert.deepEqual(await importDeals(target, files.deals), { created: 7, filled: 0, unchanged: 0, skipped: 1 });
  assert.deepEqual(await importTasks(target, files.tasks), { created: 6, filled: 0, unchanged: 0, skipped: 0 });

  const people = [live(await rows<ContactRow>(source, "contacts")), await rows<ContactRow>(target, "contacts")] as const;
  const deals = [live(await rows<DealRow>(source, "deals")), await rows<DealRow>(target, "deals")] as const;
  assert.ok(!people[1].some((row) => row.id === "ct_seed08") && !deals[1].some((row) => row.id === "dl_seed08"), "no archived record");
  const tasks = [await rows<TaskRow>(source, "tasks"), await rows<TaskRow>(target, "tasks")] as const;
  const pick = <T>(list: readonly T[], keys: (keyof T)[]) => list.map((row) => keys.map((key) => row[key]));
  assert.deepEqual(
    pick(people[1], ["id", "name", "email", "phone", "business", "source", "notes", "lead_status", "fields", "archived"]),
    pick(people[0], ["id", "name", "email", "phone", "business", "source", "notes", "lead_status", "fields", "archived"]),
    "ids and custom field values kept",
  );
  assert.deepEqual(
    pick(deals[1], ["id", "contact_id", "title", "stage_key", "status", "value", "next_step", "next_at", "fields", "archived"]),
    pick(deals[0], ["id", "contact_id", "title", "stage_key", "status", "value", "next_step", "next_at", "fields", "archived"]),
  );
  assert.deepEqual(JSON.parse(deals[1].find((row) => row.id === "dl_seed01")?.fields ?? ""), { budget: "5000", hours: 12 }, "a number stays a number");
  assert.ok(outside(people[1].find((row) => row.id === "ct_seed01") ?? { untrusted_fields: "[]" }).includes("role"));
  assert.ok(["budget", "hours"].every((key) => outside(deals[1].find((row) => row.id === "dl_seed01") ?? { untrusted_fields: "[]" }).includes(key)));
  assert.deepEqual(
    pick(tasks[1], ["id", "deal_id", "contact_id", "title", "due_at", "done_at"]),
    pick(tasks[0], ["id", "deal_id", "contact_id", "title", "due_at", "done_at"]),
  );
  for (const row of [...people[1], ...deals[1], ...tasks[1]]) {
    assert.ok(outside(row).length > 0, `every imported row is outside text: ${row.id}`);
  }
  assert.ok(people[1].every((row) => outside(row).includes("name")));
  assert.ok(deals[1].every((row) => outside(row).includes("title")));
  assert.ok(tasks[1].every((row) => outside(row).includes("title")));
  assert.equal(await target.prepare("SELECT COUNT(*) AS n FROM audit_log").first("n"), 3, "one change per file");
});

test("round trip into the same copy is all unchanged", async () => {
  const db = await fakeCopy();
  const files = await exported(db);
  const before = await snapshot(db);
  assert.deepEqual(await importPeople(db, files.contacts), { created: 0, filled: 0, unchanged: 7, skipped: 1 });
  assert.deepEqual(await importDeals(db, files.deals), { created: 0, filled: 0, unchanged: 7, skipped: 1 });
  assert.deepEqual(await importTasks(db, files.tasks), { created: 0, filled: 0, unchanged: 6, skipped: 0 });
  assert.deepEqual(await snapshot(db), before, "nothing was written");
});

async function snapshot(db: Db) {
  return {
    contacts: await rows<ContactRow>(db, "contacts"),
    deals: await rows<DealRow>(db, "deals"),
    tasks: await rows<TaskRow>(db, "tasks"),
    audits: await db.prepare("SELECT COUNT(*) AS n FROM audit_log").first("n"),
  };
}
