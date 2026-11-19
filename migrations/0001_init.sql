-- 0001: the whole v1 schema. Forward-only: later changes go in new 000N_*.sql files, never edits here.
-- Every table is STRICT. Flags are INTEGER 0/1, JSON is TEXT checked with json_valid, times are UTC ISO strings
-- ("2026-11-19T22:00:00.000Z"). Every mutable table has `version`, bumped on each update; writes are guarded with
-- write_guard (see below). D1 enforces foreign keys.

CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  brief_hour INTEGER NOT NULL DEFAULT 7 CHECK (brief_hour BETWEEN 0 AND 23),
  brief_email TEXT,
  brief_enabled INTEGER NOT NULL DEFAULT 0 CHECK (brief_enabled IN (0, 1)),
  owner_emails TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(owner_emails) AND json_type(owner_emails) = 'array'),
  last_brief_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE stages (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('open', 'won', 'lost', 'not_now')),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE field_defs (
  id TEXT PRIMARY KEY,
  entity TEXT NOT NULL CHECK (entity IN ('contact', 'deal')),
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'number', 'date', 'choice')),
  choices TEXT CHECK (choices IS NULL OR (json_valid(choices) AND json_type(choices) = 'array')),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (entity, key)
) STRICT;

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  business TEXT,
  source TEXT,
  notes TEXT,
  fields TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fields) AND json_type(fields) = 'object'),
  untrusted_fields TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(untrusted_fields) AND json_type(untrusted_fields) = 'array'),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE UNIQUE INDEX contacts_email ON contacts (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX contacts_name ON contacts (name);

CREATE TABLE deals (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts (id),
  title TEXT NOT NULL,
  stage_key TEXT NOT NULL REFERENCES stages (key),
  value REAL,
  next_step TEXT,
  next_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost', 'not_now')),
  fields TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fields) AND json_type(fields) = 'object'),
  stage_entered_at TEXT NOT NULL,
  last_activity_at TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX deals_contact ON deals (contact_id);
CREATE INDEX deals_stage ON deals (stage_key);

CREATE TABLE activities (
  id TEXT PRIMARY KEY,
  deal_id TEXT REFERENCES deals (id),
  contact_id TEXT REFERENCES contacts (id),
  type TEXT NOT NULL CHECK (type IN ('form', 'email', 'call', 'meeting', 'note', 'stage_change', 'system')),
  summary TEXT NOT NULL,
  untrusted_text TEXT,
  data TEXT CHECK (data IS NULL OR (json_valid(data) AND json_type(data) = 'object')),
  occurred_at TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('owner', 'ai', 'system')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (deal_id IS NOT NULL OR contact_id IS NOT NULL)
) STRICT;

CREATE INDEX activities_deal ON activities (deal_id, occurred_at);
CREATE INDEX activities_contact ON activities (contact_id, occurred_at);

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
  CHECK (deal_id IS NOT NULL OR contact_id IS NOT NULL)
) STRICT;

CREATE INDEX tasks_deal ON tasks (deal_id);
CREATE INDEX tasks_contact ON tasks (contact_id);
CREATE INDEX tasks_open_due ON tasks (due_at) WHERE done_at IS NULL;

CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('stage_followup', 'on_stage_enter', 'gone_quiet')),
  params TEXT NOT NULL CHECK (json_valid(params) AND json_type(params) = 'object'),
  description TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by TEXT NOT NULL CHECK (created_by IN ('owner', 'ai', 'system')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- One row per rule firing. fire_key ("<rule>:<deal>:<stage entered at>") makes firing idempotent.
CREATE TABLE rule_firings (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES rules (id),
  deal_id TEXT NOT NULL REFERENCES deals (id),
  fire_key TEXT NOT NULL UNIQUE,
  task_id TEXT REFERENCES tasks (id) ON DELETE SET NULL,
  fired_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX rule_firings_rule ON rule_firings (rule_id);
CREATE INDEX rule_firings_deal ON rule_firings (deal_id);
CREATE INDEX rule_firings_task ON rule_firings (task_id);

CREATE TABLE rulebook (
  name TEXT PRIMARY KEY,
  markdown TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- One row per change. before_json / after_json hold {"<table>:<id>": row | null} for every row the change touched.
-- No foreign keys: the log names rows in any table and must keep naming them after they change.
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('owner', 'ai', 'system')),
  tool TEXT NOT NULL,
  target_table TEXT NOT NULL,
  target_id TEXT NOT NULL,
  before_json TEXT NOT NULL CHECK (json_valid(before_json) AND json_type(before_json) = 'object'),
  after_json TEXT NOT NULL CHECK (json_valid(after_json) AND json_type(after_json) = 'object'),
  summary TEXT NOT NULL,
  undone_at TEXT,
  undone_by TEXT,
  undo_of TEXT
) STRICT;

CREATE INDEX audit_log_at ON audit_log (at);
CREATE INDEX audit_log_target ON audit_log (target_table, target_id);

-- Optimistic locking inside a D1 batch: "INSERT INTO write_guard (ok) SELECT COUNT(*) = 1 FROM <t> WHERE id = ?
-- AND version = ?" fails the CHECK when the row changed, which aborts the whole batch. The batch ends with
-- "DELETE FROM write_guard", so the table stays empty.
CREATE TABLE write_guard (
  ok INTEGER NOT NULL CHECK (ok = 1)
) STRICT;
