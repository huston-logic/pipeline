-- 0013: saved views (decision 0042). A view is a name, a module (people or deals), its filters, a sort, a layout and
-- its columns. The default view of each person status is worked out when it is read and has no row here, so a new
-- status shows on the board with no code. Adds one table; no existing row changes.

CREATE TABLE views (
  -- "vw_" and 12 base32 characters.
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  module TEXT NOT NULL CHECK (module IN ('people', 'deals')),
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

CREATE INDEX views_module ON views (module, archived, position);
