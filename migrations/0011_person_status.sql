-- 0011: person status (decision 0040; it replaces parts of 0022). Every person has one person status saying what
-- kind of person they are (Lead, Contact, Partner and any the owner adds), and each status has its own list of
-- sub-statuses. Lead's sub-statuses keep today's lead status keys, because rules and reports use them.
-- Adds two tables and two contact columns. contacts.lead_status and lead_status_at are kept exactly as they are: they
-- stay the lead engine's columns, and "was qualified" stays in them. No contact's version moves, so undo of an earlier
-- change still finds its rows as it left them.

CREATE TABLE person_statuses (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  position INTEGER NOT NULL,
  -- What the sub-status field is called for this status ("Lead status", "Contact type", ...).
  sub_label TEXT NOT NULL DEFAULT 'Sub-status',
  -- 1: can be renamed and moved, never archived (Lead and Contact).
  locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE person_substatuses (
  -- "<status key>.<key>", for example "lead.new".
  id TEXT PRIMARY KEY,
  status_key TEXT NOT NULL REFERENCES person_statuses (key),
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  position INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (status_key, key)
) STRICT;

-- Seeded here, not in seed/defaults.sql, so every copy has them before its people are given one. OR IGNORE keeps
-- whatever is there.
INSERT OR IGNORE INTO person_statuses (key, label, position, sub_label, locked) VALUES
  ('lead', 'Lead', 1, 'Lead status', 1),
  ('contact', 'Contact', 2, 'Contact type', 1),
  ('partner', 'Partner', 3, 'Sub-status', 0);

INSERT OR IGNORE INTO person_substatuses (id, status_key, key, label, position) VALUES
  ('lead.new', 'lead', 'new', 'New', 1),
  ('lead.contacted', 'lead', 'contacted', 'Contacted', 2),
  ('lead.not_now', 'lead', 'not_now', 'Not now', 3),
  ('lead.not_a_fit', 'lead', 'not_a_fit', 'Not a fit', 4),
  ('lead.bad', 'lead', 'bad', 'Bad lead', 5),
  ('contact.client', 'contact', 'client', 'Client', 1);

-- No foreign key: SQLite can't add a column with REFERENCES and a non-NULL default while foreign keys are on. The
-- services check the status and sub-status instead.
ALTER TABLE contacts ADD COLUMN person_status TEXT NOT NULL DEFAULT 'contact';
ALTER TABLE contacts ADD COLUMN sub_status TEXT;

-- Someone with an unqualified lead status is a Lead with the same sub-status. Everyone else (never a lead, or
-- Qualified) is a Contact with none; Qualified stays in lead_status as history.
UPDATE contacts SET person_status = 'lead', sub_status = lead_status
  WHERE lead_status IN ('new', 'contacted', 'not_now', 'not_a_fit', 'bad');

CREATE INDEX contacts_person_status ON contacts (person_status, sub_status);
