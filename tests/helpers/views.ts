// Stand-ins for the demo seed's saved views (scripts/seed-dev.ts, decision 0042) on a fixture-seeded database, so a
// unit test can open every path in boardRoutes.
import type { SqliteD1 } from "../../src/db/sqlite-d1.ts";

export function addStandInViews(db: SqliteD1): void {
  db.exec(`INSERT INTO views (id, name, module, filters, sort, position) VALUES
    ('vw_seed01', 'Referrals', 'people', '{"source":"referral"}', 'last_activity-desc', 1),
    ('vw_seed02', 'Open by value', 'deals', '{}', 'value-desc', 1),
    ('vw_seed03', 'Open work', 'projects', '{"status":"open"}', 'target-asc', 1)`);
}
