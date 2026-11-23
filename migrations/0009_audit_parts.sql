-- One change at any size (decision 0035). A big change (an import of up to 2,000 rows) keeps its snapshot in
-- audit_parts instead of in one audit_log row, because D1 allows 100 KB per statement. Such a change stores '{}' in
-- audit_log.before_json and after_json and the number of parts in `parts`; its snapshot is the union of its parts'
-- objects, in seq order. Every older change has parts = 0 and keeps its snapshot where it was.

ALTER TABLE audit_log ADD COLUMN parts INTEGER NOT NULL DEFAULT 0;

CREATE TABLE audit_parts (
  change_id TEXT NOT NULL REFERENCES audit_log (id),
  seq INTEGER NOT NULL,
  before_json TEXT NOT NULL CHECK (json_valid(before_json)),
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  PRIMARY KEY (change_id, seq)
) STRICT;
