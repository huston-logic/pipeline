import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv, toCsv } from "./csv.ts";

const LONG = "x".repeat(9_990) + ", \"end\"";

test("writes a header row from the column names, CRLF line ends, and null as an empty field", () => {
  const out = toCsv([
    { id: "ct_1", name: "Pat Example", value: 1500, notes: null },
    { id: "ct_2", name: "Robin Sample", value: null, notes: undefined },
  ]);
  assert.equal(out, "id,name,value,notes\r\nct_1,Pat Example,1500,\r\nct_2,Robin Sample,,\r\n");
});

test("quotes fields with a comma, quote, CR or LF, and doubles the quotes inside", () => {
  const out = toCsv([{ a: "one, two", b: 'say "hi"', c: "line\nbreak", d: "carriage\rreturn", e: "plain" }]);
  assert.equal(out, 'a,b,c,d,e\r\n"one, two","say ""hi""","line\nbreak","carriage\rreturn",plain\r\n');
});

test("formula guard: a cell starting with =, +, -, @, tab or CR gets a leading apostrophe", () => {
  const cells = ["=SUM(A1:A2)", "+1", "-2", "@cmd", "\tTab", "\rCR", "safe = text", "'already"];
  const out = toCsv(cells.map((value) => ({ value })));
  const parsed = parseCsv(out).slice(1).map(([cell]) => cell);
  assert.deepEqual(parsed, ["'=SUM(A1:A2)", "'+1", "'-2", "'@cmd", "'\tTab", "'\rCR", "safe = text", "'already"]);
  assert.match(out, /\r\n"'\rCR"\r\n/, "a guarded CR cell is still quoted");
});

test("numbers are written as numbers and never guarded; objects as JSON", () => {
  assert.equal(toCsv([{ n: -5, f: 1.25, o: { a: 1 }, b: true }]), 'n,f,o,b\r\n-5,1.25,"{""a"":1}",true\r\n');
});

test("an explicit column list sets the header and order, so an empty table still has its header", () => {
  assert.equal(toCsv([], ["id", "name"]), "id,name\r\n");
  assert.equal(toCsv([{ name: "Pat", id: "ct_1", extra: "ignored" }], ["id", "name"]), "id,name\r\nct_1,Pat\r\n");
  assert.equal(toCsv([]), "");
});

test("header names are quoted like any other field", () => {
  assert.equal(toCsv([{ "a,b": 1 }]), '"a,b"\r\n1\r\n');
});

test("round trip: commas, quotes, newlines, emoji, a leading BOM and 10,000-character values come back unchanged", () => {
  const rows = [
    { id: "ct_1", name: "Pat, Example", notes: 'She said "call me", then left.' },
    { id: "ct_2", name: "Robin\r\nSample", notes: "line one\nline two\r\nline three\rline four" },
    { id: "ct_3", name: "Casey 🌱 Placeholder 👩🏽‍💻", notes: "naïve café — ünïcödé" },
    { id: "ct_4", name: "﻿Jordan Fake", notes: "﻿ starts with a byte order mark" },
    { id: "ct_5", name: LONG, notes: "" },
    { id: "ct_6", name: "", notes: '""' },
  ];
  const out = toCsv(rows);
  const [header, ...records] = parseCsv(out);
  assert.deepEqual(header, ["id", "name", "notes"]);
  assert.deepEqual(
    records,
    rows.map((row) => [row.id, row.name, row.notes]),
  );
  assert.equal(records[4]?.[1]?.length, LONG.length);
});

test("parseCsv drops one byte order mark at the very start of a file and reads LF-only files", () => {
  assert.deepEqual(parseCsv("﻿id,name\r\nct_1,Pat\r\n"), [
    ["id", "name"],
    ["ct_1", "Pat"],
  ]);
  assert.deepEqual(parseCsv("id,name\nct_1,Pat"), [
    ["id", "name"],
    ["ct_1", "Pat"],
  ]);
  assert.deepEqual(parseCsv(""), []);
  assert.deepEqual(parseCsv('a\r\n""\r\n'), [["a"], [""]]);
});

test("parseCsv refuses an unclosed quote instead of guessing", () => {
  assert.throws(() => parseCsv('a\r\n"open'), /quote/);
});
