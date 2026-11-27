-- 0027: which facts the project page shows, and in what order (run 12, ruling 8). A JSON array of fact keys, or NULL
-- for the default list. Adds one nullable column; every existing row keeps its values.

ALTER TABLE settings ADD COLUMN project_facts TEXT CHECK (project_facts IS NULL OR json_valid(project_facts));
