# Autonomous run status

Spec: `docs/SPEC.md`. Plan: `docs/PLAN.md`. Rules: CLAUDE.md, "Autonomous runs". Run 1 started 2026-11-18.
Updated after every merge, so a fresh chat can pick up where the last one stopped.

## Run 2 (started 2026-11-18)

The board becomes the owner's daily screen (docs/PLAN.md, "Run 2"; decision 0014). Updated in the first and the
closing PR of the run.

| # | Task | PR | State |
| --- | --- | --- | --- |
| 0 | Spec change: editable board (decision 0014) | this PR | open |
| R1 | Look and navigation | | |
| R2 | Contacts and companies | | |
| R3 | Pipeline as a kanban | | |
| R4 | Editing | | |
| R5 | Phone actions | | |
| R6 | Home-screen app | | |
| R7 | CPU check | | |
| R8 | Deferred minor findings | | |
| R9 | Decision wording | | |
| R10 | Owner-only proposals | | |

## Run 1 tasks

| # | Task | PR | State |
| --- | --- | --- | --- |
| 0 | Spec, plan, status | [#1](https://github.com/huston-logic/pipeline/pull/1) | merged |
| 1 | M1 repo identity and engine skeleton | [#2](https://github.com/huston-logic/pipeline/pull/2) | merged |
| 2 | M2 D1 schema, migrations, seed, data access | [#3](https://github.com/huston-logic/pipeline/pull/3) | merged |
| 3 | M3 service layer, audit, undo | [#4](https://github.com/huston-logic/pipeline/pull/4) | merged |
| 4 | M4 MCP endpoint | [#5](https://github.com/huston-logic/pipeline/pull/5) | merged |
| 5 | M5 building blocks | [#6](https://github.com/huston-logic/pipeline/pull/6) | merged (a11y needed one re-run: CI runner apt mirror glitch) |
| 6 | M6 rules engine | [#7](https://github.com/huston-logic/pipeline/pull/7) | merged |
| 7 | M7 daily brief | [#8](https://github.com/huston-logic/pipeline/pull/8) | merged |
| 8 | M8 `/intake` | [#9](https://github.com/huston-logic/pipeline/pull/9) | merged |
| 9 | M9 board | [#10](https://github.com/huston-logic/pipeline/pull/10) | merged |
| 10 | M10 production auth | [#11](https://github.com/huston-logic/pipeline/pull/11) | merged |
| 11 | M11 many copies | [#12](https://github.com/huston-logic/pipeline/pull/12) | merged |
| 12 | M12 acceptance | [#13](https://github.com/huston-logic/pipeline/pull/13) | merged |
| - | Whole-run review fixes | [#14](https://github.com/huston-logic/pipeline/pull/14) | merged |

Run 1 finished on 2026-11-18: every milestone in the spec is built, reviewed and merged. What is left needs a real
Cloudflare account or the owner (see "STOP queue" and "What's left").

## Decisions

Files in `docs/decisions/`. Rulings made while running the plan:

- Work happens in the main checkout, one branch and PR per task, each from a fresh `main` (no worktrees).
- Task 4 will use the MCP SDK v2 packages (`@modelcontextprotocol/server` 2.4.0) instead of `@modelcontextprotocol/sdk`
  1.x: the current Cloudflare docs say `createMcpHandler` (`agents/mcp/server`) serves an SDK v2 server built by a
  factory per request, and `agents` 0.33.0 requires server 2.4.0 exactly.
- Decision numbers 0004–0007 are reserved for tasks 4, 5, 10 and 11 (see PLAN.md); task 2 used 0008, task 3 0009.
- Outside text never reaches a summary, headline or error message: records whose text came from outside are named by
  id ("contact ct_…"). Deals and tasks gained `untrusted_fields` (migration 0002) so this works for every record, not
  only contacts. Plan task 7's briefs migration becomes 0003.
- Unit tests never load the `agents` package; the Worker loads the MCP handler lazily. `/mcp` is tested end to end
  against `wrangler dev --local`.
- Undo of a lead is refused once a rule has fired on its deal (rule firings are kept so the rule does not fire twice).
- Owner emails (who may sign in) cannot be changed through MCP (decision 0005); they are set at install time.
- A call or email logged against just a contact counts as activity on all of that contact's open deals.
- The last stage of each kind (open, won, lost, not now) cannot be archived, so a deal can always be closed.
- Rules count "N days" as 24-hour periods from the moment a deal entered its stage (decision 0010). Rules on closed
  stages (Won, Lost, Not now) are refused because they could never fire. A resumed or retargeted rule does not catch
  up on stage entries from before it was resumed or retargeted.
- The daily brief is composed and stored every day, whatever the "brief on/off" setting says; that setting (plus a
  deploy flag and secrets) only controls emailing it (decision 0011). Briefs are a system log, not audited or undoable.
- `/intake` is server-to-server only (no CORS; the secret must never be in browser code). A form never overwrites an
  existing contact's details; it adds a new deal and a form activity. Repeats within 10 minutes are ignored
  (decision 0012).
- The board is server-rendered with no client JavaScript; outside text shows a "From outside" label. CSV export
  guards spreadsheet formulas by prefixing `'` (decision 0013, which also lists three design defaults for you to
  look at).
- Production sign-in (decision 0006): Cloudflare Access protects the board and `/api` (the Worker also verifies the
  Access JWT); `/mcp` uses OAuth in the same Worker with Access for SaaS as the identity provider, and asks the owner
  to approve each new AI app on a consent page. `/intake` and the OAuth paths bypass Access. A copy on a custom
  domain must set `MCP_ALLOWED_HOSTNAMES`, or `/mcp` answers 403.
- The intake rate limit is 30 per minute, because it counts the website server's requests, not visitors'.
- End-to-end test files run one at a time after a single build (they raced when run in parallel).
- Copies are updated by one command the owner runs (`npm run copies:update`) with a Cloudflare login that is a member
  of each client account; no client ids or tokens live in the repo or in GitHub (decision 0007). This repo is not
  connected to Workers Builds. `/register` and `/authorize` are rate-limited (20 per minute) so anonymous traffic
  cannot use up the free plan's KV writes.
- A CSV import is one audited, undoable change; it only fills empty fields on existing contacts and marks imported text
  as outside text. Very large CSVs are refused with "split the CSV" (D1 statement size limit).
- An update never deploys a copy whose migrations did not apply (for example if the confirm prompt is answered no).
- Whole-run review fixes (PR #14): undo refuses to remove a field whose values are in use, a choice that is in use, or
  a stage a rule watches; the brief address must be an owner email (checked on save and again before sending); the
  server instructions say configuration (rulebook, settings, rules, stages, fields) changes only when the owner asks
  in the conversation; one hourly run creates at most 25 rule tasks (the rest follow next hour); update tools are
  marked destructive so AI apps ask before using them; version preview URLs are off for copies.

## Dependencies added

- `typescript-eslint` 8.72.2 (dev, exact; replaces `eslint-config-next`). PR #2.
- Removed: `next`, `react`, `react-dom`, `tailwindcss`, `@tailwindcss/turbopack`, `eslint-config-next`,
  `@types/react`, `@types/react-dom`. PR #2.
- `agents` 0.33.0, `@modelcontextprotocol/server` 2.4.0, `zod` 4.6.7 (runtime, exact); `@modelcontextprotocol/client`
  2.4.0 (dev, exact; also a peer of `agents`). PR #5. Worker bundle about 0.24 MB gzip (free plan limit 3 MB).
- `@cloudflare/workers-oauth-provider` 1.2.4 (runtime, exact; no runtime dependencies of its own). PR #11.
- Every version was at least 7 days old; lockfiles written with npm 10.9.9 and `--before=2026-11-11T23:59:59Z`.

## STOP queue (needs the owner)

1. **CI cleanup (owner-only file).** `.github/workflows/ci.yml` still runs `npm run check:placeholders`
   (continue-on-error), a script that no longer exists, and two comments describe the old website. The proposed file is
   in the hand-copy batch (see the end of the run summary).
2. **Local Playwright browser is one revision behind.** This Mac has Chromium revision 1248; `@playwright/test`
   1.65.0 needs 1254, so `npm run test:a11y` fails locally at browser launch (CI installs its own and is fine). To fix,
   run `npx playwright install chromium` in your own terminal (installing a browser needs your approval).
3. **Brief emails (Resend), per copy, only when you want sending on.** Sending is off by default and nothing in the
   repo sends email. To turn it on for one copy: in Resend, verify the sending domain and create an API key with
   "Sending access" for that domain only; then, with that copy's wrangler config, run
   `npx wrangler secret put RESEND_API_KEY -c .copies/<copy>/wrangler.jsonc`, set the vars `BRIEF_SENDING = "on"` and
   `BRIEF_FROM = "Pipeline <brief@<your domain>>"` in that copy's generated config, and ask the AI to
   `update_settings` with the brief address (it must be one of the owner emails) and brief on. Details:
   docs/SECRETS.md.
4. **Intake secret, per copy, when you connect a website form.** Generate a long random value (for example
   `openssl rand -hex 32`), then `npx wrangler secret put INTAKE_SECRET -c .copies/<copy>/wrangler.jsonc`, and put the
   same value in the website's server-side form handler as the `X-Intake-Secret` header. Until it is set, `/intake`
   answers 503. README, "Connect a website form".
5. **Cloudflare Access, per copy (dashboard).** Follow `docs/ACCESS-SETUP.md`: create the Access for SaaS (OIDC) app
   for MCP and copy its five values into the `ACCESS_*` secrets; create the self-hosted app for the board with an Allow
   policy for the owner email(s) and One-time PIN; add the Bypass rules for `/intake`, `/mcp`, `/authorize`,
   `/callback`, `/token`, `/register` and `/.well-known/`; put the team domain and AUD tag into the copy's generated
   config. Steps marked "check in the dashboard" there could not be confirmed from the docs alone. Also: Zero Trust
   Free covers up to 50 users, so no paid plan is needed.
6. **First real copy (yours, when ready).** Everything is tested only with a stub; nothing has touched a real account.
   For the first copy: ask the client to invite your Cloudflare user to their account (Manage Account > Members >
   Invite, role Administrator), run `npx wrangler login` yourself, then follow `docs/INSTALL.md`
   (`npm run copies:provision -- --copy <name>`, then `npm run copies:update -- --copy <name> --dry-run`, then without
   `--dry-run`). Confirm on that first run: (a) `d1 create` / `kv namespace create` accept `--update-config=false`;
   (b) whether a remote `d1 execute --file` import is all-or-nothing (decision 0007); (c) the Access items marked
   "check in the dashboard" in ACCESS-SETUP.md and the id-token issuer (decision 0006).
7. **One leftover temp folder** from a manual test (harmless, nothing secret; the hook stops me deleting outside the
   repo): `rm -r /var/folders/xf/zt8g4lzn0211myfvc6kzmt0r0000gn/T/pipeline-e2e-p134is`

## What's left

Nothing in the spec is unbuilt. Not yet proven, because it needs a real account or the owner:

1. A live install on a first copy (STOP 5 and 6): Access for SaaS sign-in from a real AI app, the board behind Access,
   the first remote migration, deploy and import.
2. CPU time on the free plan's 10 ms limit for `tools/list`, an hourly run with many firings, and `/api/export.json`
   on a large copy (docs/PAID-PLAN.md). Measure on the first copy before telling a client the free plan is enough.
   Also confirm in Cloudflare's limits page whether a D1 batch counts as one query or one per statement toward the
   free plan's per-invocation limit (the 25-firing cap assumes one per batch).
3. Deferred minor findings from the reviews (none blocks real use): see "Minor findings left" in the run-1 summary,
   or ask a new run to re-triage them from the code.
4. Owner-only follow-ups: the `ci.yml` cleanup (STOP 1); the `.claude/agents/review-*.md` reviewers still describe the
   old website and could be rewritten for the engine.

## How to resume

1. `git switch main && git pull --ff-only`
2. Read `docs/SPEC.md`, `docs/PLAN.md` and this file. Every plan task is merged; start from "What's left".
3. The run's working ledger was `.superpowers/sdd/PLAN/progress.md` (git-ignored, this Mac only; may be deleted).
