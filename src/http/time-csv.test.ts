// The month's time CSV (decision 0051): one row per client and work type, the owner's own export with every cell
// formula-guarded.
import assert from "node:assert/strict";
import { test } from "node:test";
import { devEnv, send } from "../../tests/helpers/board.ts";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ, localDate, zonedToUtc } from "../time.ts";
import { parseCsv } from "./csv.ts";
import { timeCsv } from "./time-csv.ts";

function entry(db: SqliteD1, id: string, date: string, hhmm: string, minutes: number, contact: string | null, type: string | null, billable: 0 | 1, rate: number | null): void {
  const start = zonedToUtc(`${date}T${hhmm}`, DEFAULT_TZ);
  const end = new Date(start.getTime() + minutes * 60_000);
  db.exec(
    `INSERT INTO time_entries (id, contact_id, started_at, ended_at, minutes, work_type_id, billable, rate)
     VALUES ('${id}', ${contact === null ? "NULL" : `'${contact}'`}, '${start.toISOString()}', '${end.toISOString()}', ${minutes}, ${type === null ? "NULL" : `'${type}'`}, ${billable}, ${rate === null ? "NULL" : rate})`,
  );
}

async function monthDb(): Promise<SqliteD1> {
  const db = await timeDb(new Date());
  entry(db, "te_csv001", "2026-11-03", "09:00", 90, "ct_seed01", "wt_design", 1, 95);
  entry(db, "te_csv002", "2026-11-04", "09:00", 60, "ct_seed01", "wt_design", 1, 95);
  entry(db, "te_csv003", "2026-11-05", "09:00", 30, "ct_seed01", "wt_admin", 0, null);
  entry(db, "te_csv004", "2026-11-06", "09:00", 45, "ct_seed02", "wt_design", 1, 100);
  entry(db, "te_csv005", "2026-11-30", "23:00", 20, null, null, 0, null);
  // Outside the month: the day before and the day after.
  entry(db, "te_csv006", "2026-10-31", "23:00", 60, "ct_seed01", "wt_design", 1, 95);
  entry(db, "te_csv007", "2026-12-01", "00:30", 60, "ct_seed01", "wt_design", 1, 95);
  // Archived and running entries never count.
  entry(db, "te_csv008", "2026-11-10", "09:00", 60, "ct_seed01", "wt_design", 1, 95);
  db.exec("UPDATE time_entries SET archived = 1 WHERE id = 'te_csv008'");
  // A running timer in the month (no end, no minutes) is not an entry yet.
  db.exec(`INSERT INTO time_entries (id, contact_id, started_at, work_type_id, billable) VALUES ('te_csv009', 'ct_seed03', '${zonedToUtc("2026-11-12T09:00", DEFAULT_TZ).toISOString()}', 'wt_design', 1)`);
  return db;
}

test("one row per client and work type", async () => {
  const db = await monthDb();
  const rows = parseCsv(await timeCsv(db, "2026-11", DEFAULT_TZ));
  assert.deepEqual(rows[0], ["client", "work type", "hours", "billable hours", "rate", "amount"]);
  assert.deepEqual(rows.slice(1), [
    // Names as they are, even a name that came from outside (it is the owner's own export, like /export).
    ["Pat Example", "Admin", "0.50", "0.00", "", "0.00"],
    ["Pat Example", "Design", "2.50", "2.50", "95.00", "237.50"],
    ["Robin Sample", "Design", "0.75", "0.75", "100.00", "75.00"],
    ["No person", "No work type", "0.33", "0.00", "", "0.00"],
  ]);
});

test("a group whose billable entries were saved at different rates leaves the rate blank", async () => {
  const db = await monthDb();
  db.exec("UPDATE time_entries SET rate = 110 WHERE id = 'te_csv002'");
  const rows = parseCsv(await timeCsv(db, "2026-11", DEFAULT_TZ));
  const design = rows.find((row) => row[0] === "Pat Example" && row[1] === "Design");
  assert.deepEqual(design, ["Pat Example", "Design", "2.50", "2.50", "", "252.50"]);
});

test("formula guard", async () => {
  const db = await monthDb();
  db.exec("UPDATE contacts SET name = '=HYPERLINK(\"http://example.test\")' WHERE id = 'ct_seed02'");
  db.exec("UPDATE work_types SET name = '+Design' WHERE id = 'wt_design'");
  const csv = await timeCsv(db, "2026-11", DEFAULT_TZ);
  const rows = parseCsv(csv);
  const cells = rows.slice(1).flat();
  assert.ok(cells.includes(`'=HYPERLINK("http://example.test")`), "the client cell has a leading apostrophe");
  assert.ok(cells.includes("'+Design"), "so does the work type cell");
  for (const cell of cells) assert.doesNotMatch(cell, /^[=+\-@\t\r]/, cell);
  assert.match(csv, /\r\n/);
});

test("a month with no time is just the header", async () => {
  const db = await timeDb(new Date());
  assert.equal(await timeCsv(db, "2026-11", DEFAULT_TZ), "client,work type,hours,billable hours,rate,amount\r\n");
});

test("the download: file name, attachment, CSV type, this month when none is asked for", async () => {
  const db = await monthDb();
  const env = devEnv(db);
  const res = await send(env, "/time/export.csv?month=2026-11");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "text/csv; charset=utf-8");
  assert.equal(res.headers.get("Content-Disposition"), 'attachment; filename="time-2026-11.csv"');
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.match(await res.text(), /^client,work type,hours,billable hours,rate,amount\r\nPat Example,Admin,0\.50,/);
  const month = localDate(new Date(), DEFAULT_TZ).slice(0, 7);
  for (const path of ["/time/export.csv", "/time/export.csv?month="]) {
    const current = await send(env, path);
    assert.equal(current.status, 200, path);
    assert.equal(current.headers.get("Content-Disposition"), `attachment; filename="time-${month}.csv"`, path);
  }
});

test("a month that is not YYYY-MM is a plain 400, and nothing about it is echoed", async () => {
  const env = devEnv(await monthDb());
  for (const bad of ["2026-13", "2026-00", "nov", "2026-11-01", "<b>"]) {
    const res = await send(env, `/time/export.csv?month=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 400, bad);
    assert.match(res.headers.get("Content-Type") ?? "", /^text\/plain/);
    const text = await res.text();
    assert.match(text, /Use a month like 2026-11/);
    assert.doesNotMatch(text, /<b>/);
    assert.equal(res.headers.get("Content-Disposition"), null);
  }
});

test("a HEAD request works and a POST is refused", async () => {
  const env = devEnv(await monthDb());
  assert.equal((await send(env, "/time/export.csv?month=2026-11", { method: "HEAD" })).status, 200);
  assert.equal((await send(env, "/time/export.csv?month=2026-11", { method: "POST" })).status, 405);
});
