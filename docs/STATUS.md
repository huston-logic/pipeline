# Autonomous run status

Spec: `docs/SPEC.md`. Plan: `docs/PLAN.md`. Rules: CLAUDE.md, "Autonomous runs". Run 1 started 2026-11-18.
Updated after every merge, so a fresh chat can pick up where the last one stopped.

## Tasks

| # | Task | PR | State |
| --- | --- | --- | --- |
| 0 | Spec, plan, status | (this PR) | open |
| 1 | M1 repo identity and engine skeleton | | not started |
| 2 | M2 D1 schema, migrations, seed, data access | | not started |
| 3 | M3 service layer, audit, undo | | not started |
| 4 | M4 MCP endpoint | | not started |
| 5 | M5 building blocks | | not started |
| 6 | M6 rules engine | | not started |
| 7 | M7 daily brief | | not started |
| 8 | M8 `/intake` | | not started |
| 9 | M9 board | | not started |
| 10 | M10 production auth | | not started |
| 11 | M11 many copies | | not started |
| 12 | M12 acceptance | | not started |

## Decisions

See `docs/decisions/`.

## Dependencies added

None yet.

## STOP queue (needs the owner)

None yet.

## How to resume

1. `git switch main && git pull --ff-only`
2. Read `docs/SPEC.md`, `docs/PLAN.md` and this file. Start at the first task not marked merged.
