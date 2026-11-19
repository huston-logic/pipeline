# 0008: Data layer details (schema, test database, dev seed, clock changes)

Numbered 0008 because docs/PLAN.md already reserves 0004 to 0007 for tasks 4, 5, 10 and 11.

## Context

Task 2 fixed the tables and columns but left some details open: how unit tests get a D1 database, what a local time
means on the days the clocks change, how `npm run dev` avoids loading the fake data twice, and how strict the
columns are.

## Decision

- **Test database.** `src/db/sqlite-d1.ts` is a small D1-compatible wrapper over `node:sqlite`, used only by tests
  (an ESLint rule stops Worker code importing it or any `node:*` module). It turns on foreign keys, runs `batch()`
  in one transaction, prepares statements lazily, raises SQLite errors as `D1_ERROR: <SQLite message>` and refuses
  `undefined` binds with `D1_TYPE_ERROR`, as D1 does. `applyMigrations` records applied files in a `d1_migrations`
  table shaped like wrangler's, so "from the previous version" tests can stop at a migration and continue later.
  `@types/node` 20 has no `node:sqlite` types, so `src/db/node-sqlite.d.ts` declares the few parts the wrapper uses.
- **Clock changes.** `zonedToUtc` follows Temporal's "compatible" rule: a wall time that happens twice (01:30 on
  2026-11-01 in Los Angeles) is the first one, and a skipped wall time (02:30 on 2027-03-14) moves forward by the
  skipped hour (03:30). Only `Intl` is used.
- **Dev seed.** `scripts/dev.mjs` applies migrations and `seed/defaults.sql` on every start, and the fake seed only
  into a state folder that has not had it: after loading it writes `.dev-seed-loaded` in that folder. The seed also
  uses fixed ids and `INSERT OR IGNORE`, so loading it again would add nothing.
- **Column checks.** Every table is `STRICT`; flags have `CHECK (x IN (0, 1))`; JSON columns have `json_valid` plus
  the expected `json_type` (object or array); times default to `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`, the same
  format as `toISOString()`.
- **`audit_log` has no foreign keys.** It names rows in any table and must keep naming them after they change, and
  `undone_by` / `undo_of` are written in the same batch as the change they point to.
- **`Env.DB` is typed as `Db`** (`Pick<D1Database, "prepare" | "batch">`), so Worker tests can pass the shim.

## Why

Tests that run the real SQL catch constraint and query mistakes that mocks would hide, and staying close to D1's
behaviour keeps the services honest about what D1 will do. The DST rule matches what people expect when they say
"2:30" on a change day and is what the future Temporal API does.

## Consequences

- The shim is not D1: things D1 refuses (for example `BEGIN` inside a batch) may work in tests. End-to-end tests
  against `wrangler dev --local` (task 4) cover the real thing.
- When `@types/node` is upgraded to 22.13 or later, delete `src/db/node-sqlite.d.ts`.
- To reload fake data locally, delete `.wrangler/state` (or use `npm run preview`, which always starts fresh).
