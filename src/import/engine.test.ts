import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditRow, FieldDefRow, TaskRow } from "../db/db.ts";
import { createTestDb, type SqliteD1 } from "../db/sqlite-d1.ts";
import type { RowChange } from "../services/change.ts";
import { UserError } from "../services/errors.ts";
import { renderImport } from "./change.ts";
import {
  autoMatch,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  type ImportModule,
  type ImportOptions,
  mapRows,
  planCsv,
  readCsv,
} from "./engine.ts";
import { peopleModule } from "./modules/people.ts";

const NOW = new Date("2026-11-22T18:00:00.000Z");
const PLAIN: ImportOptions = { asLeads: false, allowDuplicates: false, fieldDefs: [] };

const defs = (rows: Partial<FieldDefRow>[]): FieldDefRow[] =>
  rows.map((row, i) => ({
    id: `fd_${i}`,
    entity: "contact",
    key: "role",
    label: "Role",
    type: "text",
    choices: null,
    archived: 0,
    version: 1,
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
    ...row,
  }));

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

test("autoMatch maps name, Email and a field label", () => {
  const fieldDefs = defs([
    { key: "size", label: "Team size", type: "number" },
    { key: "email", label: "Work email" },
    { key: "old", label: "Old", archived: 1 },
    { key: "deal_note", label: "Deal note", entity: "deal" },
  ]);
  const header = ["name", " Email ", "TEAM SIZE", "size", "lead_status", "Old", "Deal note", "colour", "   "];
  assert.deepEqual(autoMatch(peopleModule, header, fieldDefs), [
    { kind: "builtin", key: "name" },
    { kind: "builtin", key: "email" },
    { kind: "field", key: "size" },
    { kind: "field", key: "size" },
    { kind: "builtin", key: "lead_status" },
    { kind: "skip" },
    { kind: "skip" },
    { kind: "skip" },
    { kind: "skip" },
  ]);
});

test("a header named twice is refused with the same message as before", () => {
  const refused = (csv: string, name: string, fieldDefs: FieldDefRow[] = []) =>
    assert.throws(
      () => planCsv(peopleModule, csv, [], { ...PLAIN, fieldDefs }),
      (error: unknown) =>
        error instanceof UserError &&
        error.message === `The header row names "${name}" twice. Keep one column of each name and try again.`,
      csv,
    );
  refused("name,email,Name\r\n", "name");
  refused("name,lead_status,LEAD_STATUS\r\n", "lead_status");
  refused("name,Role,role\r\nA,b,c\r\n", "role", defs([{}]));
  // The same check holds for a mapping chosen by hand, not only one autoMatch made.
  const { header, records } = readCsv("name,Job,Title\r\nA,b,c\r\n");
  const byHand = [{ kind: "builtin", key: "name" }, { kind: "field", key: "role" }, { kind: "field", key: "role" }] as const;
  assert.throws(() => mapRows(peopleModule, records, [...byHand], header), /names "role" twice/);
  assert.throws(() => planCsv(peopleModule, "email,lead_status\r\n", [], PLAIN), {
    message:
      'The first line must be a header row naming the columns, with at least "name" (name, email, phone, business, source, notes). ' +
      "Add one and try again.",
  });
});

test("messy Excel file plans like the clean one", () => {
  const clean = "name,email,notes\nRobin Sample,robin@example.com,=SUM(1)\nCasey Placeholder,,call back\n";
  const messy =
    "﻿name,EMAIL,notes,colour,colour,   \r\n" +
    "Robin Sample,robin@example.com,'=SUM(1),blue,red,\r\n" +
    "Casey Placeholder,,call back,,,\r\n" +
    "\r\n";
  const want = planCsv(peopleModule, clean, [], PLAIN);
  const got = planCsv(peopleModule, messy, [], PLAIN);
  assert.deepEqual(got.create, want.create);
  assert.equal(got.create[0]?.notes, "=SUM(1)", "the export's formula guard comes off");
  assert.deepEqual(want.skipped, []);
  assert.deepEqual(got.skipped, [{ line: 4, reason: "empty row" }], "the trailing empty line is an empty row, not an error");
  assert.deepEqual(got.skippedColumns, ["colour", "colour"], "unknown names may repeat; a header of only spaces is ignored");
  assert.throws(() => planCsv(peopleModule, messy.replace("colour,colour", "email,colour"), [], PLAIN), /names "email" twice/);
});

interface FakeTaskPlan {
  tasks: { line: number; title: string; due: string | null }[];
  skipped: { line: number; reason: string }[];
}

/** A module the engine has never seen: each row becomes a task on one contact (the ctx). */
const fakeTasks: ImportModule<string, FakeTaskPlan> = {
  key: "tasks",
  noun: { one: "task", many: "tasks" },
  entity: null,
  columns: [
    { key: "title", label: "Title", aliases: ["to do"], limit: 500, multiline: false, required: true },
    { key: "due", label: "Due", aliases: [], limit: 10, multiline: false },
  ],
  plan(rows) {
    const plan: FakeTaskPlan = { tasks: [], skipped: [] };
    for (const { line, values } of rows) {
      const title = values.title ?? null;
      if (title === null) plan.skipped.push({ line, reason: "no title" });
      else plan.tasks.push({ line, title, due: values.due ?? null });
    }
    return plan;
  },
  change(plan, contactId, now) {
    const stamp = now.toISOString();
    const changes: RowChange[] = plan.tasks.map((task, i) => {
      const row: TaskRow = {
        id: `tk_fake${i}`,
        deal_id: null,
        contact_id: contactId,
        title: task.title,
        due_at: task.due,
        done_at: null,
        snoozed_until: null,
        source: "owner",
        untrusted_fields: '["title"]',
        version: 1,
        created_at: stamp,
        updated_at: stamp,
      };
      return { table: "tasks", id: row.id, before: null, after: row };
    });
    const first = changes[0];
    if (!first) return null;
    return { target: { table: "tasks", id: first.id }, summary: `Imported ${changes.length} tasks`, changes };
  },
};

test("a module definition is all a new module needs", async () => {
  const csv = "To Do,due,colour\r\nCall the bakery,2026-12-01,blue\r\n,2026-12-02,\r\n";
  const plan = planCsv(fakeTasks, csv, "ct_pat", PLAIN);
  assert.deepEqual(plan, {
    tasks: [{ line: 2, title: "Call the bakery", due: "2026-12-01" }],
    skipped: [{ line: 3, reason: "no title" }],
    skippedColumns: ["colour"],
  });
  assert.throws(() => planCsv(fakeTasks, "due\r\n2026-12-01\r\n", "ct_pat", PLAIN), {
    message: 'The first line must be a header row naming the columns, with at least "title" (title, due). Add one and try again.',
  });
  assert.throws(() => planCsv(fakeTasks, "", "ct_pat", PLAIN), {
    message: "The CSV file is empty. Export your tasks with a header row and try again.",
  });

  const db = await createTestDb();
  db.exec(`INSERT INTO contacts (id, name, untrusted_fields) VALUES ('ct_pat', 'Pat Example', '[]')`);
  const input = fakeTasks.change(plan, "ct_pat", NOW);
  assert.ok(input);
  runFile(db, renderImport({ ...input, changeId: "chg_faketasks01" }, NOW).sql);
  const tasks = (await db.prepare("SELECT * FROM tasks").all<TaskRow>()).results;
  assert.deepEqual(tasks.map((row) => [row.title, row.contact_id, row.due_at]), [["Call the bakery", "ct_pat", "2026-12-01"]]);
  const audit = await db.prepare("SELECT * FROM audit_log").first<AuditRow>();
  assert.equal(audit?.tool, "import");
  assert.equal(audit?.summary, "Imported 1 tasks (change chg_faketasks01)");
});

test("the notes and new_field targets are not supported yet", () => {
  const { header, records } = readCsv("name,Extra\r\nA,b\r\n");
  assert.throws(() => mapRows(peopleModule, records, [{ kind: "builtin", key: "name" }, { kind: "notes", label: "Extra" }], header), /not supported yet/);
  assert.throws(() => mapRows(peopleModule, records, [{ kind: "builtin", key: "name" }, { kind: "new_field", label: "Extra" }], header), /not supported yet/);
});

test("readCsv takes at most 2,000 data rows and 1 MB, and says how to split a bigger file", () => {
  assert.equal(IMPORT_MAX_ROWS, 2_000);
  assert.equal(IMPORT_MAX_BYTES, 1_048_576);
  const rows = (n: number) => ["name", ...Array.from({ length: n }, (_, i) => `Person ${i}`)].join("\r\n");
  const refused = (text: string, message: string) =>
    assert.throws(() => readCsv(text), (error: unknown) => error instanceof UserError && error.message === message);

  assert.equal(readCsv(rows(2_000)).records.length, 2_000);
  assert.equal(readCsv(`${rows(2_000)}\r\n\r\n,\r\n`).records.length, 2_002, "blank lines are not data rows");
  refused(rows(2_431), "This file has 2,431 rows. One import takes at most 2,000. Split it into two files and import each one.");
  refused(rows(2_001), "This file has 2,001 rows. One import takes at most 2,000. Split it into two files and import each one.");
  refused(rows(4_001), "This file has 4,001 rows. One import takes at most 2,000. Split it into three files and import each one.");

  const wide = `name,notes\r\n${Array.from({ length: 1_000 }, (_, i) => `P${i},${"n".repeat(1_440)}`).join("\r\n")}`;
  assert.ok(wide.length > 1.3 * IMPORT_MAX_BYTES && wide.length <= 1.4 * IMPORT_MAX_BYTES);
  refused(wide, "This file is 1.4 MB. One import takes at most 1 MB. Split it into smaller files and import each one.");
  const justOver = `name\r\n${"é".repeat(IMPORT_MAX_BYTES / 2)}`;
  refused(justOver, "This file is 1.1 MB. One import takes at most 1 MB. Split it into smaller files and import each one.");
  assert.doesNotThrow(() => readCsv(`name\r\n${"x".repeat(IMPORT_MAX_BYTES - 6)}`), "exactly 1 MB is fine");
});
