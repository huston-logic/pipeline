# 0035: One change at any size

Run 5, task I2, 2026-11-22. Builds on 0009 (change records and undo), 0020 (CPU limits) and 0034 (the import engine).

## Context

An owner's import of 126 leads was refused. The change was one audit row whose snapshot, written as literal JSON for
`wrangler d1 execute --file`, was 175 KB. D1 allows 100 KB per statement and 100 bound parameters per statement. Rows
were also written one statement each. So an import had to be split into files of about 190 rows, each its own change
and its own undo. The run asks for 2,000 rows as one audited change and one undo, all or nothing, in one D1 batch, both
in the Worker (bound values) and from the Mac (rendered SQL).

## Decision

- **Caps.** One import takes at most `IMPORT_MAX_ROWS = 2000` data rows and `IMPORT_MAX_BYTES = 1_048_576` (1 MB).
  `readCsv` (`src/import/engine.ts`) refuses more with how to split it: "This file has 2,431 rows. One import takes at
  most 2,000. Split it into two files and import each one." and "This file is 1.4 MB. One import takes at most 1 MB.
  Split it into smaller files and import each one." Blank lines are not data rows. The size is rounded up, so a file
  just over the cap says 1.1 MB, never 1.0. The number of files is a word up to nine.
- **Bulk changes.** `ChangeInput.bulk` makes `buildChange` write set by set. Per table and operation it emits guards
  (`INSERT INTO write_guard (ok) SELECT COUNT(*) = <n> FROM <t> JOIN json_each(?) ...` on id and version), inserts
  (`INSERT INTO <t> (<cols>) SELECT json_extract(...) ... FROM json_each(?)`), updates (`UPDATE <t> SET ... FROM
  json_each(?)`) and deletes (`DELETE ... WHERE <pk> IN (SELECT ... FROM json_each(?))`). Inserts go parents first,
  in `BULK_ORDER` (`src/services/change.ts`): settings, stages, field_defs, contacts, deals, tasks, activities, rules,
  rulebook, push_subscriptions. Updates come next; deletes go children first (the same list reversed). Each statement
  binds exactly one JSON parameter. Only tables with a `version` column can be written this way (not `rule_firings`);
  anything else throws.
- **Size of one row.** `mapRows` refuses, before any change is built, a value over `IMPORT_MAX_VALUE_BYTES` (40 KB)
  or a row whose values add up to more than `IMPORT_MAX_ROW_BYTES` (40 KB), measured as stored (JSON inside JSON, then
  as a SQL literal): "Line 14's "notes" value is 95 KB; one value can be at most 40 KB. Shorten it and try again." An
  undo's snapshot part holds a row twice (before and after), so a row under 40 KB always fits a 90 KB chunk. A record
  too large for one statement still throws a plain error in `chunkBy`, as a backstop for writes that don't come from
  an import.
- **Chunks.** A JSON parameter is at most `CHUNK_BYTES = 90_000`, measured as UTF-8 bytes plus one per apostrophe
  (`sqlBytes` in `src/services/bulk.ts`), because that is its size as a quoted SQL literal. With the statement text
  around it, every statement stays under 100 KB whether it is bound or rendered. `chunkRows` and `chunkBy` cut lists in
  order and refuse a single record that cannot fit alone, never cutting it.
- **Parts.** Migration 0009 adds `audit_log.parts` (default 0) and the table `audit_parts (change_id, seq,
  before_json, after_json)`. A bulk change stores `'{}'` in the audit row and its snapshot in parts of at most
  `CHUNK_BYTES` (both objects together). The snapshot is the union of the parts in seq order. `readSnapshot` in
  `src/services/change.ts` is the one way to read a snapshot; undo uses it. Old changes have `parts = 0` and are read as
  before. `audit_parts` is in the export.
- **Undo.** `undoChange` reads set-based: the current rows one statement per table, the dependents one per foreign key,
  the rule history, the JSON references and the lead checks each in one statement, ids through `json_each`. A
  2,000-row undo makes as many reads as a 100-row one. The refusals and their order are unchanged (dependents, then
  "changed since", then the invariant 1 checks), word for word. An undo of a change with parts, or of more than 50
  rows, is itself a bulk change, and its summary gives counts: "Undid chg_…: Removed 1,960 contacts and put back the
  earlier values on 40 contacts". A change of more than 50 rows that touched a table without bulk support
  (`rule_firings`) is undone row by row, still with the counts summary. Smaller undos are written and described
  exactly as before.
- **A stale bulk write** names no single row: its guards check many rows at once, so with more than one row read the
  answer is "A record this change touches changed since you read it. Read it again and retry."
- **The import** builds its change with `bulk: true`. `renderImport` renders those statements, each checked against
  `MAX_STATEMENT_BYTES`, so the CLI applies a 2,000-row file in one `wrangler d1 execute --file`.

## Why

- One JSON parameter per statement keeps every statement under both D1 limits however many rows there are, and the
  same statements work bound (the Worker) and rendered (the CLI), so the two paths cannot drift.
- `json_extract` gives back each value with its JSON type: text, an integer, a real or null. That fits the STRICT
  tables, and a test shows a bulk write stores the same values and types as a row-by-row one.
- Parts keep `audit_log` small and keep every older change readable without a data migration.
- Counts in a big undo's summary keep it one short line and never name a person from the file.

## Consequences

- A 2,000-row import of new people is 24 statements in one batch (10 inserts, the audit row, 12 parts, the guard
  clean-up). The largest rendered statement is about 91 KB. Undoing the CPU check's import of 1,600 people is 7 reads
  and 16 statements in one batch.
- **Still unknown** (docs/PAID-PLAN.md): whether D1 counts a batch as one query or one per statement toward the free
  plan's 50 per invocation. Counted per statement, an import of 2,000 rows (about 24) fits, but only just alongside
  other work.
- CPU on this Mac (docs/PAID-PLAN.md, "Run 5: import"): the import in the Worker (read the contacts, plan, one bulk
  change) is about 11 ms and its undo about 8 ms for the 2,000-row file on the 3,500-person copy, against the free
  plan's 10 ms. A board import of a full file may need Workers Paid on a big copy; the CLI runs on the Mac and has no
  such limit.
- A change in `extra` is still outside the snapshot. `rule_firings` stays out of bulk changes.
- An undo that removes a field added in the same change can remove it even though the removed contacts used it, since
  those contacts go in the same undo (rows the undo removes are never counted as dependents).
- The bulk summary capitalises its first word, as every undo summary does ("Removed 2,000 contacts").
