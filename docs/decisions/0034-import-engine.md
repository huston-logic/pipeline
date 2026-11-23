# 0034: One import engine

Run 5, task I1, 2026-11-22. Builds on 0007 (copy scripts), 0029 (leads in the import) and 0013 (the CSV formula guard).

## Context

The CSV import knew only contacts: `src/import/plan.ts` read the header, cleaned the values and planned the rows in
one function. Run 5 adds a board import with a column-mapping step, then deals and tasks. Each would copy the header
rules, the cleaning and the refusals unless they live in one place.

## Decision

- `src/import/engine.ts` is the one engine. `readCsv` reads the file (`src/http/csv.ts` parses it). `autoMatch` says
  where each header cell goes, as a `Target`: a module column (by key, then by alias), then a custom field of the
  module's entity that is not archived (by key or label). Names are trimmed and compared ignoring capitals. Anything
  else is `skip`, and its non-blank name is listed in `skippedColumns`. `mapRows` cleans each row: the export's
  formula guard comes off, control characters go, line breaks become spaces except in a multiline column, values are
  trimmed, and an empty cell is null. `planCsv` runs all three and hands the rows to the module.
- `mapRows` is the one gate for the header, whoever chose the mapping: an empty file, a column or field named twice,
  and a missing required column are refused with the same plain messages as before. `autoMatch` itself never
  refuses, so a mapping screen can show a bad header and let the owner fix it.
- A module (`ImportModule`) is data plus two functions: its key, its noun, whose custom fields it fills, its columns
  (`ColumnDef`: key, label, aliases, limit, multiline, required), a `plan` for the mapped rows and a `change` that
  builds the one audited change. `src/import/modules/people.ts` is today's contact import as a module;
  `src/import/modules/index.ts` lists the modules by key.
- `lead_status` is a People column like the others, so the header rule is still "built-in column, then
  `lead_status`, then a contact field". The People plan reads it only for new people, by its value, as before, and
  leaves it out of the empty-row and length checks. The missing-header message still lists the six record columns
  (`hintColumns`).
- The `notes` and `new_field` targets are in the type now. Their behaviour comes with the board import (task I3);
  until then `mapRows` refuses them.
- `planImport`, `importChange` and the old exports stay as thin wrappers over the People module. The import script
  calls the engine.

## Why

- One set of header and cleaning rules means a deals or tasks import, and the board's mapping step, refuse and clean
  exactly like the contact import.
- Keeping the wrappers lets every existing test and caller (the CPU check, the round-trip tests) run unchanged, which
  proves the refactor changed no behaviour.
- `mapRows` takes the header as well as the targets, so a skip reason can name the column as the owner wrote it.

## Consequences

- A new module needs only its definition; a test builds a fake one and imports it end to end.
- `mapRows(module, records, targets, header)` has a fourth argument the run plan did not list: the header names.
- The wrappers can go once nothing calls them; until then they are the People module under its old names.
