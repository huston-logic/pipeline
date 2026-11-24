# How this repo is built

The build rules for runs in this repo. The full rule list arrives with run 7's second PR.

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
