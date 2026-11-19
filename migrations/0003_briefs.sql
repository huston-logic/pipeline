-- 0003: the daily brief, composed and stored once per owner-local day (decision 0011). An append-only system log, not
-- owner data: no audit row, not undoable. `items` is a JSON array of the brief's lines as data; `sent_at` and
-- `send_status` say whether the email went out, or why it did not.

CREATE TABLE briefs (
  id TEXT PRIMARY KEY,
  local_date TEXT NOT NULL UNIQUE,
  composed_at TEXT NOT NULL,
  text TEXT NOT NULL,
  items TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(items) AND json_type(items) = 'array'),
  sent_at TEXT,
  send_status TEXT
) STRICT;
