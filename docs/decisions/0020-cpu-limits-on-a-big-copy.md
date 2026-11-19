# 0020: Staying inside the free plan's CPU limit on a big copy

Run 2, task R7, 2026-11-19. Builds on 0010 (rules, preview lookback), 0013 (export), 0016 (contacts and companies)
and 0017 (kanban). The measurements are in docs/PAID-PLAN.md, "CPU check (run 2, 2026-11-19)".

## Context

The Workers free plan allows 10 ms of CPU per invocation. Measured on a fake copy with 2,000 deals (1,200 open),
1,500 contacts, 20,000 activities and about 6,000 change-log rows, four requests were at or over it: the pipeline
board (about 10.5 ms, 1.8 MB of HTML for 1,200 cards), `preview_rule` (about 15 ms), the Companies page (about 9.6 ms)
and `/api/export.json` (about 64 ms, 22 MB, and about 130 MB of memory at its peak, over the Worker's 128 MB). The spec
says nothing about how big a list may get or how the export is written.

## Decision

- **Pipeline: 50 cards per stage.** A board column and a list-view section show the 50 deals longest in their stage
  (the order they already had: `stage_entered_at`, oldest first) and, when there are more, say "Showing 50 of 240,
  longest in this stage first." with a link "Show all 240 in Replied". The stage's count, value and jump-list count
  still cover every deal. The link opens `/pipeline?view=list&stage=<key>`, the list view for that one stage, which
  shows up to 200 and says so when there are more ("Showing 200 of 205, longest in this stage first.", no link), with
  a "Show every stage" link back. Its title is "<Stage> deals". A stage that is unknown or closed, or given to the
  board view, is ignored. The route is in `boardRoutes` (with the demo seed's New inquiry), so a11y and Lighthouse
  visit it. MCP's `pipeline_summary` and `list_deals` are unchanged: they still list every open deal.
- **Preview lookback per rule.** `preview_rule` reads activities from 30 days plus the rule's own `days` before now
  (30 days for `on_stage_enter`), not 30 + 365. This replaces the "Preview lookback" paragraph of 0010 in part: the
  argument there holds with the rule's own `days` in place of the longest allowed one, because a hit is a stay or quiet
  spell that began at most `days` before its firing, and an older activity only moves that start further back. A test
  on the scaled seed checks ten rules give the same hits as a read of every activity. Migration 0005 adds
  `activities_occurred (occurred_at)`, so the read is an index range instead of a scan of the table. The engine skips
  the contact times of a deal that has no stay in the rule's stage.
- **Companies: no limit.** The page's CPU was mostly a sort that built a new collator for every comparison; with one
  shared `Intl.Collator` (same order) the page is about 5 ms at 300 companies. 0016 said to revisit the missing limit
  here; it stays without one, and is in the "near the limit" list in docs/PAID-PLAN.md.
- **Export streamed.** `/api/export.json` keeps its one-batch read (every table from the same moment) and its shape,
  `{ exportedAt, tables }`, but is written as a stream, a header, then each table a few hundred rows at a time
  (`EXPORT_ROWS_PER_CHUNK` = 250), one row per line instead of the whole file pretty-printed. The same JSON value; a
  smaller file (18 MB instead of 22 MB on the test copy).
- **MCP schemas converted once.** A tool's JSON Schema (for `tools/list`) is kept per tool name for the life of the
  isolate, instead of being converted from zod on every request. The server and tools are still built per request
  (0004).

## Why

- 50 cards is already a long column; the deals that have waited longest are the ones to act on, and the rest are one
  link away. One stage's list at 200 matches the contacts list (0016).
- A narrower lookback is exact, needs no new query, and shrinks the preview's read from a year of activities to a few
  weeks.
- Streaming does not save CPU (decoding the rows and encoding the bytes is the same work), but it keeps the export
  under the memory limit, which the old one was over on this copy.

## Consequences

- The export of a copy this size is still about 60 ms of CPU: over the free plan, whatever its shape. It costs about
  3.5 ms per MB of export, so it fits only up to about 2 to 3 MB (a few hundred deals with their history; the change
  log is half of it). Bigger copies export with `npm run copies:export` from the Mac, or move to Workers Paid
  (docs/PAID-PLAN.md).
- A stage with more than 200 open deals cannot be listed in full on the board; `list_deals` over MCP still can.
- A JSON export written before this change was indented throughout; one written after has one row per line. Both
  parse to the same value; nothing reads the layout.
- The cached JSON Schemas live as long as the isolate; a deploy starts new isolates, so a changed schema is picked up.
