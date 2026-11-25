// The time pages (decision 0051): /time, the week's entries by day with their totals, and its 404s while time tracking
// is off. The write side is in time-entry.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { devEnv, h1Count, load } from "../../tests/helpers/board.ts";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import { periodOf } from "../services/time-read.ts";
import { addDays, DEFAULT_TZ, zonedToUtc } from "../time.ts";

const week = periodOf("this_week", new Date(), DEFAULT_TZ);

/** A finished entry that starts at `hhmm` on a local date. */
function entry(db: SqliteD1, id: string, date: string, hhmm: string, minutes: number, extra: { contact?: string | null; deal?: string | null; type?: string | null; billable?: 0 | 1; rate?: number | null } = {}): void {
  const start = zonedToUtc(`${date}T${hhmm}`, DEFAULT_TZ);
  const end = new Date(start.getTime() + minutes * 60_000);
  const { contact = "ct_seed01", deal = null, type = null, billable = 0, rate = null } = extra;
  db.exec(
    `INSERT INTO time_entries (id, contact_id, deal_id, started_at, ended_at, minutes, work_type_id, billable, rate)
     VALUES ('${id}', ${contact === null ? "NULL" : `'${contact}'`}, ${deal === null ? "NULL" : `'${deal}'`}, '${start.toISOString()}', '${end.toISOString()}', ${minutes}, ${type === null ? "NULL" : `'${type}'`}, ${billable}, ${rate === null ? "NULL" : rate})`,
  );
}

async function weekDb(): Promise<SqliteD1> {
  const db = await timeDb(new Date());
  entry(db, "te_week01", week.from, "09:00", 90, { deal: "dl_seed01", type: "wt_design", billable: 1, rate: 95 });
  entry(db, "te_week02", week.from, "13:00", 30, { type: "wt_admin" });
  entry(db, "te_week03", addDays(week.from, 1), "10:00", 60, { contact: null, type: "wt_design", billable: 1, rate: 100 });
  return db;
}

test("week totals match the entries", async () => {
  const db = await weekDb();
  const { res, body } = await load(devEnv(db), "/time");
  assert.equal(res.status, 200);
  assert.equal(h1Count(body), 1);
  assert.match(body, /<h1>Time<\/h1>/);
  // 90 + 30 + 60 minutes; billable 90 + 60 = 2 h 30 min at $142.50 + $100.00.
  assert.match(body, /<dt>Total<\/dt><dd>3 h<\/dd>/);
  assert.match(body, /<dt>Billable<\/dt><dd>2 h 30 min<\/dd>/);
  assert.match(body, /<dt>Not billable<\/dt><dd>30 min<\/dd>/);
  assert.match(body, /<dt>Billable amount<\/dt><dd>\$242\.50<\/dd>/);
  // The entries, each with its own Edit link, grouped by day.
  for (const id of ["te_week01", "te_week02", "te_week03"]) assert.match(body, new RegExp(`href="/time/${id}/edit"`), id);
  assert.match(body, /Design/);
  assert.match(body, /\$142\.50/);
  assert.match(body, /<a href="\/deals\/dl_seed01">Website refresh for Example Plumbing<\/a>/);
  // By person: Pat has 2 h, and the entry with no one is its own row, last.
  const byPerson = /id="by-person"[\s\S]*?<\/section>/.exec(body)?.[0] ?? "";
  assert.match(byPerson, /Pat Example[\s\S]*?2 h[\s\S]*?No person[\s\S]*?1 h/);
  const byDeal = /id="by-deal"[\s\S]*?<\/section>/.exec(body)?.[0] ?? "";
  assert.match(byDeal, /Website refresh for Example Plumbing[\s\S]*?1 h 30 min/);
});

test("other week by address", async () => {
  const db = await weekDb();
  const last = addDays(week.from, -7);
  entry(db, "te_last01", addDays(last, 2), "09:00", 45, { type: "wt_design", billable: 1, rate: 95 });
  const env = devEnv(db);
  const now = (await load(env, "/time")).body;
  assert.doesNotMatch(now, /te_last01/);
  const other = await load(env, `/time?week=${last}`);
  assert.equal(other.res.status, 200);
  assert.match(other.body, /te_last01/);
  assert.doesNotMatch(other.body, /te_week01/);
  assert.match(other.body, /<dt>Total<\/dt><dd>45 min<\/dd>/);
  // Previous and Next week links carry the Monday they go to; this week has no Next link to a later week unless asked.
  assert.match(other.body, new RegExp(`href="/time\\?week=${addDays(last, -7)}"`));
  assert.match(other.body, /href="\/time"/);
  assert.match(now, new RegExp(`href="/time\\?week=${addDays(week.from, -7)}"`));
  assert.match(now, new RegExp(`href="/time\\?week=${addDays(week.from, 7)}"`));
  // A date in the middle of a week shows that week.
  const mid = await load(env, `/time?week=${addDays(last, 3)}`);
  assert.match(mid.body, /te_last01/);
});

test("bad week falls back to this week", async () => {
  const db = await weekDb();
  const env = devEnv(db);
  const plain = (await load(env, "/time")).body;
  for (const bad of ["nope", "2026-02-30", "2026-13-01", "", "<b>", "2026-11-16T09:00"]) {
    const { res, body } = await load(env, `/time?week=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 200, bad);
    assert.match(body, /<dt>Total<\/dt><dd>3 h<\/dd>/, bad);
    assert.doesNotMatch(body, /<b>/, bad);
  }
  assert.match(plain, /<dt>Total<\/dt><dd>3 h<\/dd>/);
});

test("an empty week says so and still offers Add time", async () => {
  const db = await timeDb(new Date());
  const { body } = await load(devEnv(db), "/time");
  assert.match(body, /No time logged this week\./);
  assert.match(body, /<a class="button" href="\/time\/new">Add time<\/a>/);
  assert.equal(h1Count(body), 1);
});

test("the page offers the month's CSV and a month picker that gets /time/export.csv", async () => {
  const db = await timeDb(new Date());
  const { body } = await load(devEnv(db), "/time");
  assert.match(body, /<a class="button button-quiet" href="\/time\/export\.csv\?month=\d{4}-\d{2}"[^>]*>Download CSV for this month<\/a>/);
  assert.match(body, /<form class="month-form" method="get" action="\/time\/export\.csv">/);
  assert.match(body, /<input id="time-month" name="month" type="month" value="\d{4}-\d{2}" aria-describedby="time-month-hint">/);
  assert.match(body, /<p class="field-hint" id="time-month-hint">A month like 2026-11\.<\/p>/);
  assert.match(body, /<label for="time-month">Month<\/label>/);
});

test("time tracking off: the time pages are 404 and Time is not in More", async () => {
  const db = await timeDb(new Date(), { on: false });
  const env = devEnv(db);
  for (const path of ["/time", "/time?week=2026-11-16", "/time/new", "/time/te_nope/edit", "/time/export.csv", "/time/export.csv?month=2026-11"]) {
    assert.equal((await load(env, path)).res.status, 404, path);
  }
  assert.doesNotMatch((await load(env, "/more")).body, /href="\/time"/);
});

test("a week of the Monday-to-Sunday kind: an entry late on Sunday is in that week, not the next", async () => {
  const db = await timeDb(new Date());
  const sunday = addDays(week.from, -1);
  entry(db, "te_sun001", sunday, "23:30", 20);
  const env = devEnv(db);
  assert.match((await load(env, `/time?week=${addDays(sunday, -6)}`)).body, /te_sun001/);
  assert.doesNotMatch((await load(env, "/time")).body, /te_sun001/);
});

test("the export page lists the project CSVs only while projects are on", async () => {
  const offDb = await timeDb(new Date());
  const onDb = await timeDb(new Date());
  onDb.exec("UPDATE settings SET projects = 1");
  const on = (await load(devEnv(onDb), "/export")).body;
  const off = (await load(devEnv(offDb), "/export")).body;
  for (const table of ["projects", "project_statuses"]) {
    assert.match(on, new RegExp(`href="/api/export/${table}\\.csv"`), table);
    assert.doesNotMatch(off, new RegExp(`href="/api/export/${table}\\.csv"`), table);
  }
  assert.equal(on.match(/class="download-row"/g)?.length, 22);
});

test("the export page lists the three time CSVs only while time tracking is on", async () => {
  const on = (await load(devEnv(await timeDb(new Date())), "/export")).body;
  const off = (await load(devEnv(await timeDb(new Date(), { on: false })), "/export")).body;
  for (const table of ["time_entries", "work_types", "client_rates"]) {
    assert.match(on, new RegExp(`href="/api/export/${table}\\.csv"`), table);
    assert.doesNotMatch(off, new RegExp(`href="/api/export/${table}\\.csv"`), table);
  }
  assert.equal(on.match(/class="download-row"/g)?.length, 20);
  assert.equal(off.match(/class="download-row"/g)?.length, 17);
  // The data stays in the full JSON export either way.
  assert.match(off, /href="\/api\/export\.json"/);
});
