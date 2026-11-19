import assert from "node:assert/strict";
import { test } from "node:test";
import { csvFilename, EXPORT_TABLES, type ExportTable, jsonFilename, safeFileName } from "./export.ts";

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
