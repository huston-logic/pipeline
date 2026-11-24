# 0052: Fast commit check, one e2e Worker and change-aware audits

Run 7 ("Speed"), 2026-11-24. Approved in the owner's run 7 brief.

## Context

Run 6 took about 7 hours. The pre-commit hook ran the whole `npm run check` on every commit (about 45 commits). The
e2e tests started a new `wrangler dev`, and set up a new database with three wrangler commands, for each of their
files: 66.6 s of the 82.3 s local check, and most of CI's 161 s of Worker tests. Every PR ran the full accessibility
scan (about 6 minutes) and Lighthouse (about 12 minutes), even PRs that changed only docs.

## Decision

- **`npm run check:fast`** (`scripts/check-fast.mjs`) runs check:config, lint (ESLint cache), typecheck (tsc
  incremental, build info in `node_modules/.cache/`) and only the unit tests the change can reach
  (`scripts/test-select.mjs`): the changed tests, the changed files' own tests, and the tests of their importers, all the way up (and those importers' own tests).
  "Changed" means not committed yet (against `HEAD`, plus untracked files), since each earlier commit was checked when
  it was made; `-- --branch` compares against where the branch left main.
  It runs every unit test when it can't tell: package files, tsconfig, ESLint config, `wrangler.jsonc`, `config/`,
  migrations, seed, the test runtime helpers, a deleted code file, a git failure, a file no test names, or more than
  60% of the tests anyway. Docs that no test names run no unit tests. `npm run check` stays the full suite, and the
  full suite is what CI runs.
- **One e2e Worker:** `npm run test:e2e` runs `scripts/e2e.mjs`, which sets up the database once as a template and
  starts the Worker once (wrangler's `unstable_startWorker`, the same vars as `wranglerDevArgs`, the cron test route).
  Before each file it switches the Worker to a new copy of the template with that file's extra vars (about 0.3 s), so
  each file still starts on a fresh database. Files run one at a time because they share the Worker. A file run on
  its own starts its own `wrangler dev`, as before. Every test and assertion is unchanged.
- **Unit tests in one process** (`--test-isolation=none`) were measured and not used: the same 1,525 tests passed but
  took 18.0 s against 9.5 s with one process per file.
- **Change-aware audits:** `scripts/board-changed.mjs` prints `board=true` or `board=false` for CI's `a11y` and
  `lighthouse` jobs. On a pull request with no board file changed, those jobs skip their slow steps (step-level `if:`)
  and end green in seconds; the jobs themselves always run, so the required checks always report. Board files: `src/`
  except `src/mcp/` and unit tests, `public/`, the build, dev and seed scripts, the Lighthouse and Playwright configs,
  `tests/a11y/`, migrations, seed, `wrangler.jsonc`, the package files and `ci.yml`. A push to main, the label
  `full-audit`, or any doubt (git fails, no base) runs the full audit.
- **Owner-only half:** the hook (commit runs `check:fast`, `git push` and `gh pr create` run `check`), the `ci.yml`
  steps and the model-routed agent files are owner-edited, so run 7 hands them over as proposals with one batch script.
  The batch also turns on `check:process` inside `check:fast` and `check`, because that guard checks the hook file and
  would fail every commit until the new hook is in place.

## Why

The slow parts were setup, not testing: starting wrangler and building a database per file, and a full check per
commit. A fresh database per file keeps the e2e tests as independent as before. The full suite still runs before every
push and PR and in CI, and the full audits still run on every push to main, so a change that skips a check locally or
in a PR is still checked before it lands on main.

## Consequences

- `unstable_startWorker` and its reload event are unstable wrangler APIs. wrangler is pinned (4.160.1); an upgrade
  that breaks them makes `npm run test:e2e` fail loudly, and the fix is in `scripts/e2e.mjs` only.
- A board change that the path list misses would skip the PR's audits but still be audited on the push to main.
  Add a path to `scripts/board-changed.mjs` when a new folder starts drawing the board.
- Board code never imports `src/mcp` (`src/index.ts` loads it with a dynamic import), which is why `src/mcp/` is not a
  board path. If that changes, add it to `scripts/board-changed.mjs`.
- Scanner tests (unit tests that read the `src` or `scripts` folders themselves, such as the layering checks) always
  run in `check:fast` when any code file changes, since a new file can break them without being imported by them.
  Reach follows importers transitively, so a change deep in a chain still runs the tests at the top of it.
- Adding any label to a PR re-runs its CI (the `labeled` event).
