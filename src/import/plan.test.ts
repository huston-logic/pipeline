import assert from "node:assert/strict";
import { test } from "node:test";
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
    { line: 2, name: "Robin Sample", email: "robin@example.com", phone: "555 0100", business: null, source: null, notes: "hi" },
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
