import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { matchBoardPage } from "../board/router.ts";
import type { Db } from "../db/db.ts";
import { createTestDb, type SqliteD1 } from "../db/sqlite-d1.ts";
import type { Env } from "../env.ts";
import { newId } from "../ids.ts";
import worker from "../index.ts";
import { DEFAULT_TZ } from "../time.ts";
import { handleApi } from "./api.ts";
import { parseCsv } from "./csv.ts";
import { EXPORT_ROWS_PER_CHUNK, EXPORT_TABLES, exportSelect } from "./export.ts";

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
// 21:00 on Nov 19 in Los Angeles is already Nov 20 in UTC, so file names must use the owner's date.
const EVENING = new Date("2026-11-20T05:00:00.000Z");

async function seededDb(now = new Date()): Promise<SqliteD1> {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(now, DEFAULT_TZ));
  return db;
}

function envFor(db: SqliteD1): Env {
  return {
    ENVIRONMENT: "development",
    AUTH_MODE: "dev",
    DB: db,
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  };
}

const fetchApi = (db: SqliteD1, path: string, init?: RequestInit) =>
  worker.fetch(new Request(`http://localhost:4821${path}`, init), envFor(db), ctx);

const at = (db: SqliteD1, path: string, now: Date) => handleApi(new Request(`http://localhost:4821${path}`), { DB: db }, now);

async function jsonOf<T = Record<string, unknown>>(res: Response): Promise<T> {
  assert.match(res.headers.get("Content-Type") ?? "", /^application\/json; charset=utf-8/);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  return (await res.json()) as T;
}

const count = async (db: SqliteD1, table: string) =>
  (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;

const JSON_ROUTES = ["/api/pipeline", "/api/due", "/api/rules", "/api/changes", "/api/brief", "/api/export.json"];

test("every JSON route answers 200 with the seed and with an empty database", async () => {
  for (const db of [await seededDb(), await createTestDb()]) {
    for (const path of [...JSON_ROUTES, "/api/export/contacts.csv"]) {
      const res = await fetchApi(db, path);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get("Cache-Control"), "no-store", path);
    }
  }
  const empty = await createTestDb();
  assert.equal(((await jsonOf<{ total: number }>(await fetchApi(empty, "/api/pipeline"))).total), 0);
  assert.deepEqual(await jsonOf(await fetchApi(empty, "/api/rules")), { rules: [] });
  assert.deepEqual(await jsonOf(await fetchApi(empty, "/api/brief")), { brief: null });
  assert.deepEqual((await jsonOf<{ changes: unknown[] }>(await fetchApi(empty, "/api/changes"))).changes, []);
});

test("the JSON answers are the read services' shapes, with outside text still labelled", async () => {
  const db = await seededDb(EVENING);
  const pipeline = await jsonOf<{ open: { count: number }; stages: { key: string; deals: { id: string; untrusted_fields: string[] }[] }[] }>(
    await at(db, "/api/pipeline", EVENING),
  );
  assert.equal(pipeline.open.count, 6);
  const robin = pipeline.stages.flatMap((s) => s.deals).find((d) => d.id === "dl_seed02");
  assert.deepEqual(robin?.untrusted_fields, ["title", "contactName"]);

  const due = await jsonOf<{ today: string; overdueTasks: { id: string }[] }>(await at(db, "/api/due", EVENING));
  assert.equal(due.today, "2026-11-19");
  assert.ok(due.overdueTasks.some((t) => t.id === "tk_seed02"));

  const deal = await jsonOf<{ timeline: { untrusted_text: string | null }[]; contact: { untrusted_fields: string[] } }>(
    await at(db, "/api/deals/dl_seed02", EVENING),
  );
  assert.match(deal.timeline[0]?.untrusted_text ?? "", /fake test message/);
  assert.deepEqual(deal.contact.untrusted_fields, ["name", "email", "business"]);

  const brief = await jsonOf<{ brief: { localDate: string; items: { untrusted: boolean }[]; sendStatus: string } }>(
    await at(db, "/api/brief", EVENING),
  );
  assert.equal(brief.brief.localDate, "2026-11-18");
  assert.deepEqual(brief.brief.items.map((i) => i.untrusted), [false, false, true]);
  assert.equal(brief.brief.sendStatus, "off: brief_enabled is off");
  assert.equal("text" in brief.brief, false, "the unlabelled stored text stays out of the API");

  const rules = await jsonOf<{ rules: { id: string; active: boolean }[] }>(await at(db, "/api/rules", EVENING));
  assert.deepEqual(rules.rules.map((r) => [r.id, r.active]), [
    ["ru_seed01", true],
    ["ru_seed02", false],
  ]);
});

test("an unknown deal, an unknown table and an unknown API path are 404 JSON", async () => {
  const db = await seededDb();
  for (const path of [
    "/api/deals/dl_nothing0000",
    "/api/deals/Pat%20Example",
    "/api/export/write_guard.csv",
    "/api/export/d1_migrations.csv",
    "/api/export/nope.csv",
    "/api/export/contacts.json",
    "/api/nope",
    "/api",
  ]) {
    const res = await fetchApi(db, path);
    assert.equal(res.status, 404, path);
    assert.match((await jsonOf<{ error: string }>(res)).error, /\S/, path);
  }
});

test("the board and the API take the same deal ids, and look up nothing that can't be one", async () => {
  // A database that fails on any query: an id that can't be a deal must be answered without one.
  const noLookup = { prepare() { throw new Error("looked up"); } } as unknown as Db;
  const ids: [string, boolean][] = [
    [newId("dl"), true],
    ["dl_seed01", true],
    ["ct_seed01", false],
    [newId("tk"), false],
    ["dl_", false],
    ["dl_Seed01", false],
    ["dl_a-b", false],
    ["dl_a%2Fb", false],
    [`dl_${"a".repeat(33)}`, false],
  ];
  for (const [id, isDeal] of ids) {
    assert.equal(matchBoardPage(`/deals/${id}`) !== null, isDeal, `board ${id}`);
    const answer = handleApi(new Request(`http://localhost:4821/api/deals/${id}`), { DB: noLookup }, EVENING);
    if (isDeal) await assert.rejects(answer, /looked up/, `api ${id}`);
    else {
      const res = await answer;
      assert.equal(res.status, 404, `api ${id}`);
      assert.match((await jsonOf<{ error: string }>(res)).error, /^There's no deal with that id\./, `api ${id}`);
    }
  }
});

test("the API is read-only: anything but GET or HEAD is 405 JSON with an Allow header", async () => {
  const db = await seededDb();
  for (const path of ["/api/pipeline", "/api/export.json", "/api/export/contacts.csv", "/api/nope"]) {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await fetchApi(db, path, { method, body: method === "DELETE" ? undefined : "{}" });
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.headers.get("Allow"), "GET, HEAD");
      assert.match(((await res.json()) as { error: string }).error, /read-only/);
    }
  }
  assert.equal(await count(db, "audit_log"), 0, "nothing was written");
});

test("the JSON export streams table by table from one batch read, with the same content as the tables", async () => {
  const db = await seededDb(EVENING);
  const values = Array.from({ length: EXPORT_ROWS_PER_CHUNK + 10 }, (_, i) => `('ct_many${String(i).padStart(3, "0")}', 'Person ${i}')`);
  db.exec(`INSERT INTO contacts (id, name) VALUES ${values.join(", ")}`);
  let batches = 0;
  const counting: Db = {
    prepare: (sql) => db.prepare(sql),
    batch: (statements) => {
      batches += 1;
      return db.batch(statements);
    },
  };
  const res = await handleApi(new Request("http://localhost:4821/api/export.json"), { DB: counting }, EVENING);
  assert.equal(batches, 1, "every table comes from one batch, so they are from the same moment");
  assert.ok(res.body instanceof ReadableStream);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let chunks = 0;
  let text = "";
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    chunks += 1;
    text += decoder.decode(next.value, { stream: true });
  }
  assert.ok(chunks > EXPORT_TABLES.length + 1, `the body came in ${chunks} pieces`);
  const body = JSON.parse(text) as { exportedAt: string; tables: Record<string, unknown[]> };
  assert.equal(body.exportedAt, EVENING.toISOString());
  for (const table of EXPORT_TABLES) {
    const rows = (await db.prepare(exportSelect(table)).all()).results.map((row) => ({ ...row }));
    assert.deepEqual(body.tables[table], rows, table);
  }
  assert.match(text, /\n {6}\{"id":"ct_many000","name":"Person 0",/, "one row per line");
});

test("the JSON export holds every listed table, each row as stored, as a download named for the owner's date", async () => {
  const db = await seededDb(EVENING);
  const res = await at(db, "/api/export.json", EVENING);
  assert.equal(res.headers.get("Content-Disposition"), 'attachment; filename="pipeline-export-2026-11-19.json"');
  const body = await jsonOf<{ exportedAt: string; tables: Record<string, Record<string, unknown>[]> }>(res);
  assert.equal(body.exportedAt, EVENING.toISOString());
  assert.deepEqual(Object.keys(body.tables), [...EXPORT_TABLES]);
  assert.deepEqual([...EXPORT_TABLES].sort(), [
    "activities",
    "audit_log",
    "audit_parts",
    "briefs",
    "campaign_recipients",
    "campaign_steps",
    "campaigns",
    "client_rates",
    "contacts",
    "deals",
    "email_log",
    "email_suppressions",
    "field_defs",
    "person_statuses",
    "person_substatuses",
    "project_statuses",
    "projects",
    "rule_firings",
    "rulebook",
    "rules",
    "settings",
    "stages",
    "tasks",
    "time_entries",
    "views",
    "work_types",
  ]);
  for (const table of EXPORT_TABLES) assert.equal(body.tables[table]?.length, await count(db, table), table);
  const robin = body.tables.contacts?.find((c) => c.id === "ct_seed02");
  assert.equal(robin?.untrusted_fields, '["name","email","business"]', "JSON columns stay as stored");
});

test("one table as CSV: header row, every row, CRLF, and a download named pipeline-<table>-<owner date>.csv", async () => {
  const db = await seededDb(EVENING);
  for (const table of EXPORT_TABLES) {
    const res = await at(db, `/api/export/${table}.csv`, EVENING);
    assert.equal(res.status, 200, table);
    assert.equal(res.headers.get("Content-Type"), "text/csv; charset=utf-8");
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.equal(res.headers.get("Content-Disposition"), `attachment; filename="pipeline-${table}-2026-11-19.csv"`);
    const text = await res.text();
    const [header, ...records] = parseCsv(text);
    const columns = (await db.prepare(exportSelect(table).replace(" ORDER BY rowid", " LIMIT 0")).raw({ columnNames: true }))[0];
    assert.deepEqual(header, columns, `${table}: header even when empty`);
    assert.equal(records.length, await count(db, table), table);
    if (records.length > 0) assert.ok(text.endsWith("\r\n"), table);
  }
});

test("CSV round trip through the export: odd text comes back unchanged and formulas are defused", async () => {
  const db = await seededDb();
  const odd = {
    name: 'Pat "The Plumber", Jr.',
    business: "Line one\r\nLine two\nLine three",
    notes: `﻿🌱 emoji, BOM and ${"long ".repeat(2_000)}`,
    source: "=HYPERLINK(\"https://evil.example\",\"click\")",
  };
  db.prepare("INSERT INTO contacts (id, name, business, notes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind("ct_odd000000001", odd.name, odd.business, odd.notes, odd.source, "2026-11-19T18:00:00.000Z", "2026-11-19T18:00:00.000Z")
    .run();
  const [header = [], ...records] = parseCsv(await (await fetchApi(db, "/api/export/contacts.csv")).text());
  const record = records.find((r) => r[header.indexOf("id")] === "ct_odd000000001") ?? [];
  const field = (name: string) => record[header.indexOf(name)];
  assert.equal(field("name"), odd.name);
  assert.equal(field("business"), odd.business);
  assert.equal(field("notes"), odd.notes);
  assert.equal(field("notes")?.length, odd.notes.length);
  assert.equal(field("source"), `'${odd.source}`);
  assert.equal(field("email"), "", "null is an empty field");
});
