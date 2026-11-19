import assert from "node:assert/strict";
import { test } from "node:test";
import {
  csvFilename,
  EXPORT_ROWS_PER_CHUNK,
  EXPORT_TABLES,
  exportJsonChunks,
  type ExportTable,
  type FullExport,
  jsonFilename,
  safeFileName,
} from "./export.ts";

const UNSAFE_PARTS = ['2026"-11-19', "2026-11-19\r\nSet-Cookie: x=1", "../2026-11-19", "2026/11/19", "2026\\11\\19", "2026 11 19", "2026;11"];

test("export file names are letters, digits, dots, dashes and underscores only", () => {
  assert.equal(jsonFilename("2026-11-19"), "pipeline-export-2026-11-19.json");
  for (const table of EXPORT_TABLES) assert.match(csvFilename(table, "2026-11-19"), /^pipeline-[a-z_]+-2026-11-19\.csv$/);
  assert.equal(safeFileName("acme-2026-11-19"), "acme-2026-11-19");
  for (const bad of [...UNSAFE_PARTS, "", ".hidden", "-rf", "a..b"]) {
    assert.throws(() => safeFileName(bad), /isn't a safe file name/, JSON.stringify(bad));
  }
  for (const bad of UNSAFE_PARTS) {
    assert.throws(() => jsonFilename(bad), /isn't a safe file name/, JSON.stringify(bad));
    assert.throws(() => csvFilename("contacts", bad), /isn't a safe file name/, JSON.stringify(bad));
  }
  assert.throws(() => csvFilename('contacts"; x' as ExportTable, "2026-11-19"), /isn't a safe file name/);
});

test("the refusal never repeats a line break from the name", () => {
  assert.throws(
    () => safeFileName("a\r\nb"),
    (error: unknown) => error instanceof Error && !/[\r\n]/.test(error.message),
  );
});

test("the JSON export's pieces join into the export, one row per line, empty tables as []", () => {
  const tables = Object.fromEntries(EXPORT_TABLES.map((table) => [table, []])) as unknown as FullExport["tables"];
  tables.contacts = Array.from({ length: EXPORT_ROWS_PER_CHUNK * 2 + 1 }, (_, i) => ({ id: `ct_${i}`, name: `Line "${i}"\n` }));
  const full: FullExport = { exportedAt: "2026-11-19T18:00:00.000Z", tables };
  const pieces = [...exportJsonChunks(full)];
  const text = pieces.join("");
  assert.deepEqual(JSON.parse(text), full);
  assert.ok(
    text.startsWith('{\n  "exportedAt": "2026-11-19T18:00:00.000Z",\n  "tables": {\n    "contacts": [\n      {"id":"ct_0","name":"Line \\"0\\"\\n"},\n'),
  );
  assert.match(text, /\n {4}"deals": \[\],\n/);
  assert.ok(text.endsWith('\n    "briefs": []\n  }\n}\n'));
  // The header, each table's opening and closing, the contacts' rows in three pieces, and the end.
  assert.equal(pieces.length, 1 + EXPORT_TABLES.length * 2 + 3 + 1);
});
