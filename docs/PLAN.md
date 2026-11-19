# Pipeline engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pipeline engine in `docs/SPEC.md`: one Cloudflare Worker per client copy with a D1 database, an MCP endpoint at `/mcp`, hourly rules, a daily brief, `/intake`, and a read-only board.

**Architecture:** One Worker (`src/index.ts`) handles every route: `/mcp` (Agents SDK `createMcpHandler`), `/intake`, `/api/*` (JSON), the board (server-rendered HTML, no client JS) and the hourly cron. All writes go through one service layer (`src/services/`) whose `commitChange` writes the rows and the `audit_log` row in one D1 batch. Rules and the brief are pure functions fed by the data layer. `npm run build` only writes the static files (`out/`: CSS, robots, 404 and the files CI expects); Next.js, React and Tailwind are removed (decision 0001).

**Tech Stack:** Cloudflare Workers + D1 + Cron Triggers, TypeScript (strict, run in Node by type stripping), `agents` (createMcpHandler), `@modelcontextprotocol/sdk`, `zod`, `@cloudflare/workers-oauth-provider` (task 10), Node's built-in test runner with a D1 shim over `node:sqlite`, wrangler for local dev, Playwright + axe and Lighthouse CI for the board.

**Spec:** `docs/SPEC.md` (approved 2026-11-18). Read it with this plan.

## Global Constraints

- Identical code for every copy. Nothing client-specific in the repo. No real names, emails or lead data anywhere: fake people only (`@example.com`, `@example.test`).
- `/mcp` over Streamable HTTP with `createMcpHandler` (not `McpAgent`). Every read tool has `readOnlyHint: true`.
- Every write: one D1 batch with its `audit_log` row; returns a one-line summary plus a change id. `undo_change` reverses one change and refuses if already undone or the record changed since.
- No delete tools. No MCP tool sends email or moves data out.
- Outside text is untrusted and is returned inside fields named `untrusted_text` / listed in `untrusted_fields`.
- Owner timezone setting, default `America/Los_Angeles`, drives "today", all dates and the brief hour.
- Dev uses wrangler's local D1 with fake seed data; previews use a separate preview database (`previews.d1_databases`).
- Free plan where possible; anything needing Workers Paid goes in `docs/PAID-PLAN.md` with the reason.
- Dependencies: exact pins, each at least 7 days old; lockfile written with `npx --yes npm@10.9.9 install --before=<7 days ago>`; Node 22 / npm 10 in CI.
- Wrangler only through npm scripts, only local (`--local`, `wrangler dev`). Never deploy, log in or touch a remote database.
- CI job names `check`, `a11y`, `lighthouse`, `dependency-review` and the CodeQL workflow are unchanged. CI runs `npm run check:config`, `lint`, `typecheck`, `test:worker`, `build`, then checks `out/index.html`, `out/404.html`, `out/sitemap.xml`, `out/robots.txt`, `out/_headers` exist; `a11y` runs `npm run build` + `npm run test:a11y`; `lighthouse` runs `npm run build` + `npm run test:lighthouse`. Those script names must keep working.
- Never lower a Lighthouse threshold, skip an axe rule or weaken a test.
- Each judgment call gets a short file in `docs/decisions/NNNN-title.md`.

## Review Focus

1. **Daylight-saving edges.** "Thursday 2 p.m." and the brief hour across the US DST changes (2026-11-01, 2027-03-14) must land on the right UTC instant; a brief must not run twice or be skipped on those days. Tests: task 2 (`time.test.ts`), task 7 (`brief-schedule.test.ts`).
2. **Duplicate form submissions** (double-click, retry) must not create two deals. Test: task 8 (`intake.test.ts` "same email and message within 10 minutes is one lead").
3. **Undo after later edits.** Undoing `add_lead` after an activity was logged on the deal must refuse in plain English, not throw a foreign-key error. Test: task 3 (`undo.test.ts`).
4. **Odd text**: commas, quotes, newlines, emoji, a leading BOM and very long values in names and CSV. Export and import must round-trip them. Tests: task 9 (`csv.test.ts`), task 11 (`import.test.ts`).
5. **Empty pipeline** (fresh copy, no deals): every read tool and every board page must answer "nothing yet", not crash. Tests: task 4 (`read-tools.test.ts` "empty database"), task 9 (board render test).

## Design decisions every task relies on

- **IDs**: text primary keys `<prefix>_<12 lowercase base32 chars>` from `newId(prefix)` in `src/ids.ts`. Prefixes: `ct` contact, `dl` deal, `ac` activity, `tk` task, `ru` rule, `rf` rule firing, `fd` field, `br` brief, `chg` change. Stages use `key` (slug) as the primary key; rulebook uses `name`; settings is one row with `id = 1`.
- **Times**: stored as UTC ISO strings (`toISOString()`). Inputs accept `YYYY-MM-DD`, `YYYY-MM-DDTHH:mm` (owner's local wall time) or a full ISO string with offset. A date-only input means 00:00 local.
- **Versions**: every mutable table has `version INTEGER NOT NULL DEFAULT 1`, bumped on each update. Undo and updates are guarded atomically by `INSERT INTO write_guard (ok) SELECT COUNT(*) = 1 FROM <t> WHERE id = ? AND version = ?`; `write_guard.ok` has `CHECK (ok = 1)`, so a stale write aborts the whole batch. The batch ends with `DELETE FROM write_guard`.
- **Change records**: one `audit_log` row per change. `before_json` / `after_json` hold `{ "<table>:<id>": row | null }` for every row the change touched. Summary text ends with `(change chg_…)`.
- **Untrusted text**: contacts carry `untrusted_fields` (JSON array of field names set from outside: intake or import); an owner edit removes that field from the list. Activities keep outside text in `untrusted_text`. Read tools return those values unchanged but labelled: `untrusted_fields` beside the contact and `untrusted_text` on the activity.
- **Errors**: services throw `UserError(message)`; the message is plain English and ends with how to fix the request. Anything else becomes "Something went wrong on the server. Nothing was changed." with no internals.
- **Actors**: MCP writes are `ai`, the import script is `owner`, cron, rules and intake are `system`.
- **Activities that count as contact**: `form`, `email`, `call`, `meeting`, `note`. They update `deals.last_activity_at`; `stage_change` and `system` do not.

## File structure

```
migrations/0001_init.sql            schema (task 2); later tasks add 000N_*.sql, never edit old ones
seed/defaults.sql                   default stages, starter rulebook, settings row (INSERT OR IGNORE)
src/index.ts                        Worker entry: fetch router + scheduled
src/env.ts                          Env type (bindings, vars, secrets)
src/ids.ts, src/time.ts             ids and timezone helpers
src/db/db.ts                        Db type (Pick<D1Database, "prepare" | "batch">), row types
src/db/sqlite-d1.ts                 test-only D1 shim over node:sqlite (+ applyMigrations helper)
src/db/queries.ts                   typed reads
src/services/                       change.ts (commitChange, undo), errors.ts, leads.ts, deals.ts, activities.ts,
                                    tasks.ts, stages.ts, fields.ts, rules.ts, rulebook.ts, settings.ts, read.ts
src/rules/engine.ts                 pure evaluate + preview
src/brief/compose.ts, run.ts, send.ts
src/mcp/server.ts, instructions.ts, tools-read.ts, tools-write.ts, format.ts
src/http/intake.ts, api.ts, export.ts, csv.ts
src/board/                          html.ts (escaping template tag), layout.ts, pages/*.ts, routes.ts
src/auth/                           dev.ts, access-jwt.ts, oauth.ts
public/                             board.css, robots.txt, _headers (copied to out/ by scripts/build.mjs)
scripts/                            build.mjs, dev.mjs, seed-dev.ts, check-config.mjs, copies.mjs, import-csv.ts, export.ts
tests/a11y/, tests/e2e/             Playwright+axe; MCP end-to-end against wrangler dev
docs/decisions/                     one file per judgment call
```

Unit tests sit beside the code (`src/**/*.test.ts`) and run with `node --test`. `npm run test:worker` runs every unit test and the e2e test.

---

### Task 0: Spec, plan, status (docs only)

**Files:** Create `docs/SPEC.md`, `docs/decisions/README.md`. Replace `docs/PLAN.md`, `docs/STATUS.md`.

- [ ] Save the spec unchanged, write this plan and a fresh STATUS.md, run `npm run check`, commit, PR, auto-merge.

### Task 1 (M1): Repo identity and engine skeleton

**Files:**
- Delete: `src/app/**`, `src/components/**`, `src/content/**`, `src/lib/**`, `src/assets/**`, `worker/**`, `site.config.ts`, `scripts/sync-config.mjs`, `scripts/check-placeholders.mjs`, `scripts/check-redirects*.mjs`, `scripts/preview.mjs`, `next.config.ts`, `public/_redirects`, `docs/website-plan.md`, `docs/apps-script/`, `docs/LAUNCH-CHECKLIST.md`, `docs/TEMPLATE.md`, `tests/a11y/contact-form.spec.ts`.
- Create: `src/index.ts`, `src/env.ts`, `src/board/html.ts`, `src/board/layout.ts`, `src/board/routes.ts`, `src/board/pages/home.ts`, `public/board.css`, `public/robots.txt`, `scripts/build.mjs`, `scripts/dev.mjs`, `scripts/check-config.mjs`, tests beside each.
- Modify: `package.json`, `wrangler.jsonc`, `tsconfig.json`, `eslint.config.mjs`, `.gitignore`, `public/_headers`, `lighthouserc.cjs`, `playwright.config.ts`, `tests/a11y/site.a11y.spec.ts`, `README.md`, `AGENTS.md`, `CLAUDE.md`, `docs/SECRETS.md`, `.env.example`.

**Interfaces:**
- Produces: `html` tagged template in `src/board/html.ts` (`html\`…\`` escapes every interpolation; `raw(s)` marks trusted markup; returns `Html { value: string }`); `renderPage({ title, description, body, current }): string` in `layout.ts`; `boardRoutes: string[]` in `src/board/routes.ts` (import-free, read by Playwright and lighthouserc); `export default { fetch(req, env, ctx), scheduled(ctl, env, ctx) }` in `src/index.ts`.

Steps:
- [ ] Remove Next.js, React, Tailwind: `npx --yes npm@10.9.9 uninstall next react react-dom tailwindcss @tailwindcss/turbopack eslint-config-next @types/react @types/react-dom --before=2026-11-11T23:59:59Z`, then `npx --yes npm@10.9.9 install -D -E typescript-eslint@8.72.2 --before=2026-11-11T23:59:59Z`. Keep `overrides` for `@typescript-eslint/typescript-estree` only if `npm ls minimatch` still shows the old path; otherwise remove it.
- [ ] `package.json`: `name` `pipeline`, description "Sales follow-up engine: one Cloudflare Worker per client copy." Scripts: `dev` = `node scripts/dev.mjs --port 4821`, `preview` = `node scripts/dev.mjs --port 4822 --fresh`, `build` = `node scripts/build.mjs`, `lint` = `eslint .`, `typecheck` = `tsc --noEmit`, `test:worker` = `node --disable-warning=ExperimentalWarning --test "src/**/*.test.ts" "scripts/*.test.mjs" "tests/e2e/*.test.ts"`, `check:config` = `node scripts/check-config.mjs`, `check` = `npm run check:config && npm run lint && npm run typecheck && npm run test:worker && npm run build`, keep `test:a11y`, `test:lighthouse`, add `types` = `wrangler types src/worker-configuration.d.ts`.
- [ ] `wrangler.jsonc` (generic dev config, no client values): `name` `pipeline-dev`, `main` `src/index.ts`, `assets.directory` `./out`, `assets.binding` `ASSETS`, `run_worker_first: true`, `vars` `{ ENVIRONMENT: "production" }` (dev scripts override with `--var ENVIRONMENT:development`), `observability` as before. D1 and crons arrive in later tasks.
- [ ] Worker test first (`src/index.test.ts`): `GET /` returns 200 HTML with exactly one `<h1>`, `lang="en"`, a meta description, and security headers (CSP `default-src 'self'`, no `unsafe-inline` for scripts, `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'`); `GET /nope` returns 404 HTML; static paths (`/board.css`, `/robots.txt`) are passed to `env.ASSETS.fetch`. Then implement.
- [ ] `html.test.ts`: `<script>`, quotes and `&` are escaped; `raw` is not; arrays join.
- [ ] `scripts/build.mjs` writes `out/` from `public/` plus `out/index.html` (static "Pipeline board" notice for when the Worker is not running), `out/404.html`, `out/sitemap.xml` (an empty `<urlset>`, decision 0003). Test `scripts/build.test.mjs` checks the five CI files exist and are non-empty.
- [ ] `scripts/dev.mjs`: applies `migrations/` locally if any exist (`wrangler d1 migrations apply DB --local --persist-to <dir>`), runs the seed (later tasks), then `wrangler dev --local --port <p> --persist-to <dir> --var ENVIRONMENT:development --var AUTH_MODE:dev`. `--fresh` uses a new `.wrangler/preview-<timestamp>` state dir.
- [ ] `scripts/check-config.mjs` + test: fails if a tracked file (from `git ls-files`) contains an email address whose domain is not `example.com`, `example.test`, `example.org`, `example.net` or an allow-list (`noreply@anthropic.com`, `users.noreply.github.com`); fails if `wrangler.jsonc` has a `database_id` or `account_id` that is not a placeholder; fails unless `.gitignore` ignores `/.copies/` and `/exports/`.
- [ ] `tests/a11y/site.a11y.spec.ts` rewritten over `boardRoutes` (top and scrolled passes, 404 page); `playwright.config.ts` keeps the two projects and starts `npm run preview`; `lighthouserc.cjs` reads `boardRoutes`, `startServerReadyPattern: "Ready on"`. Thresholds unchanged.
- [ ] `README.md`, `AGENTS.md` (engine rules, including the exact line "Never commit real names, emails or lead data; tests use fake people."), `CLAUDE.md` (sources of truth, commands, deploy note), `docs/SECRETS.md` (names only). Decisions 0001 (board rendered by the Worker; Next removed), 0002 (what replaces `site.config.ts`), 0003 (robots, sitemap, no noindex: Access is the gate).
- [ ] `npm run check`, `npm run build`, `npm run test:a11y`, `npm run test:lighthouse` locally; commit; PR.

### Task 2 (M2): D1 schema, migrations, seed data, typed data access

**Files:** Create `migrations/0001_init.sql`, `seed/defaults.sql`, `src/ids.ts`, `src/time.ts`, `src/db/db.ts`, `src/db/sqlite-d1.ts`, `src/db/queries.ts`, `scripts/seed-dev.ts`, tests beside each. Modify `wrangler.jsonc` (D1 binding `DB`, `database_name` `pipeline`, `database_id` `00000000-0000-0000-0000-000000000000`, `migrations_dir` `migrations`; `previews.d1_databases` with binding `DB`, `database_name` `pipeline-preview`, the same placeholder id), `scripts/dev.mjs` (apply defaults + fake seed).

**Interfaces:**
- Produces: `newId(prefix: IdPrefix): string`; `DEFAULT_TZ`; `localDate(at: Date, tz: string): string`; `localHour(at: Date, tz: string): number`; `zonedToUtc(local: string, tz: string): Date`; `parseWhen(input: string, tz: string): Date` (throws `UserError`); `dayBoundsUtc(date: string, tz: string): { start: Date; end: Date }`; `addDays(date: string, n: number): string`; `formatLocal(at: Date | string, tz: string): string` (e.g. `Thu Nov 19, 2:00 PM`). `type Db = Pick<D1Database, "prepare" | "batch">`; row types `ContactRow`, `DealRow`, `ActivityRow`, `TaskRow`, `StageRow`, `FieldDefRow`, `RuleRow`, `RuleFiringRow`, `RulebookRow`, `SettingsRow`, `AuditRow`; `openTestDb(): Promise<Db>` (fresh in-memory DB with all migrations and `seed/defaults.sql`); `applyMigrations(db, upTo?: number)`; `queries.*` read functions (`getSettings`, `listStages`, `getContact`, `findContactByEmail`, `searchContacts`, `getDeal`, `listDeals(filter)`, `listActivities(target)`, `listTasks(filter)`, `listRules`, `getRulebook`, `listAudit(since)`).

Schema (`0001_init.sql`), every table `STRICT`, foreign keys on:
- `settings(id INTEGER PRIMARY KEY CHECK (id = 1), timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles', brief_hour INTEGER NOT NULL DEFAULT 7 CHECK (brief_hour BETWEEN 0 AND 23), brief_email TEXT, brief_enabled INTEGER NOT NULL DEFAULT 0, owner_emails TEXT NOT NULL DEFAULT '[]', last_brief_at TEXT, version, updated_at)`
- `stages(key TEXT PRIMARY KEY, label TEXT NOT NULL, position INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('open','won','lost','not_now')), archived INTEGER NOT NULL DEFAULT 0, version, created_at, updated_at)`
- `field_defs(id, entity CHECK IN ('contact','deal'), key, label, type CHECK IN ('text','number','date','choice'), choices TEXT (JSON array or NULL), archived, version, created_at, updated_at, UNIQUE(entity, key))`
- `contacts(id, name NOT NULL, email, phone, business, source, notes, fields TEXT NOT NULL DEFAULT '{}', untrusted_fields TEXT NOT NULL DEFAULT '[]', archived, version, created_at, updated_at)` + `UNIQUE INDEX contacts_email ON contacts(lower(email)) WHERE email IS NOT NULL`
- `deals(id, contact_id NOT NULL REFERENCES contacts, title NOT NULL, stage_key NOT NULL REFERENCES stages, value REAL, next_step, next_at, status NOT NULL DEFAULT 'open' CHECK IN ('open','won','lost','not_now'), fields DEFAULT '{}', stage_entered_at NOT NULL, last_activity_at, archived, version, created_at, updated_at)`
- `activities(id, deal_id REFERENCES deals, contact_id REFERENCES contacts, type CHECK IN ('form','email','call','meeting','note','stage_change','system'), summary NOT NULL, untrusted_text, data TEXT (JSON, e.g. {"from":"replied","to":"call_booked"}), occurred_at NOT NULL, actor CHECK IN ('owner','ai','system'), version, created_at, CHECK (deal_id IS NOT NULL OR contact_id IS NOT NULL))`
- `tasks(id, deal_id, contact_id, title NOT NULL, due_at, done_at, snoozed_until, source NOT NULL DEFAULT 'owner' ('owner' or a rule id), version, created_at, updated_at, same CHECK)`
- `rules(id, type CHECK IN ('stage_followup','on_stage_enter','gone_quiet'), params TEXT NOT NULL, description NOT NULL, active NOT NULL DEFAULT 1, created_by CHECK IN ('owner','ai','system'), version, created_at, updated_at)`
- `rule_firings(id, rule_id NOT NULL REFERENCES rules, deal_id NOT NULL REFERENCES deals, fire_key TEXT NOT NULL UNIQUE, task_id REFERENCES tasks ON DELETE SET NULL, fired_at)`
- `rulebook(name TEXT PRIMARY KEY, markdown NOT NULL, version, updated_at)`
- `audit_log(id, at, actor, tool, target_table, target_id, before_json, after_json, summary, undone_at, undone_by, undo_of)`
- `write_guard(ok INTEGER NOT NULL CHECK (ok = 1))`

`seed/defaults.sql`: settings row; stages `new_inquiry` New inquiry (open, 1), `replied` Replied (open, 2), `call_booked` Call booked (open, 3), `call_done` Call done (open, 4), `proposal_sent` Proposal sent (open, 5), `won` Won (won, 6), `lost` Lost (lost, 7), `not_now` Not now (not_now, 8); rulebook `voice`, `pipeline`, `guardrails` with short generic starter markdown.

Steps (TDD for each file):
- [ ] `time.test.ts`: `zonedToUtc("2026-11-19T14:00", "America/Los_Angeles")` is `2026-11-19T22:00:00.000Z`; `zonedToUtc("2026-10-31T14:00", …)` is `21:00Z` (PDT); `dayBoundsUtc("2026-11-01", …)` spans 25 hours; `dayBoundsUtc("2027-03-14", …)` spans 23 hours; `localDate(new Date("2026-11-19T07:30:00Z"), …)` is `2026-11-18`; `parseWhen("next tuesday", …)` throws a `UserError` naming the accepted formats.
- [ ] `sqlite-d1.test.ts`: `batch` is atomic (second statement fails → first not applied); `first`, `all`, `run().meta.changes` behave like D1.
- [ ] `migrations.test.ts`: from empty, every table exists and `PRAGMA foreign_key_check` is clean; defaults load twice without error; the unique email index rejects `A@example.com` after `a@example.com`; a deal with an unknown stage is rejected; `write_guard` rejects `ok = 0`. A helper `migrationFiles()` lists `migrations/*.sql` in order; later tasks add "from the previous version" tests here.
- [ ] `queries.test.ts` for each read function against `openTestDb()` plus the fake seed.
- [ ] `scripts/seed-dev.ts` exports `buildDevSeed(now: Date, tz: string): string` (SQL) with fixed ids (`ct_seed01…`, `dl_seed01…`): 8 fake contacts across the open stages, one won, one lost, tasks overdue / due today / future, activities with dates relative to `now`, one form activity whose `untrusted_text` is an obvious fake. Running `node scripts/seed-dev.ts --out <file>` writes it; `dev.mjs` applies defaults then the seed.
- [ ] `npm run check`, commit, PR.

### Task 3 (M3): Service layer — audited writes, summaries, undo

**Files:** Create `src/services/errors.ts`, `change.ts`, `leads.ts`, `deals.ts`, `activities.ts`, `tasks.ts`, `read.ts`, tests beside each.

**Interfaces:**
- Consumes: task 2.
- Produces:
  - `class UserError extends Error`; `type Actor = "owner" | "ai" | "system"`; `interface Ctx { db: Db; now: Date; actor: Actor; tool: string }`.
  - `interface RowChange { table: TableName; id: string; before: Row | null; after: Row | null }`; `interface ChangeResult { changeId: string; summary: string }`.
  - `commitChange(ctx, { target: { table, id }, summary, changes: RowChange[], extra?: D1PreparedStatement[] }): Promise<ChangeResult>`: inserts when `before` is null, updates (guarded by version) when both are set, deletes when `after` is null (used by undo only), runs `extra`, writes the audit row, all in one `db.batch`.
  - `undoChange(ctx, changeId): Promise<ChangeResult>`: refuses (UserError) when unknown, already undone, itself an undo, or any touched row's current state differs from `after`; maps a foreign-key failure to "Can't undo chg_x: other records now depend on it (…). Change those first, or leave it."
  - `addLead(ctx, { name, email?, phone?, business?, source?, notes?, dealTitle?, value?, nextStep?, nextAt?, fields?, contactFields? })` → contact (or matched by email) + deal in first open stage + `note` activity when notes given.
  - `updateContact(ctx, contactId, patch)`; `updateDeal(ctx, dealId, { stage?, nextStep?, nextAt?, value?, fields?, status?, title? })` (stage change sets `stage_entered_at` and adds a `stage_change` activity; moving to a won/lost/not_now stage sets `status`, and vice versa); `logActivity(ctx, { dealId?, contactId?, type, summary, occurredAt? })`; `addTask(ctx, { dealId?, contactId?, title, dueAt? })`.
  - Reads in `read.ts`: `pipelineSummary(db, now, tz)`, `whatsDue(db, now, tz)`, `getDealBrief(db, dealId, tz)`, `searchContacts(db, query)`, `listDealsFiltered(db, filter, now, tz)`, `recentChanges(db, since)`.
- Deal and contact lookups accept an id or an exact (case-insensitive) name; ambiguous names throw a UserError listing the matches with ids.

Steps:
- [ ] `change.test.ts`: a commit writes rows + exactly one audit row; a failing statement leaves no rows and no audit row; summary ends with `(change chg_…)`.
- [ ] `undo.test.ts`: undo of an update restores the row and logs an `undo_change` audit row with `undo_of`; second undo refuses ("already undone"); undo after a later edit refuses ("changed since"); undo of `add_lead` after `log_activity` refuses in plain English (Review Focus 3).
- [ ] `leads.test.ts`, `deals.test.ts`, `activities.test.ts`, `tasks.test.ts`, `read.test.ts` (including empty-database answers).
- [ ] `npm run check`, commit, PR.

### Task 4 (M4): MCP endpoint

**Files:** Create `src/mcp/server.ts`, `instructions.ts`, `format.ts`, `tools-read.ts`, `tools-write.ts`, `src/auth/dev.ts`, `tests/e2e/harness.ts`, `tests/e2e/mcp.test.ts`, unit tests. Modify `src/index.ts`, `package.json`.

**Interfaces:**
- Consumes: task 3 services.
- Produces: `buildMcpServer(deps: { db: Db; now: () => Date }): McpServer` (registers every tool available so far; later tasks add theirs in the same files); `SERVER_INSTRUCTIONS: string`; `toolResult(text: string, data?: unknown)` and `toolError(err)` in `format.ts`; `devAuth(request, env): { ok: true; email: string } | { ok: false; status: 401 | 500; message: string }`; e2e `startDevServer(): Promise<{ url: string; stop(): Promise<void>; runCron(): Promise<void> }>`.

Steps:
- [ ] Read the Agents docs (developers.cloudflare.com/agents/model-context-protocol/ and the `createMcpHandler` API page) and `node_modules/agents/dist/mcp/*.d.ts` before writing code; record what you followed in decision 0004.
- [ ] Add deps exact-pinned with `--before=2026-11-11T23:59:59Z`: `agents@0.33.0`, `@modelcontextprotocol/sdk@1.32.2`, `zod@4.6.7`.
- [ ] Unit tests over `InMemoryTransport` + SDK `Client`: every read tool has `annotations.readOnlyHint === true`, every write tool `false`; the list of tool names equals the spec's lists minus tools whose tasks are not built yet; bad input returns `isError` with a plain-English message naming the field; writes return one line ending `(change chg_…)`; untrusted text comes back inside `untrusted_text` / `untrusted_fields`; `SERVER_INSTRUCTIONS` contains the four spec rules; empty database answers.
- [ ] `devAuth` tests: allowed only when `ENVIRONMENT === "development"`, `AUTH_MODE === "dev"` and the request host is `localhost`, `127.0.0.1` or `[::1]`; `ENVIRONMENT === "production"` with `AUTH_MODE=dev` returns 500 "misconfigured" for every route (fail closed); no `AUTH_MODE` in production returns 401 until task 10 adds OAuth.
- [ ] e2e harness: fresh `--persist-to` dir in the OS temp folder, migrations, defaults + seed, `wrangler dev --local --test-scheduled` on a free port; `mcp.test.ts` connects with `StreamableHTTPClientTransport` and lists tools.
- [ ] `npm run check`, commit, PR.

### Task 5 (M5): Building blocks — stages, fields, tasks, rulebook, settings

**Files:** Create `src/services/stages.ts`, `fields.ts`, `rulebook.ts`, `settings.ts`, extend `tasks.ts`, tools in `tools-read.ts` / `tools-write.ts`, tests.

**Interfaces:** `addStage(ctx, { label, kind?, after? })` (key = slug of label, unique), `updateStage(ctx, key, { label?, position? })` (reorder renumbers all positions), `archiveStage(ctx, key)` (refuses while open deals sit in it: "3 open deals are in Call done: … Move them first with update_deal, for example to Replied."); `addField(ctx, { entity, label, type, choices? })`, `updateField(ctx, id, { label?, choices?, archived? })`, `validateFieldValues(defs, entity, values)` (UserError on unknown key, wrong type, choice not listed); `completeTask(ctx, id)`, `snoozeTask(ctx, id, until)`; `getRulebook(db, name?)`, `updateRulebook(ctx, name, markdown)`; `getSettings(db)`, `updateSettings(ctx, patch)` (timezone checked with `Intl.DateTimeFormat`, brief hour 0–23, email shape). Tools: `list_stages`, `list_fields`, `get_rulebook`, `get_settings`, `add_stage`, `update_stage`, `archive_stage`, `add_field`, `update_field`, `complete_task`, `snooze_task`, `update_rulebook`, `update_settings`. Owner emails are not changeable through MCP (decision 0005).

- [ ] TDD each service, then each tool; every write undoable (test one undo per service); renaming "Call done" to "Met" keeps the key `call_done`.
- [ ] `npm run check`, commit, PR.

### Task 6 (M6): Rules engine

**Files:** Create `src/rules/engine.ts`, `src/services/rules.ts`, `src/cron.ts`, tests. Modify `wrangler.jsonc` (`triggers.crons: ["0 * * * *"]`), `src/index.ts` (`scheduled`).

**Interfaces:** `type RuleParams = { type: "stage_followup"; stage: string; days: number; title?: string } | { type: "on_stage_enter"; stage: string; title: string; dueInDays: number } | { type: "gone_quiet"; days: number }`; `evaluateRules({ now, rules, deals, activities, firedKeys }): Firing[]` with `Firing { ruleId, dealId, fireKey, title, dueAt }`; fire key `${ruleId}:${dealId}:${stageEnteredAt}` (gone_quiet: no firings); `quietDeals({ now, rules, deals }): { dealId, ruleId, quietDays }[]`; `previewRule(params, { now, deals, activities }): { dealId, title, contactName, wouldFireAt }[]` over the last 30 days, using `stage_change` activities to rebuild stage history; title templates `{deal}`, `{contact}`, `{stage}`. Services `addRule`, `updateRule`, `pauseRule`, `resumeRule`, `listRules`; `runRules(db, now)` writes each firing as its own `system` change with the `rule_firings` insert in `extra` (so undoing the task does not re-fire). `on_stage_enter` fires only for stage entries after the rule was created.

- [ ] Pure engine tests (each type, paused rules ignored, idempotency: running twice creates one task, a second stage entry fires again), preview tests, cron test, tool tests (`add_rule`, `update_rule`, `pause_rule`, `resume_rule`, `list_rules`, `preview_rule`), list_deals `quiet` filter.
- [ ] Note in `docs/PAID-PLAN.md`: cron triggers are on the free plan; the hourly run's CPU time is the risk.
- [ ] `npm run check`, commit, PR.

### Task 7 (M7): Daily brief

**Files:** Create `migrations/0002_briefs.sql` (`briefs(id, local_date TEXT NOT NULL UNIQUE, composed_at, text, items TEXT, sent_at, send_status)`), `src/brief/compose.ts`, `run.ts`, `send.ts`, tests; extend `migrations.test.ts` ("from the previous version": 0001 with data, then 0002).

**Interfaces:** `composeBrief({ now, tz, tasks, quietDeals, newLeads }): { localDate: string; lines: string[]; text: string }` (pure; sections Overdue, Due today, Gone quiet, New leads; one line per item; "Nothing due today." when empty); `shouldRunBrief(now, settings, lastBriefLocalDate): boolean` (true once per local day at or after the brief hour); `runBrief(env, now)` stores the brief; `sendBrief(env, brief, settings)` posts to Resend only when `settings.brief_enabled`, `env.BRIEF_SENDING === "on"`, `env.RESEND_API_KEY`, `env.BRIEF_FROM` and `settings.brief_email` are all set; otherwise returns `{ sent: false, reason }`. Tests mock `fetch`; no real email.

- [ ] TDD compose (DST days included), schedule, run, send-off-by-default; `npm run check`, commit, PR.

### Task 8 (M8): `/intake`

**Files:** Create `src/http/intake.ts`, tests. Modify `src/index.ts`, `wrangler.jsonc` (`ratelimits` binding `INTAKE_RATE_LIMIT`, placeholder namespace id, 5 per 60 s; same in `previews`).

**Interfaces:** `handleIntake(request, env, now): Promise<Response>`. Header `X-Intake-Secret`, compared in constant time (SHA-256 both, XOR loop). JSON or form-encoded body `{ name, email, phone?, business?, message, source? }`, cap 16 KB (413). Rate limit by `CF-Connecting-IP` (429). Creates or matches the contact by email, deal in the first open stage, `form` activity with the message in `untrusted_text`, `untrusted_fields` set for every contact field it wrote. Same email and same message within 10 minutes returns 200 without a second deal. Errors: `{"ok":false,"error":"…"}` with no internals.

- [ ] Tests: wrong/missing secret 401, oversize 413, rate limit 429, bad email 400, match by email, dedupe (Review Focus 2), injection text changes nothing but its own lead (audit log has exactly one new change); `npm run check`, commit, PR.

### Task 9 (M9): Board — read-only views and export

**Files:** Create `src/board/pages/{home,deal,rules,changes,brief,export}.ts`, `src/http/api.ts`, `src/http/export.ts`, `src/http/csv.ts`, tests. Modify `src/board/routes.ts` (seed deal path), `public/board.css`, `tests/a11y/*`.

**Interfaces:** pages render with `renderPage`; routes `/` (deals by stage, due today, latest brief excerpt), `/deals/:id`, `/rules`, `/changes`, `/brief`, `/export`; API `/api/pipeline`, `/api/due`, `/api/deals/:id`, `/api/rules`, `/api/changes`, `/api/brief`, `/api/export.json`, `/api/export/:table.csv` (tables: contacts, deals, activities, tasks, stages, field_defs, rules, rule_firings, rulebook, settings, audit_log, briefs). `toCsv(rows): string` (RFC 4180, CRLF, quotes doubled, formula guard: prefix `'` when a cell starts with `=`, `+`, `-`, `@`). Untrusted text shown with a visible "From outside" label. All board GETs are read-only.

- [ ] Use the `human-touch-design` and `accessibility` skills; reuse the palette tokens from `docs/STYLE-GUIDE.md`. Tests: each page 200 with seed data and with an empty database; CSV round-trip (Review Focus 4); export contains every table. `npm run build`, `npm run test:a11y`, `npm run test:lighthouse` pass locally; `npm run check`, commit, PR.

### Task 10 (M10): Production auth

**Files:** Create `src/auth/access-jwt.ts`, `src/auth/oauth.ts`, `docs/ACCESS-SETUP.md`, tests. Modify `src/index.ts`, `wrangler.jsonc` (`OAUTH_KV` binding with placeholder id), `docs/SECRETS.md`.

**Interfaces:** `verifyAccessJwt(token, { teamDomain, aud, fetchJwks? }): Promise<{ email: string }>` (RS256 via Web Crypto, checks `iss`, `aud`, `exp`, `nbf`; JWKS cached per isolate); board and `/api` require a valid JWT whose email is in `settings.owner_emails` or `env.OWNER_EMAILS`. `/mcp` wrapped by `OAuthProvider` from `@cloudflare/workers-oauth-provider@1.2.4` with Access for SaaS (OIDC) as the upstream: `/authorize`, `/callback`, `/token`, `/register`; the callback verifies the id token and the owner email. Follow the Cloudflare docs "Secure MCP servers with Access for SaaS" and the Agents authorization page; record in decision 0006. Dev auth from task 4 stays the only alternative and only in local dev.

- [ ] Tests with a locally generated RSA key: valid, wrong aud, expired, wrong issuer, email not allowed; `/mcp` without a token is 401 in production; dev auth refused in production. `docs/ACCESS-SETUP.md` has exact dashboard clicks (Access for SaaS app, self-hosted app for the board, bypass policy for `/intake` and the OAuth paths). `npm run check`, commit, PR.

### Task 11 (M11): Many copies

**Files:** Create `config/wrangler.copy.template.jsonc`, `scripts/copies.mjs` (`provision`, `update`, `export`), `scripts/import-csv.ts`, `src/import/plan.ts`, `docs/INSTALL.md`, `docs/UPDATING.md`, tests. Modify `.gitignore` (`/.copies/`, `/exports/`), `package.json` (`copies:provision`, `copies:update`, `copies:export`, `import:contacts`).

**Interfaces:** every external command goes through `run(cmd: string[], opts)` that tests replace with a recorder; `PIPELINE_WRANGLER` env var points the scripts at a stub. `provision --copy <name>`: `d1 create` (prod and preview), `kv namespace create`, writes `.copies/<name>/wrangler.jsonc` and `copy.json`, applies migrations `--remote`, `d1 execute --file seed/defaults.sql --remote`, `secret put` for each secret name (interactive). `update [--copy <name>]`: for each copy, checks `wrangler whoami` lists the copy's `account_id`, applies migrations, then deploys with that config; `--dry-run` prints the commands. `planImport(csvText, existing): { create: Row[]; merge: { id, changes }[]; skipped: { line, reason }[] }` (match by email); default is dry run; `--apply` writes through SQL with audit rows (actor owner, tool `import`); imported text goes into `untrusted_fields`. `export --copy <name> | --local` writes JSON + CSV per table into `exports/`. Decision 0007 (update mechanism).

- [ ] Tests with the recorder (exact command sequences, no client values in tracked files), import plan tests (Review Focus 4), "migrations from the previous version" for every migration. Never run against a real account. `npm run check`, commit, PR.

### Task 12 (M12): Acceptance

**Files:** Create `docs/ACCEPTANCE.md`, `tests/e2e/acceptance.test.ts`.

- [ ] One test per spec sentence (1–12) against `startDevServer()`, through MCP tools only (plus `/intake` for 12 and the cron trigger where rules matter). Sentence 7 reads the rulebook and logs an `email` activity. Sentence 10 calls `preview_rule` before `add_rule`. Sentence 12 posts the injection text, then asserts one new contact, deal and activity, an unchanged count of every other row, and the audit log holding only the intake change.
- [ ] `npm run check`, commit, PR. Final STATUS update.
