// A mapping chosen by the owner on the board (decision 0036): Add to notes, New field, and the checks mapRows runs on a
// mapping it did not make itself.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContactRow, FieldDefRow } from "../db/db.ts";
import { createTestDb, type SqliteD1 } from "../db/sqlite-d1.ts";
import { commitChange } from "../services/change.ts";
import { UserError } from "../services/errors.ts";
import { undoChange } from "../services/undo.ts";
import { IMPORT_ACTOR } from "./change.ts";
import { fileChange, type ImportOptions, mapFile, MappingError, mapRows, readCsv, type Target } from "./engine.ts";
import { peopleModule } from "./modules/people.ts";

const NOW = new Date("2026-11-22T18:00:00.000Z");
const LATER = new Date("2026-11-22T19:00:00.000Z");

const field = (row: Partial<FieldDefRow>): FieldDefRow => ({
  id: "fd_role",
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
});

const builtin = (key: string): Target => ({ kind: "builtin", key });

function planned(csv: string, targets: Target[], existing: ContactRow[], fieldDefs: FieldDefRow[] = [], options: Partial<ImportOptions> = {}) {
  const mapped = mapFile(peopleModule, csv, targets, fieldDefs, NOW);
  const plan = peopleModule.plan(mapped.rows, existing, {
    asLeads: false,
    allowDuplicates: false,
    ...options,
    fieldDefs: mapped.fieldDefs,
  });
  return { mapped, plan };
}

const contacts = async (db: SqliteD1) =>
  (await db.prepare("SELECT * FROM contacts ORDER BY id").all<ContactRow>()).results.map((row) => ({ ...row }));

async function withPat(notes: string | null = null): Promise<SqliteD1> {
  const db = await createTestDb();
  db.prepare(
    `INSERT INTO contacts (id, name, email, notes, untrusted_fields, created_at, updated_at)
     VALUES ('ct_pat', 'Pat Example', 'pat@example.com', ?, '[]', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
  )
    .bind(notes)
    .run();
  return db;
}

test("mapRows refuses a field that is missing, archived or a deal field, and a mapping that doesn't fit the header", () => {
  const { header, records } = readCsv("name,Job\r\nPat,Baker\r\n");
  const refused = (targets: Target[], fieldDefs: FieldDefRow[], message: RegExp) =>
    assert.throws(
      () => mapRows(peopleModule, records, targets, header, fieldDefs),
      (error: unknown) => error instanceof UserError && message.test(error.message),
    );
  const toRole: Target[] = [builtin("name"), { kind: "field", key: "role" }];
  refused(toRole, [], /^The "Job" column goes to the field role, which isn't a contact field you can fill/);
  refused(toRole, [field({ archived: 1 })], /^The "Job" column goes to the field role/);
  refused(toRole, [field({ entity: "deal" })], /^The "Job" column goes to the field role/);
  assert.doesNotThrow(() => mapRows(peopleModule, records, toRole, header, [field({})]));
  refused([builtin("name")], [], /^The column matches don't fit this file: it has 2 columns and 1 was matched\. Match the columns again\.$/);
  refused([builtin("name"), { kind: "skip" }, { kind: "skip" }], [], /it has 2 columns and 3 were matched/);
});

test('"Add to notes" writes Label: value lines, after any notes column, and a second import adds nothing', () => {
  const csv = "name,email,notes,Referred by,Met at\r\nRobin Sample,robin@example.com,call back,Pat,the fair\r\nCasey,,,,\r\n";
  const targets: Target[] = [
    builtin("name"),
    builtin("email"),
    builtin("notes"),
    { kind: "notes", label: "Referred by" },
    { kind: "notes", label: "Met at" },
  ];
  const { plan } = planned(csv, targets, []);
  assert.deepEqual(
    plan.create.map((row) => row.notes),
    ["call back\nReferred by: Pat\nMet at: the fair", null],
  );

  const robin = { id: "ct_robin", email: "robin@example.com", phone: null, business: null, source: null, notes: "call back", fields: "{}" };
  const merged = planned(csv, targets, [robin as unknown as ContactRow]).plan;
  assert.deepEqual(merged.merge, [{ id: "ct_robin", line: 2, changes: { notes: "call back\nReferred by: Pat\nMet at: the fair" } }]);
  const again = { ...robin, notes: "call back\nReferred by: Pat\nMet at: the fair" };
  assert.deepEqual(planned(csv, targets, [again as unknown as ContactRow]).plan.unchanged, [{ line: 2, id: "ct_robin" }]);

  assert.throws(() => planned(csv, [...targets.slice(0, 3), { kind: "notes", label: "  " }, { kind: "skip" }], []), (error: unknown) =>
    error instanceof MappingError && error.column === 3 && /notes label for the "Referred by" column/.test(error.message),
  );
});

test("notes that would pass 10,000 characters skip the row, naming the column, never the value", () => {
  const long = "x".repeat(9_995);
  const { plan } = planned(`name,notes,Extra\r\nRobin,${long},secret-value\r\n`, [builtin("name"), builtin("notes"), { kind: "notes", label: "Extra" }], []);
  assert.deepEqual(plan.skipped, [{ line: 2, reason: "notes is longer than 10000 characters" }]);
});

test("New field: addField's label rules and key; refused when a live field has that key or label", () => {
  const csv = "name,Budget,Team size\r\nRobin,500,4\r\n";
  const targets: Target[] = [builtin("name"), { kind: "new_field", label: "Budget" }, { kind: "new_field", label: " Team size " }];
  const { mapped, plan } = planned(csv, targets, [], [field({ key: "budget", label: "Old budget", archived: 1, id: "fd_old" })]);
  assert.deepEqual(
    mapped.newFields.map((row) => [row.entity, row.key, row.label, row.type, row.archived]),
    [
      ["contact", "budget_2", "Budget", "text", 0],
      ["contact", "team_size", "Team size", "text", 0],
    ],
    "an archived key is never reused",
  );
  assert.deepEqual(plan.create[0]?.fields, { budget_2: "500", team_size: "4" });

  const refused = (fieldDefs: FieldDefRow[], label: string, message: RegExp) =>
    assert.throws(
      () => mapFile(peopleModule, csv, [builtin("name"), { kind: "new_field", label }, { kind: "skip" }], fieldDefs, NOW),
      (error: unknown) => error instanceof MappingError && error.column === 1 && message.test(error.message),
    );
  refused([field({ key: "budget", label: "Money" })], "Budget", /^There's already a contact field with the key budget \(Money\)\. Choose it for the "Budget" column/);
  refused([field({ key: "spend", label: "Budget" })], "budget", /^There's already a contact field called Budget \(spend\)\. Pick a different label\.$/);
  refused([], "", /^A field needs a label/);
  refused([], "x".repeat(61), /^A field label can be at most 60 characters/);
  refused([], "!!!", /has no letters or numbers/);
  assert.throws(
    () => mapFile(peopleModule, csv, [builtin("name"), { kind: "new_field", label: "Budget" }, { kind: "new_field", label: "budget" }], [], NOW),
    (error: unknown) => error instanceof MappingError && error.column === 2,
    "two columns can't make the same field",
  );
});

test("a New field is created in the import's own change, before the contacts; undo removes it, also after filling it on people on file", async () => {
  const db = await withPat();
  const csv = "name,email,Budget\r\nPat Example,pat@example.com,500\r\nRobin Sample,robin@example.com,700\r\n";
  const targets: Target[] = [builtin("name"), builtin("email"), { kind: "new_field", label: "Budget" }];
  const existing = await contacts(db);
  const { mapped, plan } = planned(csv, targets, existing);
  const input = fileChange(peopleModule, plan, existing, NOW, mapped.newFields);
  assert.ok(input);
  assert.deepEqual(
    input.changes.map((change) => change.table),
    ["field_defs", "contacts", "contacts"],
  );
  assert.equal(input.summary, "Imported 1 contact and filled details on 1; added 1 contact field");
  const result = await commitChange({ db, now: NOW, ...IMPORT_ACTOR }, input);

  const defs = (await db.prepare("SELECT key, label, type FROM field_defs").all()).results.map((row) => ({ ...row }));
  assert.deepEqual(defs, [{ key: "budget", label: "Budget", type: "text" }]);
  const after = await contacts(db);
  assert.deepEqual(
    after.map((row) => [row.email, JSON.parse(row.fields)]).sort(),
    [
      ["pat@example.com", { budget: "500" }],
      ["robin@example.com", { budget: "700" }],
    ],
  );
  for (const row of after) assert.ok((JSON.parse(row.untrusted_fields) as string[]).includes("budget"), "outside text");

  await undoChange({ db, now: LATER, actor: "owner", tool: "undo_change" }, result.changeId);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM field_defs").first("n"), 0);
  assert.deepEqual(
    (await contacts(db)).map((row) => [row.id, row.fields]),
    [["ct_pat", "{}"]],
  );
});

test("undo still refuses to remove a New field that a person outside the import uses since", async () => {
  const db = await withPat();
  const csv = "name,email,Budget\r\nRobin Sample,robin@example.com,700\r\n";
  const existing = await contacts(db);
  const { mapped, plan } = planned(csv, [builtin("name"), builtin("email"), { kind: "new_field", label: "Budget" }], existing);
  const input = fileChange(peopleModule, plan, existing, NOW, mapped.newFields);
  assert.ok(input);
  const result = await commitChange({ db, now: NOW, ...IMPORT_ACTOR }, input);
  db.exec(`UPDATE contacts SET fields = '{"budget":"9"}', version = version + 1 WHERE id = 'ct_pat'`);
  await assert.rejects(undoChange({ db, now: LATER, actor: "owner", tool: "undo_change" }, result.changeId), /Budget is set on contact Pat Example/);
});
