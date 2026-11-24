-- 0016: standalone tasks (decision 0046). A task may belong to a deal, a contact, or neither: the owner's own to-dos.
-- SQLite cannot drop a CHECK in place, so tasks is rebuilt with the same columns, types, defaults and indexes (and
-- untrusted_fields from 0002) without CHECK (deal_id IS NOT NULL OR contact_id IS NOT NULL). Every row, id and version
-- is kept.

-- rule_firings.task_id points at tasks, so foreign keys are checked at the end of the migration, and tasks is copied
-- aside, dropped and created again under the same name (as 0006 did for rules).
PRAGMA defer_foreign_keys = true;

-- Dropping a table deletes its rows first, and that runs rule_firings' ON DELETE SET NULL: each firing's task link is
-- kept aside here and put back once the tasks are back.
CREATE TABLE rule_firing_tasks AS SELECT id, task_id FROM rule_firings WHERE task_id IS NOT NULL;

CREATE TABLE tasks_copy AS SELECT * FROM tasks;

DROP TABLE tasks;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  deal_id TEXT REFERENCES deals (id),
  contact_id TEXT REFERENCES contacts (id),
  title TEXT NOT NULL,
  due_at TEXT,
  done_at TEXT,
  snoozed_until TEXT,
  -- 'owner', or the id of the rule that created the task.
  source TEXT NOT NULL DEFAULT 'owner',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  untrusted_fields TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(untrusted_fields) AND json_type(untrusted_fields) = 'array')
) STRICT;

INSERT INTO tasks (id, deal_id, contact_id, title, due_at, done_at, snoozed_until, source, version, created_at, updated_at, untrusted_fields)
  SELECT id, deal_id, contact_id, title, due_at, done_at, snoozed_until, source, version, created_at, updated_at, untrusted_fields
  FROM tasks_copy ORDER BY rowid;

DROP TABLE tasks_copy;

UPDATE rule_firings SET task_id = (SELECT k.task_id FROM rule_firing_tasks k WHERE k.id = rule_firings.id)
  WHERE id IN (SELECT id FROM rule_firing_tasks);

DROP TABLE rule_firing_tasks;

CREATE INDEX tasks_deal ON tasks (deal_id);
CREATE INDEX tasks_contact ON tasks (contact_id);
CREATE INDEX tasks_open_due ON tasks (due_at) WHERE done_at IS NULL;
