# How this repo is built

The build rules for every run in this repo. Read this first on every run. Each rule says what it is, why, when it
was decided and what enforces it; `npm run check:process` fails if a rule has no why.

## Where facts live
- Build rules for this repo: docs/PROCESS.md (this file).
- Status of this repo: docs/STATUS.md (current state, Needs Grant, For the master, the last run); older runs in docs/history/STATUS-history.md.
- Technical decisions: docs/decisions/ (read the index, docs/decisions/README.md, and open only the decisions a task needs).
- Business facts (offers, prices, priorities, clients, feature order) live in the Google Doc master "00 Huston Logic: Source of Truth" and the "09 Feature Requests" doc. Link to them by name. Never copy business facts into this repo, because it is public.

## Rules

### Fast check on commit, full check before push
**What:** Every commit runs `npm run check:fast`. It covers the config guard, lint, typecheck and only the unit tests the uncommitted change can reach. Every `git push` and `gh pr create` runs the full `npm run check`, which adds all unit tests, the e2e tests and the build. CI runs the full suite on every PR.
**Why:** Run 6 ran the full check on about 45 commits. The full check before push and in CI still guards everything that lands.
**Decided:** 2026-11-24, run 7 brief (decision 0052)
**Enforced by:** `.claude/hooks/precommit-check.mjs` (`COMMIT_SCRIPT`, `PUSH_SCRIPT`; arrives with the owner's run 7 batch, until then the hook runs the full check on every commit), `npm run check:process`, CI's required `check` job.

### check:fast falls back to everything when unsure
**What:** check:fast runs all unit tests when it is not sure which ones a change reaches. That happens for package files, tsconfig, the ESLint config, wrangler.jsonc, config/, migrations, the seed, test runtime helpers, a deleted code file, a git failure, or a file no test names. It also runs everything when over 60% of tests would be picked. Tests that scan the whole source tree always run.
**Why:** A fast check that silently skips the right test is worse than a slow one.
**Decided:** 2026-11-24, run 7 brief (decision 0052)
**Enforced by:** `scripts/test-select.mjs` and its tests.

### One PR per feature area, review per task
**What:** A run has one branch and one PR per feature area, usually 2 to 4. Each task is one commit and gets one Sonnet code review before the next task starts. The security reviewer runs only when a change touches sign-in, /mcp, /intake, email or secrets. The accessibility reviewer runs only when a change touches board markup or CSS.
**Why:** Each PR waits on CI. Fewer PRs means less waiting, and per-task review still catches problems early.
**Decided:** 2026-11-24, run 7 brief (decision 0052)
**Enforced by:** CLAUDE.md "Autonomous runs".

### Change-aware audits, full audits on main
**What:** On a PR, the a11y and lighthouse jobs always run, because they are required checks. When no board file changed, they skip their slow steps and finish in seconds. The label `full-audit` forces both. Every push to main runs both in full.
**Why:** A docs-only PR waited about 12 minutes for Lighthouse. The push to main still audits every change that lands.
**Decided:** 2026-11-24, run 7 brief (decision 0052)
**Enforced by:** `.github/workflows/ci.yml` (step-level `if:`, never `paths:` or a job-level `if:`), `scripts/board-changed.mjs`.

### One shared e2e Worker
**What:** `npm run test:e2e` sets up the database once and starts one Worker. Before each test file, it switches to a fresh copy of the database with that file's vars. Files run one at a time.
**Why:** Starting wrangler and building a database for each file took most of the e2e time. The run fell from 66.6 s to about 16 s here.
**Decided:** 2026-11-24, run 7 brief (decision 0052)
**Enforced by:** `scripts/e2e.mjs`, `tests/e2e/harness.ts`.

### Context caps
**What:** docs/STATUS.md is at most 150 lines. The newest plan in docs/superpowers/plans/ is at most 150 lines. "For the master" is at most 12 lines, with no PR numbers. Every decision is listed in docs/decisions/README.md. Agents read the index and open only what they need. docs/pipeline/ (a copy of the site template's handbook) is read only for tasks about hooks, CI or deploy.
**Why:** Agents re-read large docs on every task. STATUS.md was 623 lines, a plan 600, and 52 decisions about 370 KB.
**Decided:** 2026-11-24, run 7 brief (decision 0052)
**Enforced by:** `npm run check:process`.

### Model routing
**What:** Opus plans, coordinates and does the final whole-run review. Sonnet implements tasks and does the per-task review. Haiku reads, searches, summarizes, writes docs and STATUS, and makes mechanical edits. Each subagent gets only the files it needs. Agent roles: scout (haiku), docs-writer (haiku), implementer (sonnet), review-code (sonnet), review-a11y (sonnet), review-security (opus).
**Why:** Most of a run's work does not need the most capable model. Smaller context is cheaper and faster.
**Decided:** 2026-11-24, run 7 brief (decision 0052)
**Enforced by:** the `model:` line in each `.claude/agents/*.md` (`npm run check:process` fails without one), CLAUDE.md "Autonomous runs".

### Timing log
**What:** Every run ends with a table in docs/STATUS.md. For each PR it gives the wall-clock time, the number of commits, the time in checks and the time waiting on CI. When the checks change, re-time them and add the numbers under "Timings" in this file.
**Why:** You can only make runs faster if you measure them.
**Decided:** 2026-11-24, run 7 brief (decision 0052)
**Enforced by:** CLAUDE.md "Autonomous runs" (review, not a script).

### What still stops for Grant
**What:** These steps wait for Grant. Secrets or credentials. DNS. Accounts or money. Sending real email. Deleting user data. Lowering a threshold or changing which checks are required. Any owner-only path: .claude/hooks, .claude/agents, .claude/skills, .claude/settings*.json, .github/workflows. For those, the change goes to the scratchpad as a `.proposed` file, with one batch script. Anything that reaches a real client copy: copies:provision, copies:update, copies:export, and import:contacts for real.
**Why:** These cannot be undone easily, cost money, or change what protects main.
**Decided:** CLAUDE.md, kept by the run 7 brief.
**Enforced by:** the hooks in .claude/hooks, the "Protect main" ruleset, CLAUDE.md.

## Timings

### Before run 7 (2026-11-24)

Each step of `npm run check` run on its own, on main at `62aae9f`.

| Step | This Mac (Apple silicon, Node 24.13) | CI `check` job (ubuntu-latest, Node 22) |
| --- | --- | --- |
| check:config | 0.3 s | under 1 s |
| lint | 3.0 s | 6 s |
| typecheck | 3.4 s | 10 s |
| test:unit (1,512 tests) | 8.8 s | 161 s for unit and e2e together ("Worker tests") |
| test:e2e (56 tests, one `wrangler dev` per file) | 66.6 s | (in the line above) |
| build | 0.2 s | under 1 s |
| **Total** | **82.3 s** | **3 min 18 s job** (10 s of it `npm ci`) |

Other CI jobs on the same run: `a11y` 6 min 16 s (scan 5 min 35 s), `lighthouse` 12 min 10 s (11 min 48 s of
Lighthouse). The brief measured about 5 minutes for `npm run check` on a clean machine (unit 72 s, e2e 214 s).

The pre-commit hook runs the whole `npm run check` on every commit; run 6 made about 45 commits.

### After run 7 (2026-11-24)

Same Mac; CI from PR A's run (the first with the shared e2e Worker).

| What | Before | After |
| --- | --- | --- |
| `npm run check`, this Mac | 82.3 s | 29.9 s (1,563 unit, 56 e2e) |
| `test:e2e`, this Mac | 66.6 s | 15.7 s |
| `test:unit`, this Mac | 8.8 s | 8.5 s (one process per file kept: one process was 18.0 s) |
| `npm run check:fast`, one change to `src/board/html.ts` | (did not exist) | 5.0 s (39 test files) |
| `npm run check:fast`, docs only | (did not exist) | 3.0 s |
| CI `check` job | 3 min 18 s | 1 min 56 s |
| CI `a11y` and `lighthouse`, PR with no board change | 6 and 12 min | seconds, once the owner applies run 7's `ci.yml` |

Per commit, the hook goes from the full check (82.3 s) to `check:fast` (3 to 7 s) once the owner applies run 7's
hook batch; until then it runs the full check (now 29.9 s).
