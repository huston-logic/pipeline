-- 0021: projects, shaped (decision 0056). Project statuses gain a kind (open or closed) and can be archived; a project
-- may have no person and carries custom fields; an activity may belong to a project alone; custom fields and saved views
-- can be for projects. SQLite cannot change a CHECK or a NOT NULL in place, so projects, activities, field_defs and views
-- are rebuilt with the same columns, types, defaults and indexes as before (0001, 0013 and 0020), apart from the changes
-- named here. Every row, id, version and timestamp is kept, in the same rowid order.

-- tasks, activities and time_entries point at projects, and time_entries at activities (all NO ACTION), so foreign keys
-- are checked at the end of the migration; the tables are copied aside, dropped and created again under the same name.
PRAGMA defer_foreign_keys = true;

ALTER TABLE project_statuses ADD COLUMN kind TEXT NOT NULL DEFAULT 'open' CHECK (kind IN ('open', 'closed'));
ALTER TABLE project_statuses ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1));
UPDATE project_statuses SET kind = 'closed' WHERE key = 'done';

CREATE TABLE projects_copy AS SELECT * FROM projects;

DROP TABLE projects;

CREATE TABLE projects (
  -- "pj_" and 12 base32 characters.
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200 AND instr(name, char(10)) = 0 AND instr(name, char(13)) = 0),
  -- NULL for an internal project, with no person.
  contact_id TEXT REFERENCES contacts (id),
  -- The won deal it came from; NULL for a project made by hand.
  deal_id TEXT REFERENCES deals (id),
  -- No default: every insert names its status.
  status_key TEXT NOT NULL REFERENCES project_statuses (key),
  -- ISO strings: a local date at midnight, as a task's due date with no time.
  start_at TEXT,
  target_at TEXT,
  notes TEXT,
  fields TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fields) AND json_type(fields) = 'object'),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  -- Always '[]' for now; kept for a later import.
  untrusted_fields TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(untrusted_fields) AND json_type(untrusted_fields) = 'array'),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT INTO projects (id, name, contact_id, deal_id, status_key, start_at, target_at, notes, archived, untrusted_fields, version, created_at, updated_at)
  SELECT id, name, contact_id, deal_id, status_key, start_at, target_at, notes, archived, untrusted_fields, version, created_at, updated_at
  FROM projects_copy ORDER BY rowid;

DROP TABLE projects_copy;

CREATE INDEX projects_contact ON projects (contact_id);
CREATE INDEX projects_deal ON projects (deal_id);
CREATE INDEX projects_status ON projects (archived, status_key);

CREATE TABLE activities_copy AS SELECT * FROM activities;

DROP TABLE activities;

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
  project_id TEXT REFERENCES projects (id),
  CHECK (deal_id IS NOT NULL OR contact_id IS NOT NULL OR project_id IS NOT NULL)
) STRICT;

INSERT INTO activities (id, deal_id, contact_id, type, summary, untrusted_text, data, occurred_at, actor, version, created_at, project_id)
  SELECT id, deal_id, contact_id, type, summary, untrusted_text, data, occurred_at, actor, version, created_at, project_id
  FROM activities_copy ORDER BY rowid;

DROP TABLE activities_copy;

CREATE INDEX activities_deal ON activities (deal_id, occurred_at);
CREATE INDEX activities_contact ON activities (contact_id, occurred_at);
CREATE INDEX activities_occurred ON activities (occurred_at);
CREATE INDEX activities_project ON activities (project_id);

CREATE TABLE field_defs_copy AS SELECT * FROM field_defs;

DROP TABLE field_defs;

CREATE TABLE field_defs (
  id TEXT PRIMARY KEY,
  entity TEXT NOT NULL CHECK (entity IN ('contact', 'deal', 'project')),
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

INSERT INTO field_defs (id, entity, key, label, type, choices, archived, version, created_at, updated_at)
  SELECT id, entity, key, label, type, choices, archived, version, created_at, updated_at
  FROM field_defs_copy ORDER BY rowid;

DROP TABLE field_defs_copy;

CREATE TABLE views_copy AS SELECT * FROM views;

DROP TABLE views;

CREATE TABLE views (
  -- "vw_" and 12 base32 characters.
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  module TEXT NOT NULL CHECK (module IN ('people', 'deals', 'projects')),
  -- JSON object: person_status, sub_status, source, q, fields { <key>: value } and, for deals, stage. Keys, not labels.
  filters TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(filters) AND json_type(filters) = 'object'),
  -- "<key>-<asc|desc>", for example "name-asc"; the keys a module takes are checked by src/services/views.ts.
  sort TEXT NOT NULL,
  layout TEXT NOT NULL DEFAULT 'cards' CHECK (layout IN ('cards', 'table')),
  -- JSON array of column keys: built-in ones, and "fields.<key>" for a custom field.
  columns TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(columns) AND json_type(columns) = 'array'),
  -- 1-based place among the live views of its module, in the view switch after the built-in views.
  position INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT INTO views (id, name, module, filters, sort, layout, columns, position, archived, version, created_at, updated_at)
  SELECT id, name, module, filters, sort, layout, columns, position, archived, version, created_at, updated_at
  FROM views_copy ORDER BY rowid;

DROP TABLE views_copy;

CREATE INDEX views_module ON views (module, archived, position);
