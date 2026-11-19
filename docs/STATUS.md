# Autonomous run status

Spec: `docs/SPEC.md`. Plan: `docs/PLAN.md`. Rules: CLAUDE.md, "Autonomous runs". Run 1 started 2026-11-18.
Updated after every merge, so a fresh chat can pick up where the last one stopped.

## Tasks

| # | Task | PR | State |
| --- | --- | --- | --- |
| 0 | Spec, plan, status | [#1](https://github.com/huston-logic/pipeline/pull/1) | merged |
| 1 | M1 repo identity and engine skeleton | [#2](https://github.com/huston-logic/pipeline/pull/2) | merged |
| 2 | M2 D1 schema, migrations, seed, data access | [#3](https://github.com/huston-logic/pipeline/pull/3) | merged |
| 3 | M3 service layer, audit, undo | [#4](https://github.com/huston-logic/pipeline/pull/4) | merged |
| 4 | M4 MCP endpoint | [#5](https://github.com/huston-logic/pipeline/pull/5) | merged |
| 5 | M5 building blocks | [#6](https://github.com/huston-logic/pipeline/pull/6) | merged (a11y needed one re-run: CI runner apt mirror glitch) |
| 6 | M6 rules engine | [#7](https://github.com/huston-logic/pipeline/pull/7) | open, auto-merge queued |
| 7 | M7 daily brief | | not started |
| 8 | M8 `/intake` | | not started |
| 9 | M9 board | | not started |
| 10 | M10 production auth | | not started |
| 11 | M11 many copies | | not started |
| 12 | M12 acceptance | | not started |

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
  stages (Won, Lost, Not now) are refused because they could never fire.

## Dependencies added

- `typescript-eslint` 8.72.2 (dev, exact; replaces `eslint-config-next`). PR #2.
- Removed: `next`, `react`, `react-dom`, `tailwindcss`, `@tailwindcss/turbopack`, `eslint-config-next`,
  `@types/react`, `@types/react-dom`. PR #2.
- `agents` 0.33.0, `@modelcontextprotocol/server` 2.4.0, `zod` 4.6.7 (runtime, exact); `@modelcontextprotocol/client`
  2.4.0 (dev, exact; also a peer of `agents`). PR #5. Worker bundle about 0.24 MB gzip (free plan limit 3 MB).

## STOP queue (needs the owner)

1. **CI cleanup (owner-only file).** `.github/workflows/ci.yml` still runs `npm run check:placeholders`
   (continue-on-error), a script that no longer exists, and two comments describe the old website. The proposed file is
   in the hand-copy batch (see the end of the run summary).
2. **Local Playwright browser is one revision behind.** This Mac has Chromium revision 1248; `@playwright/test`
   1.65.0 needs 1254, so `npm run test:a11y` fails locally at browser launch (CI installs its own and is fine). To fix,
   run `npx playwright install chromium` in your own terminal (installing a browser needs your approval).
3. **One leftover temp folder** from a manual test (harmless, nothing secret; the hook stops me deleting outside the
   repo): `rm -r /var/folders/xf/zt8g4lzn0211myfvc6kzmt0r0000gn/T/pipeline-e2e-p134is`

## How to resume

1. `git switch main && git pull --ff-only`
2. Read `docs/SPEC.md`, `docs/PLAN.md` and this file. Start at the first task not marked merged.
3. The run's working ledger is `.superpowers/sdd/PLAN/progress.md` (git-ignored, on this Mac only).
