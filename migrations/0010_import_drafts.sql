-- 0010: the board import's drafts (decision 0036). A draft is scratch space, like write_guard: the file an owner
-- uploaded on /import, the column matches they chose and, once applied, the counts and the change id. It is not
-- audited, not exported and never logged. The file is kept only in import_draft_parts, in pieces of at most 90 KB
-- (CHUNK_BYTES), so every statement stays under D1's 100 KB; the pieces are deleted the moment the import is applied.
-- A draft expires 2 hours after it is made; every import request and the hourly run delete expired drafts. Adds
-- tables only: earlier data is untouched.

CREATE TABLE import_drafts (
  id TEXT PRIMARY KEY,
  module TEXT NOT NULL CHECK (module IN ('people', 'deals', 'tasks')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  mapping TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(mapping) AND json_type(mapping) = 'array'),
  options TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(options) AND json_type(options) = 'object'),
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  change_id TEXT,
  version INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE import_draft_parts (
  draft_id TEXT NOT NULL REFERENCES import_drafts (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (draft_id, seq)
) STRICT;

CREATE INDEX import_drafts_expires ON import_drafts (expires_at);
