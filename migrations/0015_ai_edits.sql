-- 0015: the "AI edits" setting (decision 0045). 'review' (the default, "Review first"): every record write tool of the
-- AI app answers a proposal the owner approves with apply_changes. 'small' ("Apply small changes"): a call or note
-- logged on a person or deal, and completing a task, are written at once; everything else is still proposed. Adds one
-- column with a default; every existing row keeps its values.

ALTER TABLE settings ADD COLUMN ai_edits TEXT NOT NULL DEFAULT 'review' CHECK (ai_edits IN ('review', 'small'));
