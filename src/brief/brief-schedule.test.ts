// The brief across the US clock changes (docs/PLAN.md review focus 1): driven by the hourly cron, it runs exactly once
// each local day, including the day with a repeated hour and the day with a missing one.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BriefRow, Db } from "../db/db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import type { Env } from "../env.ts";
import { runBrief } from "./run.ts";

const HOUR = 3_600_000;

/** Runs the hourly cron for `hours` ticks from `from` and returns the briefs it stored. */
async function hourly(briefHour: number, from: string, hours: number): Promise<BriefRow[]> {
  const db: Db = await openTestDb();
  await db.prepare("UPDATE settings SET brief_hour = ?, brief = 1").bind(briefHour).run();
  const env = { DB: db } as unknown as Env;
  const start = new Date(from).getTime();
  for (let i = 0; i < hours; i++) await runBrief(env, new Date(start + i * HOUR));
  return (await db.prepare("SELECT * FROM briefs ORDER BY local_date").all<BriefRow>()).results;
}

test("2026-11-01, the 1 a.m. hour happens twice: a 1 a.m. brief runs once, at the first 1 a.m.", async () => {
  // 07:00Z is midnight PDT; 25 ticks cover the whole 25-hour local day.
  const rows = await hourly(1, "2026-11-01T07:00:00.000Z", 25);
  assert.deepEqual(rows.map((r) => r.local_date), ["2026-11-01"]);
  assert.equal(rows[0]?.composed_at, "2026-11-01T08:00:00.000Z", "1:00 AM PDT, not the repeated 1:00 AM PST");
});

test("2026-11-01 and the day after: each local day gets exactly one brief", async () => {
  const rows = await hourly(1, "2026-11-01T07:00:00.000Z", 25 + 24);
  assert.deepEqual(rows.map((r) => r.local_date), ["2026-11-01", "2026-11-02"]);
  assert.deepEqual(rows.map((r) => r.composed_at), ["2026-11-01T08:00:00.000Z", "2026-11-02T09:00:00.000Z"]);
});

test("2026-11-01 with a 7 a.m. brief: the 25-hour day is unremarkable", async () => {
  const rows = await hourly(7, "2026-11-01T07:00:00.000Z", 25);
  assert.deepEqual(rows.map((r) => [r.local_date, r.composed_at]), [["2026-11-01", "2026-11-01T15:00:00.000Z"]]);
});

test("2027-03-14, the 2 a.m. hour does not exist: a 2 a.m. brief still runs once, at 3 a.m.", async () => {
  // 08:00Z is midnight PST; 23 ticks cover the whole 23-hour local day.
  const rows = await hourly(2, "2027-03-14T08:00:00.000Z", 23);
  assert.deepEqual(rows.map((r) => r.local_date), ["2027-03-14"]);
  assert.equal(rows[0]?.composed_at, "2027-03-14T10:00:00.000Z", "3:00 AM PDT");
});

test("2027-03-14 and the day after: one brief each day", async () => {
  const rows = await hourly(2, "2027-03-14T08:00:00.000Z", 23 + 24);
  assert.deepEqual(rows.map((r) => r.local_date), ["2027-03-14", "2027-03-15"]);
  assert.equal(rows[1]?.composed_at, "2027-03-15T09:00:00.000Z");
});

test("2027-03-14 with a 3 a.m. brief: runs once, not twice around the gap", async () => {
  const rows = await hourly(3, "2027-03-14T08:00:00.000Z", 23);
  assert.deepEqual(rows.map((r) => [r.local_date, r.composed_at]), [["2027-03-14", "2027-03-14T10:00:00.000Z"]]);
});

test("a midnight brief on the change days is never skipped", async () => {
  const fall = await hourly(0, "2026-11-01T07:00:00.000Z", 25);
  assert.deepEqual(fall.map((r) => r.composed_at), ["2026-11-01T07:00:00.000Z"]);
  const spring = await hourly(0, "2027-03-14T08:00:00.000Z", 23);
  assert.deepEqual(spring.map((r) => r.composed_at), ["2027-03-14T08:00:00.000Z"]);
});
