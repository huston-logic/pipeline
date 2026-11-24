// The fixture seed for the time tests (decision 0049): time tracking on, and two work types, Design ($95 an hour,
// billable by default) and Admin (no rate, not billable by default).
import { createTestDb, type SqliteD1 } from "../../src/db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../../src/time.ts";
import { buildFixtureSeed } from "./fixture-seed.ts";

export const WORK_TYPES_SQL =
  "INSERT INTO work_types (id, name, hourly_rate, billable_default, position) VALUES " +
  "('wt_design', 'Design', 95, 1, 1), ('wt_admin', 'Admin', NULL, 0, 2)";

export async function timeDb(now: Date, options: { on?: boolean } = {}): Promise<SqliteD1> {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(now, DEFAULT_TZ));
  if (options.on !== false) db.exec("UPDATE settings SET time_tracking = 1");
  db.exec(WORK_TYPES_SQL);
  return db;
}

export const countOf = async (db: SqliteD1, table: string): Promise<number> =>
  (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>("n")) ?? -1;
