// The Tasks import module (decision 0037): a task goes on a deal by deal_id, else on a person by contact_id, email or
// name; it never adds a person. An id that matches a task fills it in.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskRow } from "../../db/db.ts";
import { createTestDb, type SqliteD1 } from "../../db/sqlite-d1.ts";
import { commitChange } from "../../services/change.ts";
import { IMPORT_ACTOR } from "../change.ts";
import { mapCsv, planRows } from "../engine.ts";
import { tasksOnFile } from "../load.ts";
import { tasksModule } from "./tasks.ts";

const NOW = new Date("2026-11-23T18:00:00.000Z");

async function withRecords(): Promise<SqliteD1> {
  const db = await createTestDb();
  db.exec(`INSERT INTO contacts (id, name, email, untrusted_fields, archived) VALUES
    ('ct_pat', 'Pat Example', 'pat@example.com', '[]', 0),
    ('ct_robin', 'Robin Sample', 'robin@example.com', '[]', 0),
    ('ct_gone', 'Gail Gone', 'gail@example.com', '[]', 1)`);
  db.exec(`INSERT INTO deals (id, contact_id, title, stage_key, stage_entered_at, untrusted_fields) VALUES
    ('dl_pat', 'ct_pat', 'Boiler page', 'replied', '2026-11-02T00:00:00.000Z', '[]')`);
  db.exec(`INSERT INTO tasks (id, deal_id, contact_id, title, due_at, untrusted_fields) VALUES
    ('tk_onfile', 'dl_pat', 'ct_pat', 'Call Pat', NULL, '[]')`);
  return db;
}

async function plan(db: SqliteD1, csv: string) {
  const { rows } = mapCsv(tasksModule, csv, []);
  const ctx = await tasksOnFile(db, rows);
  return { ctx, plan: planRows(tasksModule, rows, ctx, { fieldDefs: [] }) };
}

const tasks = async (db: SqliteD1) => (await db.prepare("SELECT * FROM tasks ORDER BY rowid").all<TaskRow>()).results;

test("tasks: an unmatched row is skipped with a reason", async () => {
  const db = await withRecords();
  const csv = [
    "title,due,deal_id,contact_id,email,name,done_at",
    "Send the quote,2026-11-30,dl_pat,ct_robin,,,",
    "Ring Robin,2026-11-30T09:30,,,ROBIN@example.com,,",
    "Card for Pat,,,,,pat example,2026-11-20",
    "Secret task,,,ct_nobody,nobody@example.com,Secret Person,",
    "Secret task,,,ct_gone,,,",
    "Secret task,soon,,ct_pat,,,",
    "Secret task,,,ct_pat,,,yesterday",
    ",,,ct_pat,,,",
    "Secret task,,dl_nothere,ct_robin,robin@example.com,,",
  ].join("\r\n");
  const { ctx, plan: planned } = await plan(db, csv);
  assert.deepEqual(planned.skipped, [
    { line: 5, reason: "no person or deal matches" },
    { line: 6, reason: "contact ct_gone is archived" },
    { line: 7, reason: "due_at isn't a date like 2026-11-19" },
    { line: 8, reason: "done_at isn't a date like 2026-11-19" },
    { line: 9, reason: "no title" },
    { line: 10, reason: "deal dl_nothere isn't on file; import deals first" },
  ]);
  for (const { reason } of planned.skipped) assert.doesNotMatch(reason, /Secret|nobody|soon|yesterday/);
  assert.deepEqual(
    planned.create.map((row) => [row.line, row.dealId, row.contactId]),
    [
      [2, "dl_pat", "ct_pat"],
      [3, null, "ct_robin"],
      [4, null, "ct_pat"],
    ],
    "a deal wins and its own person is used; an email and a name match ignoring case; a deal id never falls back to the person",
  );
  const input = tasksModule.change(planned, ctx, NOW);
  assert.ok(input);
  const result = await commitChange({ db, now: NOW, ...IMPORT_ACTOR }, input);
  assert.equal(result.summary, `Imported 3 tasks and filled details on 0 (change ${result.changeId})`);
  const added = (await tasks(db)).filter((task) => task.id !== "tk_onfile");
  assert.deepEqual(
    added.map((task) => [task.title, task.due_at, task.done_at, task.source, JSON.parse(task.untrusted_fields)]),
    [
      ["Send the quote", "2026-11-30T08:00:00.000Z", null, "owner", ["title", "due_at"]],
      ["Ring Robin", "2026-11-30T17:30:00.000Z", null, "owner", ["title", "due_at"]],
      ["Card for Pat", null, "2026-11-20T08:00:00.000Z", "owner", ["title", "done_at"]],
    ],
  );
});

test("tasks: an id that matches a task fills an empty due date only; an unmatched task id is kept", async () => {
  const db = await withRecords();
  const csv = "id,title,due_at,deal_id,snoozed_until,source\r\ntk_onfile,Other title,2026-12-01,dl_pat,,owner\r\ntk_fromcopy,Call Pat,,dl_pat,,owner\r\n";
  const { ctx, plan: planned } = await plan(db, csv);
  assert.deepEqual(planned.merge, [{ id: "tk_onfile", line: 2, changes: { due_at: "2026-12-01T08:00:00.000Z" } }]);
  assert.deepEqual(planned.create.map((row) => row.id), ["tk_fromcopy"]);
  const input = tasksModule.change(planned, ctx, NOW);
  assert.ok(input);
  await commitChange({ db, now: NOW, ...IMPORT_ACTOR }, input);
  const onFile = (await tasks(db)).find((task) => task.id === "tk_onfile");
  assert.deepEqual([onFile?.title, onFile?.due_at, JSON.parse(onFile?.untrusted_fields ?? "")], ["Call Pat", "2026-12-01T08:00:00.000Z", ["due_at"]]);
  assert.deepEqual((await plan(db, csv)).plan.unchanged.map((row) => row.line), [2, 3]);
});

test("tasks: a row with no person or deal columns filled is a standalone task; a row naming someone not on file is still skipped", async () => {
  const db = await withRecords();
  const csv = [
    "title,due,deal_id,contact_id,email,name",
    "Buy printer ink,2026-11-30,,,,",
    "Secret task,,,,,Nobody Example",
    "Secret task,,,,nobody@example.com,",
    "Secret task,,,ct_nobody,,",
    "Secret task,,not-a-deal,,,",
  ].join("\r\n");
  const { ctx, plan: planned } = await plan(db, csv);
  assert.deepEqual(planned.create.map((row) => [row.line, row.dealId, row.contactId, row.title]), [[2, null, null, "Buy printer ink"]]);
  assert.deepEqual(planned.skipped, [3, 4, 5, 6].map((line) => ({ line, reason: "no person or deal matches" })));
  // A file with only a title column is all standalone tasks.
  assert.deepEqual((await plan(db, "title\r\nPost the parcel\r\n")).plan.create.map((row) => [row.dealId, row.contactId]), [[null, null]]);

  const input = tasksModule.change(planned, ctx, NOW);
  assert.ok(input);
  await commitChange({ db, now: NOW, ...IMPORT_ACTOR }, input);
  const added = (await tasks(db)).find((task) => task.title === "Buy printer ink");
  assert.deepEqual(
    [added?.deal_id, added?.contact_id, added?.due_at, JSON.parse(added?.untrusted_fields ?? "[]")],
    [null, null, "2026-11-30T08:00:00.000Z", ["title", "due_at"]],
  );
});

test("tasks: a name two people share is not guessed", async () => {
  const db = await withRecords();
  db.exec(`INSERT INTO contacts (id, name, untrusted_fields) VALUES ('ct_pat2', 'Pat Example', '[]')`);
  const { plan: planned } = await plan(db, "title,name\r\nCall,Pat Example\r\n");
  assert.deepEqual(planned.skipped, [{ line: 2, reason: "more than one person on file has this name (contact ct_pat, ct_pat2)" }]);
});
