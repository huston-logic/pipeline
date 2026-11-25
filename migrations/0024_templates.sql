-- 0024: project templates. A template is a named task tree (with relative due days and an optional work type) that a
-- new project can copy. Adds two tables and one nullable column on tasks (a task's default work type, used by its
-- timer); every existing row keeps its values.

CREATE TABLE project_templates (
  -- "tp_" and 12 base32 characters.
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200 AND instr(name, char(10)) = 0 AND instr(name, char(13)) = 0),
  description TEXT CHECK (description IS NULL OR length(description) <= 2000),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  -- Always '[]' for now; kept for a later import.
  untrusted_fields TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(untrusted_fields) AND json_type(untrusted_fields) = 'array'),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- Live template names are unique, ignoring case.
CREATE UNIQUE INDEX project_templates_name ON project_templates (lower(name)) WHERE archived = 0;

CREATE TABLE template_tasks (
  -- "tt_" and 12 base32 characters.
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES project_templates (id),
  -- The task this one is under; NULL for a top-level task.
  parent_id TEXT REFERENCES template_tasks (id),
  -- Order among siblings, from 1.
  position INTEGER NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200 AND instr(title, char(10)) = 0 AND instr(title, char(13)) = 0),
  -- Days after the project's start; NULL for no due date.
  due_days INTEGER CHECK (due_days IS NULL OR due_days BETWEEN 0 AND 3650),
  work_type_id TEXT REFERENCES work_types (id),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX template_tasks_template ON template_tasks (template_id);
CREATE INDEX template_tasks_parent ON template_tasks (parent_id);

ALTER TABLE tasks ADD COLUMN work_type_id TEXT REFERENCES work_types (id);
