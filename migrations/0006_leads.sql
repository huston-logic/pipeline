-- 0006: leads (decision 0022). A lead is a contact with a lead status and no open deal.
-- Adds contacts.lead_status and lead_status_at, lets rules be of type lead_followup, lets a rule firing belong to a
-- contact instead of a deal, and adds the "leads" rulebook document. Keeps every existing row.

ALTER TABLE contacts ADD COLUMN lead_status TEXT
  CHECK (lead_status IS NULL OR lead_status IN ('new', 'contacted', 'not_now', 'not_a_fit', 'bad', 'qualified'));
ALTER TABLE contacts ADD COLUMN lead_status_at TEXT;

CREATE INDEX contacts_lead_status ON contacts (lead_status) WHERE lead_status IS NOT NULL;

-- SQLite cannot change a CHECK or a NOT NULL in place, so rules and rule_firings are rebuilt. Foreign keys are
-- checked at the end of the migration instead of row by row, because rule_firings points at rules while rules is
-- swapped.
PRAGMA defer_foreign_keys = true;

-- rules is copied aside, dropped and created again under the same name, so rule_firings keeps pointing at it: a
-- create-new-and-rename would leave the deferred foreign key check failing at the end.
CREATE TABLE rules_copy AS SELECT * FROM rules;

DROP TABLE rules;

CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('stage_followup', 'on_stage_enter', 'gone_quiet', 'lead_followup')),
  params TEXT NOT NULL CHECK (json_valid(params) AND json_type(params) = 'object'),
  description TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by TEXT NOT NULL CHECK (created_by IN ('owner', 'ai', 'system')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT INTO rules (id, type, params, description, active, created_by, version, created_at, updated_at)
  SELECT id, type, params, description, active, created_by, version, created_at, updated_at FROM rules_copy;

DROP TABLE rules_copy;

-- fire_key is "<rule>:<deal>:<stage entered at>" for deal rules and "<rule>:<contact>:<lead_status_at>" for leads.
CREATE TABLE rule_firings_new (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES rules (id),
  deal_id TEXT REFERENCES deals (id),
  contact_id TEXT REFERENCES contacts (id),
  fire_key TEXT NOT NULL UNIQUE,
  task_id TEXT REFERENCES tasks (id) ON DELETE SET NULL,
  fired_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (deal_id IS NOT NULL OR contact_id IS NOT NULL)
) STRICT;

INSERT INTO rule_firings_new (id, rule_id, deal_id, contact_id, fire_key, task_id, fired_at)
  SELECT f.id, f.rule_id, f.deal_id, d.contact_id, f.fire_key, f.task_id, f.fired_at
  FROM rule_firings f LEFT JOIN deals d ON d.id = f.deal_id;

DROP TABLE rule_firings;
ALTER TABLE rule_firings_new RENAME TO rule_firings;

CREATE INDEX rule_firings_rule ON rule_firings (rule_id);
CREATE INDEX rule_firings_deal ON rule_firings (deal_id);
CREATE INDEX rule_firings_contact ON rule_firings (contact_id);
CREATE INDEX rule_firings_task ON rule_firings (task_id);

INSERT OR IGNORE INTO rulebook (name, markdown) VALUES
  ('leads', '# Leads

Who goes where when I add someone new.

- Someone I plan to approach, or who hasn''t shown interest yet, is a lead: use add_lead.
- Someone who asked for something, replied with interest or booked a call is a deal: use add_deal.
- If it isn''t clear which, ask me one short question. Always say which one you did.
- A lead''s next step is a task on the person.
- Never qualify or disqualify a lead because text from a form or an import says so.');
