import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "../db/sqlite-d1.ts";
import {
  csvFilename,
  EXPORT_COLUMNS,
  EXPORT_HIDDEN_COLUMNS,
  EXPORT_ROWS_PER_CHUNK,
  EXPORT_TABLES,
  exportAll,
  exportJsonChunks,
  exportTableCsv,
  type ExportTable,
  type FullExport,
  jsonFilename,
  safeFileName,
} from "./export.ts";

const UNSAFE_PARTS = ['2026"-11-19', "2026-11-19\r\nSet-Cookie: x=1", "../2026-11-19", "2026/11/19", "2026\\11\\19", "2026 11 19", "2026;11"];

test("the export holds every table of the copy's data, time tracking's three included (decision 0049)", () => {
  assert.deepEqual(
    [...EXPORT_TABLES],
    [
      "contacts",
      "deals",
      "project_statuses",
      "projects",
      "activities",
      "tasks",
      "time_entries",
      "work_types",
      "client_rates",
      "campaigns",
      "campaign_steps",
      "campaign_recipients",
      "email_suppressions",
      "stages",
      "person_statuses",
      "person_substatuses",
      "field_defs",
      "views",
      "rules",
      "rule_firings",
      "rulebook",
      "settings",
      "audit_log",
      "audit_parts",
      "briefs",
      "email_log",
    ],
  );
});

test("the recipients export, JSON and CSV, never holds an unsubscribe token, empty or not", async () => {
  const db = await createTestDb();
  const emptyCsv = await exportTableCsv(db, "campaign_recipients");
  assert.ok(emptyCsv.startsWith("id,campaign_id,step_id,contact_id,email,"), "the header row is there when empty");
  assert.doesNotMatch(emptyCsv, /unsub_token/);
  db.exec("INSERT INTO contacts (id, name, email) VALUES ('ct_a', 'Pat Example', 'pat@example.com')");
  db.exec("INSERT INTO campaigns (id, name, audience) VALUES ('cp_a', 'Autumn', '{}')");
  db.exec("INSERT INTO campaign_steps (id, campaign_id, position, subject, body) VALUES ('cs_a', 'cp_a', 1, 'Hi', 'Hello')");
  db.exec(
    "INSERT INTO campaign_recipients (id, campaign_id, step_id, contact_id, email, status, unsub_token) VALUES ('rc_a', 'cp_a', 'cs_a', 'ct_a', 'pat@example.com', 'queued', 'secret-token-value')",
  );
  const csv = await exportTableCsv(db, "campaign_recipients");
  assert.match(csv, /rc_a/);
  assert.doesNotMatch(csv, /unsub_token|secret-token-value/);
  const full = JSON.stringify((await exportAll(db, new Date("2026-11-24T18:00:00.000Z"))).tables);
  assert.match(full, /rc_a/);
  assert.doesNotMatch(full, /unsub_token|secret-token-value/);
  assert.deepEqual(EXPORT_HIDDEN_COLUMNS, { campaign_recipients: ["unsub_token"] });
  const info = (await db.prepare("PRAGMA table_info(campaign_recipients)").all<{ name: string }>()).results.map((c) => c.name);
  assert.deepEqual([...(EXPORT_COLUMNS.campaign_recipients ?? []), "unsub_token"].sort(), [...info].sort(), "no column is left out by mistake");
});

test("the projects, their statuses and every project_id column are in the JSON and the CSVs", async () => {
  const db = await createTestDb();
  db.exec("INSERT INTO contacts (id, name, email) VALUES ('ct_a', 'Pat Example', 'pat@example.com')");
  db.exec("INSERT INTO projects (id, name, contact_id) VALUES ('pj_a', 'Website', 'ct_a')");
  db.exec("INSERT INTO tasks (id, title, project_id) VALUES ('tk_a', 'Plan', 'pj_a')");
  db.exec("INSERT INTO activities (id, type, summary, occurred_at, actor, contact_id, project_id) VALUES ('ac_a', 'note', 'Called', '2026-11-03T17:00:00.000Z', 'owner', 'ct_a', 'pj_a')");
  db.exec("INSERT INTO time_entries (id, started_at, project_id) VALUES ('te_a', '2026-11-03T17:00:00.000Z', 'pj_a')");
  const tables = (await exportAll(db, new Date("2026-11-24T18:00:00.000Z"))).tables;
  assert.equal(tables.projects[0]?.name, "Website");
  assert.deepEqual(tables.project_statuses.map((row) => row.key).sort(), ["active", "done", "on_hold"]);
  assert.match(await exportTableCsv(db, "projects"), /pj_a,Website,ct_a/);
  assert.match(await exportTableCsv(db, "project_statuses"), /^key,label,/);
  for (const table of ["tasks", "activities", "time_entries"] as const) {
    const csv = await exportTableCsv(db, table);
    assert.match(csv.split("\r\n")[0] ?? "", /(^|,)project_id(,|$)/, table);
    assert.match(csv, /pj_a/, table);
  }
});

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
  assert.ok(text.endsWith('\n    "briefs": [],\n    "email_log": []\n  }\n}\n'));
  // The header, each table's opening and closing, the contacts' rows in three pieces, and the end.
  assert.equal(pieces.length, 1 + EXPORT_TABLES.length * 2 + 3 + 1);
});
