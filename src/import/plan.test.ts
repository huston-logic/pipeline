import assert from "node:assert/strict";
import { test } from "node:test";
import type { FieldDefRow } from "../db/db.ts";
import { type ExistingContact, IMPORT_LIMITS, planImport } from "./plan.ts";

const pat: ExistingContact = {
  id: "ct_pat",
  email: "Pat@Example.com",
  phone: null,
  business: "Sample Bakery",
  source: "",
  notes: null,
};

test("a header row is required: names columns case-insensitively and lists unknown ones as skipped", () => {
  const plan = planImport("Name,EMAIL, Phone ,Favourite colour,notes\r\nRobin Sample,robin@example.com,555 0100,blue,hi\r\n", []);
  assert.deepEqual(plan.skippedColumns, ["Favourite colour"]);
  assert.deepEqual(plan.create, [
    {
      line: 2,
      id: null,
      name: "Robin Sample",
      email: "robin@example.com",
      phone: "555 0100",
      business: null,
      source: null,
      notes: "hi",
      leadStatus: null,
      fields: {},
    },
  ]);
  assert.throws(() => planImport("", []), /empty/);
  assert.throws(() => planImport("Robin Sample,robin@example.com\r\n", []), /header row/);
  assert.throws(() => planImport("name,email,Name\r\n", []), /"name" twice/);
});

test("a leading byte order mark is ignored, so the first column is still found", () => {
  const plan = planImport("﻿name,email\r\nRobin Sample,robin@example.com\r\n", []);
  assert.equal(plan.create[0]?.name, "Robin Sample");
});

test("strips the export's formula guard only before = + - @ tab or CR", () => {
  const csv = [
    "name,business,notes,source",
    `'=Casey Formula,'+1 Plus,"'-call back",'@home`,
    `'Tab,"'\tlead",'Quoted text,"it's fine"`,
  ].join("\r\n");
  const [first, second] = planImport(csv, []).create;
  assert.deepEqual(
    { name: first?.name, business: first?.business, notes: first?.notes, source: first?.source },
    { name: "=Casey Formula", business: "+1 Plus", notes: "-call back", source: "@home" },
  );
  assert.deepEqual(
    { name: second?.name, business: second?.business, notes: second?.notes, source: second?.source },
    { name: "'Tab", business: "lead", notes: "'Quoted text", source: "it's fine" },
  );
});

test("matches existing contacts by email ignoring case and fills only their empty fields", () => {
  const csv = "name,email,phone,business,source,notes\r\nSomeone Else,pat@example.com,555 0101,Other Shop,fair,met at the fair\r\n";
  const plan = planImport(csv, [pat]);
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.merge, [
    { id: "ct_pat", line: 2, changes: { phone: "555 0101", source: "fair", notes: "met at the fair" } },
  ]);
});

test("a match with nothing to fill is listed as unchanged, not merged", () => {
  const full: ExistingContact = { ...pat, phone: "1", source: "x", notes: "y" };
  const plan = planImport("name,email,business\r\nPat,PAT@example.com,Different\r\n", [full]);
  assert.deepEqual(plan.merge, []);
  assert.deepEqual(plan.unchanged, [{ line: 2, id: "ct_pat" }]);
});

test("skips rows with no name, a bad email, a repeated email, too-long values or nothing in them, with line numbers", () => {
  const csv = [
    "name,email,notes",
    ",nobody@example.com,",
    "Robin Sample,not-an-email,",
    'Casey Placeholder,casey@example.com,"two',
    'lines"',
    "Casey Again,CASEY@example.com,",
    `Long Notes,long@example.com,${"x".repeat(IMPORT_LIMITS.notes + 1)}`,
    ",,",
    "Jordan Fake,,no email is fine",
  ].join("\r\n");
  const plan = planImport(csv, []);
  assert.deepEqual(plan.skipped, [
    { line: 2, reason: "no name" },
    { line: 3, reason: "the email doesn't look like an email address" },
    { line: 6, reason: "the same email as line 4" },
    { line: 7, reason: `notes is longer than ${IMPORT_LIMITS.notes} characters` },
    { line: 8, reason: "empty row" },
  ]);
  assert.deepEqual(
    plan.create.map((row) => [row.line, row.name]),
    [
      [4, "Casey Placeholder"],
      [9, "Jordan Fake"],
    ],
  );
  assert.equal(plan.create[0]?.notes, "two\r\nlines");
});

test("single-line fields lose line breaks and control characters; notes keep their line breaks", () => {
  const csv = 'name,business,notes\r\n"  Robin\r\nSample ","Shop\u0007 Two","first\nsecond\u0000"\r\n';
  const [row] = planImport(csv, []).create;
  assert.deepEqual({ name: row?.name, business: row?.business, notes: row?.notes }, {
    name: "Robin Sample",
    business: "Shop Two",
    notes: "first\nsecond",
  });
});

test("an unclosed quote stops the import with a plain message", () => {
  assert.throws(() => planImport('name\r\n"open', []), /quote/);
});

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
const LEADS = { asLeads: true, allowDuplicates: false, fieldDefs: [] as FieldDefRow[] };

test("--as leads: created rows are New; without it no status is set", () => {
  const csv = "name,email\r\nRobin Sample,robin@example.com\r\n";
  assert.equal(planImport(csv, [], LEADS).create[0]?.leadStatus, "new");
  assert.equal(planImport(csv, []).create[0]?.leadStatus, null);
});

test("a lead_status column is used only when it is exactly a key or a label; otherwise the row is skipped", () => {
  const csv = [
    "name,email,lead_status",
    "A One,a@example.com,contacted",
    "B Two,b@example.com, Not a fit ",
    "C Three,c@example.com,Contacted!",
    "D Four,d@example.com,hot",
    "E Five,e@example.com,",
  ].join("\r\n");
  const plan = planImport(csv, [], LEADS);
  assert.deepEqual(
    plan.create.map((row) => [row.name, row.leadStatus]),
    [["A One", "contacted"], ["B Two", "not_a_fit"], ["E Five", "new"]],
  );
  assert.deepEqual(plan.skipped.map((row) => row.line), [4, 5]);
  assert.match(plan.skipped[0]?.reason ?? "", /^lead_status isn't a lead status/);
  assert.doesNotMatch(JSON.stringify(plan.skipped), /hot|Contacted!/, "outside text is not repeated");
  const without = planImport(csv.replace("C Three,c@example.com,Contacted!\r\nD Four,d@example.com,hot\r\n", ""), []);
  assert.ok(!without.skippedColumns.includes("lead_status"), "the column counts as imported without --as leads too");
  assert.deepEqual(without.create.map((row) => row.leadStatus), ["contacted", "not_a_fit", null]);
});

test("a merge never changes a person's status", () => {
  const plan = planImport("name,email,lead_status,phone\r\nPat,pat@example.com,bad,555 0101\r\n", [pat], LEADS);
  assert.deepEqual(plan.merge, [{ id: "ct_pat", line: 2, changes: { phone: "555 0101" } }]);
  assert.deepEqual(plan.create, []);
});

test("a column named like a contact field, by key or by label, fills that field; archived and deal fields do not", () => {
  const fieldDefs = defs([
    { key: "role", label: "Job title" },
    { key: "size", label: "Team size", type: "number" },
    { key: "old", label: "Old", archived: 1 },
    { key: "stage_note", label: "Deal note", entity: "deal" },
  ]);
  const csv = "name,ROLE,team size,Old,Deal note\r\nA One,Owner,4,x,y\r\nB Two,,,,\r\n";
  const plan = planImport(csv, [], { ...LEADS, fieldDefs });
  assert.deepEqual(plan.create[0]?.fields, { role: "Owner", size: 4 });
  assert.deepEqual(plan.create[1]?.fields, {});
  assert.deepEqual(plan.skippedColumns, ["Old", "Deal note"]);
  const byLabel = planImport("name,Job Title\r\nA One,Owner\r\n", [], { ...LEADS, fieldDefs });
  assert.deepEqual(byLabel.create[0]?.fields, { role: "Owner" });
});

test("a value that does not fit its field skips the row, naming the field by its label, not the value or the header", () => {
  const fieldDefs = defs([{ key: "size", label: "Team size", type: "number" }]);
  const plan = planImport("name,Team size\r\nA One,lots\r\nB Two,5\r\n", [], { ...LEADS, fieldDefs });
  assert.deepEqual(plan.skipped, [{ line: 2, reason: 'the "Team size" field needs a number' }]);
  assert.deepEqual(plan.create.map((row) => row.name), ["B Two"]);
  assert.throws(() => planImport("name,Role,role\r\nA,b,c\r\n", [], { ...LEADS, fieldDefs: defs([{}]) }), /twice/);
});

test("a merge fills only EMPTY custom fields, leaves a set one alone, and ignores the status column", () => {
  const fieldDefs = defs([{ key: "role", label: "Role" }, { key: "size", label: "Team size", type: "number" }]);
  const withRole: ExistingContact = { ...pat, fields: '{"role":"Owner"}' };
  const csv = "name,email,Role,Team size,lead_status,phone\r\nPat,pat@example.com,Manager,7,nonsense,555 0101\r\n";
  const plan = planImport(csv, [withRole], { ...LEADS, fieldDefs });
  assert.deepEqual(plan.merge, [{ id: "ct_pat", line: 2, changes: { phone: "555 0101" }, fields: { size: 7 } }]);
  assert.deepEqual(plan.skipped, [], "a status the merge would not use does not skip the row");
  const none = planImport("name,email,Role\r\nPat,pat@example.com,Manager\r\n", [withRole], { ...LEADS, fieldDefs });
  assert.deepEqual(none.unchanged, [{ line: 2, id: "ct_pat" }]);
  const bad = planImport("name,email,Team size,phone\r\nPat,pat@example.com,lots,555 0101\r\n", [withRole], { ...LEADS, fieldDefs });
  assert.deepEqual(bad.skipped, [{ line: 2, reason: 'the "Team size" field needs a number' }]);
  const set: ExistingContact = { ...withRole, fields: '{"size":3}' };
  const ignored = planImport("name,email,Team size,phone\r\nPat,pat@example.com,lots,555 0101\r\n", [set], { ...LEADS, fieldDefs });
  assert.equal(ignored.skipped.length, 0, "a value for a field that is already set is not checked");
});

test("a plain import whose rows get a status from the column also skips possible duplicates", () => {
  const csv = "name,business,lead_status\r\nA One,Sample Bakery,new\r\nB Two,Sample Bakery,\r\n";
  const plain = { asLeads: false, allowDuplicates: false, fieldDefs: [] as FieldDefRow[] };
  const plan = planImport(csv, [pat], plain);
  assert.deepEqual(plan.duplicates, [{ line: 2, ofId: "ct_pat", ofLine: null }]);
  assert.deepEqual(plan.create.map((row) => row.line), [3], "the row with no status is a plain contact");
  assert.equal(planImport(csv, [pat], { ...plain, allowDuplicates: true }).create.length, 2);
});

test("possible duplicates (no email, same business as someone on file or an earlier row) are listed and skipped unless allowed", () => {
  const csv = [
    "name,email,business",
    "A One,,  sample   BAKERY ",
    "B Two,,Fresh Co",
    "C Three,,fresh co",
    "D Four,d@example.com,Sample Bakery",
    "E Five,,",
  ].join("\r\n");
  const plan = planImport(csv, [pat], LEADS);
  assert.deepEqual(plan.duplicates, [
    { line: 2, ofId: "ct_pat", ofLine: null },
    { line: 4, ofId: null, ofLine: 3 },
  ]);
  assert.deepEqual(plan.create.map((row) => row.line), [3, 5, 6]);
  const allowed = planImport(csv, [pat], { ...LEADS, allowDuplicates: true });
  assert.deepEqual(allowed.duplicates, []);
  assert.deepEqual(allowed.create.map((row) => row.line), [2, 3, 4, 5, 6]);
  assert.deepEqual(planImport(csv, [pat]).duplicates, [], "only a leads import looks for duplicates");
});

test("an id column matches a contact on file before the email; an unmatched contact id is kept; anything else is ignored", () => {
  const robin: ExistingContact = { id: "ct_robin", email: "robin@example.com", phone: null, business: null, source: null, notes: null };
  const csv = [
    "id,name,email,phone,version,created_at",
    "ct_pat,Pat Example,robin@example.com,555 0101,3,2026-11-01",
    "ct_newone,Casey Placeholder,casey@example.com,,1,2026-11-01",
    "12345,Jordan Fake,jordan@example.com,,1,2026-11-01",
    "ct_newone,Casey Again,casey.again@example.com,,1,2026-11-01",
    "ct_other,Robin Sample,robin@example.com,555 0102,1,2026-11-01",
    ",Robin Twice,ROBIN@example.com,555 0103,1,2026-11-01",
  ].join("\r\n");
  const plan = planImport(csv, [pat, robin]);
  assert.deepEqual(plan.merge, [
    { id: "ct_pat", line: 2, changes: { phone: "555 0101" } },
    { id: "ct_robin", line: 6, changes: { phone: "555 0102" } },
  ], "by id first (the email is ignored), then by email with the unmatched id ignored");
  assert.deepEqual(plan.create.map((row) => [row.line, row.id]), [[3, "ct_newone"], [4, null]], "a kept id, and a new one for a non-id");
  assert.deepEqual(plan.skipped, [
    { line: 5, reason: "the same id as line 3" },
    { line: 7, reason: "the same email as line 6" },
  ]);
  assert.deepEqual(plan.skippedColumns, ["version", "created_at"], "bookkeeping columns are not imported");
});

test("bookkeeping columns of the export never fill a custom field of the same name", () => {
  const fieldDefs = defs([{ key: "version", label: "Version" }, { key: "created_at", label: "Created" }]);
  const plan = planImport("name,version,CREATED_AT,Created\r\nPat,3,2026-11-01,2026-11-02\r\n", [], { ...LEADS, fieldDefs });
  assert.deepEqual(plan.create[0]?.fields, { created_at: "2026-11-02" }, "only the column named like the field's label fills it");
  assert.deepEqual(plan.skippedColumns, ["version", "CREATED_AT"]);
});

test("the export's fields column fills live contact fields; a field column wins; other keys and bad cells are never echoed", () => {
  const fieldDefs = defs([{ key: "role", label: "Role" }, { key: "size", label: "Team size", type: "number" }, { key: "old", label: "Old", archived: 1 }]);
  const csv = [
    "name,email,fields,Role",
    `Robin,robin@example.com,"{""role"":""Baker"",""size"":4,""old"":""x"",""secret_key"":""Secret value""}",`,
    `Casey,casey@example.com,"{""role"":""Baker""}",Owner`,
    `Jordan,jordan@example.com,"{""size"":""lots""}",`,
    `Sam,sam@example.com,"[1,2]",`,
    `Alex,alex@example.com,not json,`,
    `Taylor,taylor@example.com,"{""role"":{""nested"":1}}",`,
    `Morgan,morgan@example.com,{},`,
  ].join("\r\n");
  const plan = planImport(csv, [], { ...LEADS, asLeads: false, fieldDefs });
  assert.deepEqual(plan.create.map((row) => [row.line, row.fields]), [
    [2, { role: "Baker", size: 4 }],
    [3, { role: "Owner" }],
    [8, {}],
  ]);
  assert.deepEqual(plan.skipped, [
    { line: 4, reason: 'the "Team size" field needs a number' },
    { line: 5, reason: "the fields column isn't valid" },
    { line: 6, reason: "the fields column isn't valid" },
    { line: 7, reason: "the fields column isn't valid" },
  ]);
  for (const { reason } of plan.skipped) assert.doesNotMatch(reason, /lots|nested|json|secret/i);

  const onFile: ExistingContact = { ...pat, email: "robin@example.com", id: "ct_robin", fields: '{"role":"Owner"}' };
  const merged = planImport(csv.split("\r\n").slice(0, 2).join("\r\n"), [onFile], { ...LEADS, fieldDefs });
  assert.deepEqual(merged.merge, [{ id: "ct_robin", line: 2, changes: {}, fields: { size: 4 } }], "a merge fills only the empty field");
});

test("a row the export marks archived is skipped and counted, never created or filled in", () => {
  const csv = "id,name,email,archived\r\nct_gone,Gail Gone,gail@example.com,1\r\nct_kept,Kim Kept,kim@example.com,0\r\n,Tara True,tara@example.com,TRUE\r\n";
  const onFile: ExistingContact = { ...pat, id: "ct_gone", email: "gail@example.com" };
  const plan = planImport(csv, [onFile]);
  assert.deepEqual(plan.skipped, [
    { line: 2, reason: "archived in the file" },
    { line: 4, reason: "archived in the file" },
  ]);
  assert.deepEqual(plan.archived, [2, 4]);
  assert.deepEqual(plan.create.map((row) => row.id), ["ct_kept"]);
  assert.deepEqual(plan.merge, []);
});
