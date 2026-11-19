-- 0002: deals and tasks remember which of their text fields came from outside (a form, an import, a rule title built
-- from an outside name), like contacts.untrusted_fields: a JSON array of column names, '[]' when all are trusted.
-- Summaries and read answers use it to keep outside text labelled (decisions 0004 and 0009).

ALTER TABLE deals ADD COLUMN untrusted_fields TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(untrusted_fields) AND json_type(untrusted_fields) = 'array');

ALTER TABLE tasks ADD COLUMN untrusted_fields TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(untrusted_fields) AND json_type(untrusted_fields) = 'array');
