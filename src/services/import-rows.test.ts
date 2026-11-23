import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { draftChange, NOTHING_CONFIRMED, planDraft, resultOf } from "../board/import-plan.ts";
import { createTestDb } from "../db/sqlite-d1.ts";
import { createDraft, draftText, getDraft } from "../import/drafts.ts";
import type { Target } from "../import/engine.ts";
import { plannedChange, plannedResult } from "../import/planned.ts";
import { DEFAULT_TZ } from "../time.ts";
import { applyImport, importRows, planStoredDraft } from "./import-rows.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");

async function seeded() {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  return db;
}

const to = (key: string): Target => ({ kind: "builtin", key });

test("rows added to a board file with no final line break are stored exactly as they were planned", async () => {
  const db = await seeded();
  const board = "Name,Email\r\nFake Board,board@example.com";
  const id = await createDraft(db, { module: "people", text: board, mapping: [to("name"), to("email")], asLeads: false, now: NOW });
  const preview = await importRows({ db, now: NOW }, { module: "people", draft: id, columns: ["Name", "Email"], rows: [["Fake Mcp", "mcp@example.com"]] });
  assert.equal(await draftText(db, id), `${board}\r\nFake Mcp,mcp@example.com\r\n`);
  assert.deepEqual(preview.data.counts, { new: 2, filledIn: 0, alreadyUpToDate: 0, skipped: 0, possibleDuplicates: 0, archivedInFile: 0, newFields: 0 });
  const applied = await applyImport({ db, now: NOW }, id, preview.data.version as number);
  assert.match(applied.summary, /^Imported 2 contacts and filled details on 0 \(change /);
  const rows = (await db.prepare("SELECT name, email FROM contacts WHERE name LIKE 'Fake %' ORDER BY rowid").all<{ name: string; email: string }>()).results;
  assert.deepEqual(rows, [
    { name: "Fake Board", email: "board@example.com" },
    { name: "Fake Mcp", email: "mcp@example.com" },
  ]);
});

test("the board and MCP plan one draft alike: the same plan, counts and change", async () => {
  const db = await seeded();
  const drafts = [
    {
      module: "people" as const,
      text:
        "Name,Email,Business,Referred by,Budget\r\n" +
        "Fake One,fake1@example.com,Fake Co,A friend,500\r\n" +
        "Pat Example,pat@example.com,,,\r\n" +
        ",nobody@example.com,,,\r\n" +
        "Fake Two,,Example Plumbing,,\r\n" +
        "Fake Three,not-an-email,,,\r\n",
      mapping: [to("name"), to("email"), to("business"), { kind: "notes", label: "Referred by" }, { kind: "new_field", label: "Budget" }] as Target[],
      asLeads: true,
    },
    {
      module: "deals" as const,
      text: "title,name,email,stage\r\nFake deal 1,Fake One,fake1@example.com,Won\r\nFake deal 2,Pat Example,pat@example.com,\r\n,Nobody,,\r\n",
      mapping: [to("title"), to("name"), to("email"), to("stage")] as Target[],
      asLeads: false,
    },
  ];
  for (const input of drafts) {
    const id = await createDraft(db, { ...input, now: NOW });
    const draft = await getDraft(db, id, NOW);
    assert.ok(draft);
    const text = await draftText(db, id);
    const board = await planDraft(db, draft, text, NOW, NOTHING_CONFIRMED);
    const mcp = await planStoredDraft(db, draft, text, NOW);
    const { skippedColumns, ...boardPlan } = board.plan;
    assert.deepEqual(skippedColumns, []);
    assert.deepEqual(mcp.plan, boardPlan, input.module);
    assert.deepEqual(plannedResult(mcp, false), resultOf(board, false), input.module);
    assert.deepEqual(plannedResult(mcp, true), resultOf(board, true), input.module);
    const fields = (list: readonly { entity: string; label: string; key: string }[]) => list.map(({ entity, label, key }) => ({ entity, label, key }));
    assert.deepEqual(fields(mcp.newFields), fields(board.newFields));
    const strip = (input: ReturnType<typeof plannedChange>) => input && { summary: input.summary, target: input.target.table, rows: input.changes.length };
    assert.deepEqual(strip(plannedChange(mcp, NOW)), strip(draftChange(board, NOW)), input.module);
  }
});
