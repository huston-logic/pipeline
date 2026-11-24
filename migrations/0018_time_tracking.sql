-- 0018: time tracking (decision 0049). Work types with an hourly rate, a client's own rate for a work type, and time
-- entries. A running timer is a time entry with no end, and at most one runs at a time. The rate an entry used is
-- copied onto it when it is saved, so a later rate change never rewrites old time; the amount (rate x minutes / 60)
-- is worked out when read and never stored. Off until the owner turns it on (settings.time_tracking). Adds one column
-- with a default and three tables; every existing row keeps its values.

ALTER TABLE settings ADD COLUMN time_tracking INTEGER NOT NULL DEFAULT 0 CHECK (time_tracking IN (0, 1));

CREATE TABLE work_types (
  -- "wt_" and 12 base32 characters.
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- The default hourly rate; NULL for none.
  hourly_rate REAL CHECK (hourly_rate IS NULL OR hourly_rate >= 0),
  billable_default INTEGER NOT NULL DEFAULT 1 CHECK (billable_default IN (0, 1)),
  -- 1-based place among the live work types.
  position INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE UNIQUE INDEX work_types_name ON work_types (lower(name)) WHERE archived = 0;

-- A person's own rate for one work type: it beats the work type's rate. Clearing it archives the row.
CREATE TABLE client_rates (
  -- "cr_" and 12 base32 characters.
  id TEXT PRIMARY KEY,
  work_type_id TEXT NOT NULL REFERENCES work_types (id),
  contact_id TEXT NOT NULL REFERENCES contacts (id),
  hourly_rate REAL NOT NULL CHECK (hourly_rate >= 0),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE UNIQUE INDEX client_rates_pair ON client_rates (work_type_id, contact_id) WHERE archived = 0;

CREATE TABLE time_entries (
  -- "te_" and 12 base32 characters.
  id TEXT PRIMARY KEY,
  -- What the time was for: a person, a deal (and so its person), a task, or nothing.
  contact_id TEXT REFERENCES contacts (id),
  deal_id TEXT REFERENCES deals (id),
  task_id TEXT REFERENCES tasks (id),
  started_at TEXT NOT NULL,
  -- NULL: the running timer.
  ended_at TEXT,
  minutes INTEGER CHECK (minutes IS NULL OR minutes BETWEEN 1 AND 960),
  work_type_id TEXT REFERENCES work_types (id),
  billable INTEGER NOT NULL DEFAULT 0 CHECK (billable IN (0, 1)),
  -- The hourly rate used, fixed when the entry is saved; NULL when not billable or no rate applied.
  rate REAL CHECK (rate IS NULL OR rate >= 0),
  notes TEXT,
  -- The note activity a stopped timer logged its notes as.
  activity_id TEXT REFERENCES activities (id),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  untrusted_fields TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(untrusted_fields) AND json_type(untrusted_fields) = 'array'),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((ended_at IS NULL) = (minutes IS NULL))
) STRICT;

-- At most one running timer: every live row with no end has the same index value.
CREATE UNIQUE INDEX time_entries_one_running ON time_entries ((1)) WHERE ended_at IS NULL AND archived = 0;
CREATE INDEX time_entries_started ON time_entries (started_at) WHERE archived = 0;
CREATE INDEX time_entries_contact ON time_entries (contact_id, started_at);
CREATE INDEX time_entries_deal ON time_entries (deal_id, started_at);
