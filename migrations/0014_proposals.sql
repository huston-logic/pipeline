-- 0014: proposals (decision 0044). A proposal is a list of record changes the AI app planned and showed the owner; it
-- is written only after the owner's yes, as one audited change. Scratch space like import_drafts: not audited, not
-- exported and never logged. `actions` holds the resolved actions (ids, never names), `reads` every row the plan
-- writes with the version it read ("<table>:<id>": version, or null for a row it adds), which apply_changes checks
-- against a fresh plan. A proposal expires 2 hours after it is made; the hourly run deletes expired ones, and applied
-- or dropped ones a day after they were made. Adds one table; no existing row changes.

CREATE TABLE proposals (
  -- "pr_" and 12 base32 characters.
  id TEXT PRIMARY KEY,
  actions TEXT NOT NULL CHECK (json_valid(actions) AND json_type(actions) = 'array'),
  reads TEXT NOT NULL CHECK (json_valid(reads) AND json_type(reads) = 'object'),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'dropped')),
  -- The proposal that replaced this one (status dropped).
  replaced_by TEXT,
  -- The change apply_changes wrote (status applied).
  change_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX proposals_open ON proposals (status, expires_at);
