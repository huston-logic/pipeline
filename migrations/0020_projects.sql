-- 0020: projects. Delivery work after a sale: a project belongs to a person, may come from a won deal, and tasks, notes
-- and time can be put on it. Off until the owner turns it on (settings.projects). Adds one settings column with a
-- default, two tables and a nullable project_id on tasks, activities and time_entries; every existing row keeps its
-- values and gets no project.

ALTER TABLE settings ADD COLUMN projects INTEGER NOT NULL DEFAULT 0 CHECK (projects IN (0, 1));

-- The three fixed statuses; the owner may rename them. Seeded here, not in seed/defaults.sql, which the migration tests
-- also load at earlier versions, before this table exists (as the person statuses, migration 0011).
CREATE TABLE project_statuses (
  -- 'active', 'on_hold' or 'done'; never changes.
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  position INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT OR IGNORE INTO project_statuses (key, label, position) VALUES
  ('active', 'Active', 1),
  ('on_hold', 'On hold', 2),
  ('done', 'Done', 3);

CREATE TABLE projects (
  -- "pj_" and 12 base32 characters.
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200 AND instr(name, char(10)) = 0 AND instr(name, char(13)) = 0),
  contact_id TEXT NOT NULL REFERENCES contacts (id),
  -- The won deal it came from; NULL for a project made by hand.
  deal_id TEXT REFERENCES deals (id),
  status_key TEXT NOT NULL DEFAULT 'active' REFERENCES project_statuses (key),
  -- ISO strings: a local date at midnight, as a task's due date with no time.
  start_at TEXT,
  target_at TEXT,
  notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  -- Always '[]' for now; kept for a later import.
  untrusted_fields TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(untrusted_fields) AND json_type(untrusted_fields) = 'array'),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX projects_contact ON projects (contact_id);
CREATE INDEX projects_deal ON projects (deal_id);
CREATE INDEX projects_status ON projects (archived, status_key);

ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects (id);
ALTER TABLE activities ADD COLUMN project_id TEXT REFERENCES projects (id);
ALTER TABLE time_entries ADD COLUMN project_id TEXT REFERENCES projects (id);

CREATE INDEX tasks_project ON tasks (project_id);
CREATE INDEX activities_project ON activities (project_id);
CREATE INDEX time_entries_project ON time_entries (project_id);
