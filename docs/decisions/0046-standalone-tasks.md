# 0046: Standalone tasks

Run 6, task B3, 2026-11-24. Builds on 0037 (the tasks import), 0044 (proposals) and 0045 (record tools propose).
Migration 0016.

## Context

Since migration 0001 a task had to belong to a deal or a contact (`CHECK (deal_id IS NOT NULL OR contact_id IS NOT
NULL)`), so the owner could not keep a to-do that is about no one ("Buy printer ink", "Renew the van insurance").
Run 6 makes the board the owner's daily list (B4 builds Today's quick add on this), so a task must be able to belong
to a person, a deal, or nothing. The brief fixed the migration's shape and the tests; it left open how the summaries
and lists name a task of no one's, and what the tasks import does with a row that names no one.

## Decision

- **Schema (migration 0016):** `tasks` is rebuilt with the same columns, types, defaults, `untrusted_fields` (0002)
  and indexes (`tasks_deal`, `tasks_contact`, `tasks_open_due`), without the CHECK. It follows 0006: `PRAGMA
  defer_foreign_keys = true`, copy aside, drop, create under the same name, copy back in rowid order, drop the copy, so
  `rule_firings.task_id` keeps pointing at `tasks`. Dropping a table first deletes its rows, which runs
  `rule_firings`' `ON DELETE SET NULL`; the migration keeps each firing's task link aside and puts it back. Every row,
  id, version and link is kept. Activities keep their CHECK: a note is always about someone.
- **`add_task` with neither** (`deal` and `contact` both left out, over MCP, in a proposal or from code) adds a
  standalone task. `findSubject(src, refs, { optional: true })` answers no deal and no contact for it; a name or id
  that matches no one is still refused, as before. `log_activity` still needs a subject.
- **Words:** a standalone task is named by itself, with nothing about a subject: `Added task "Buy printer ink"`,
  `Added task "Buy printer ink", due Sat Nov 21, 12:00 AM`, `Completed task "Buy printer ink"`, `Snoozed task "Buy
  printer ink" until ...`; a title from outside is `task tk_...` as for any task. In a proposal's list it is
  `- New task "Buy printer ink": no person or deal; due Sat Nov 21`. The brief's line is the title and the due time
  with no brackets ("- Buy printer ink, was due Wed Nov 18, 9:00 AM"). On Today its card shows no Deal or Contact
  line; Done and Snooze go back to Today.
- **Import rule (tasks module, 0037):** a row with none of `deal_id`, `contact_id`, `email` and `name` filled becomes a
  standalone task. A row that fills any of them and matches no one is still skipped ("no person or deal matches"), so
  a misspelt name never silently turns into a task of no one's. The board's tasks export has empty `deal_id` and
  `contact_id` for a standalone task, so it imports back as one, with its id.
- **"What it caught"** counts the tasks rules made (`rule_firings`), so an owner's standalone task is not counted; it
  is left out without an error.

## Why

- Owners keep personal and business to-dos in one list; forcing a fake contact ("Me") onto them would put fake
  people into reports, views and the export.
- The rule is the database's only real constraint on a task's subject; reads already used left joins (`whats_due`, the
  deal and contact pages, the people views' next task), so no read had to change shape, only the words.
- Skipping an unmatched name keeps the import's old promise (a task never lands on the wrong person, and nothing is
  guessed) while letting a plain list of to-dos with only a title column import at all.

## Consequences

- Rules still make tasks on deals and leads only (their firings always name one); nothing in the rules changes.
- A standalone task appears in `whats_due`, the brief and Today, never on a deal or contact page, and in the people
  views' "next task" for no one.
- The tasks import's lede now says a task can go on no one when its line names no one.
- B4 (Today's sorting and quick add) builds on this; it adds the board's own way to add a standalone task.
