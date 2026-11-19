# 0009: Change records and undo

## Context

The spec says every write is audited and undoable, and that undo refuses when the change was already undone or the
record changed since. The plan fixed the `audit_log` columns and the `write_guard` table but left open how a change
is built, how stale writes surface, exactly when undo refuses, and how later rule work (rule firings) fits in.

## Decision

- **One function writes.** `commitChange` (`src/services/change.ts`) takes a list of row snapshots and builds every
  statement from them: an insert when `before` is null, an update when both are set, a delete when `after` is null
  (only undo deletes). Table names come from a fixed allow-list with each table's primary key (`id`, `key` for
  stages, `name` for the rulebook, `id = 1` for settings); column names must be plain lowercase identifiers. The
  batch is: guards, row writes, `extra` statements, the `audit_log` insert, `DELETE FROM write_guard`.
- **Guard.** Every update or delete first runs `INSERT INTO write_guard (ok) SELECT COUNT(*) = 1 FROM <t> WHERE
  <pk> = ? AND version = ?` with the version the caller read (tables without `version`, such as `rule_firings`,
  compare every column instead). An update must bump the version by one. A failed guard aborts the batch and
  becomes the UserError "<Row> changed since you read it. Read it again and retry."
- **Snapshot format.** `before_json` and `after_json` are `{ "<table>:<id>": full row | null }` for every touched row,
  in write order. Rows are complete (`SELECT *` shape), so undo can compare and restore them column by column.
- **Undo** (`src/services/undo.ts`) writes each row's `before` back as a new change (`tool` from the caller,
  `undo_of` set) and marks the original `undone_at` / `undone_by` in the same batch, guarded so two undos can't both
  win. Restored rows get a new version (current + 1), never the old number, so stale readers still fail their guard.
  It refuses, in this order: unknown id; an undo entry ("Undo entries can't be undone; make the change again
  instead."); already undone; a row it would delete that other records now point at ("Can't undo chg_x: other
  records now depend on it (1 activity). Change those first, or leave it."); any touched row that is no longer
  exactly the change's `after` ("... changed since (see recent_changes) ..."). A foreign-key failure in the batch
  maps to the same "depend on it" message.
- **Rule firings stay outside undo.** Work that must happen with a change but must not be reversed by undoing it
  (task 6's `rule_firings` rows, which keep firing idempotent) goes in `extra`: it runs in the same batch but is not in
  the snapshot. Undoing the change that created a rule's task deletes the task; the firing row stays (its `task_id`
  is `ON DELETE SET NULL`), so the rule does not fire again for that stage entry.
- **Untrusted fields.** `untrusted_fields` names columns (`name`, `email`, ...) and custom fields as
  `fields.<key>`. `update_contact` removes every name it sets, even when the value is unchanged: the owner has now
  confirmed it.

## Why

Building the SQL from snapshots in one place keeps every service honest: no write can skip the audit row or the
guard, and undo needs no per-tool code. Comparing whole rows (not just versions) before undoing gives a plain reason
instead of a constraint error, which is what Review Focus 3 asks for.

## Consequences

- A column added by a later migration is not in older snapshots; undo leaves it as it is.
- Undo of a change whose rows have been edited since is always refused, even if the edit touched an unrelated column.
  The owner undoes the later changes first, newest first.
- The guard error is matched by its SQLite text ("CHECK constraint failed: ok = 1"); the end-to-end tests against
  `wrangler dev` (task 4) must confirm D1 reports it the same way.
