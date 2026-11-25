-- Sub-tasks (decision 0057): a project's task may sit under another task of the same project, and siblings keep an
-- order. Tasks not on a project keep both columns null.
ALTER TABLE tasks ADD COLUMN parent_id TEXT REFERENCES tasks (id);
ALTER TABLE tasks ADD COLUMN position INTEGER;
CREATE INDEX tasks_parent ON tasks (parent_id);

-- Every task already on a project is top level, numbered 1..n by creation within its project.
UPDATE tasks SET position = (
  SELECT count(*) FROM tasks AS t
  WHERE t.project_id = tasks.project_id AND (t.created_at < tasks.created_at OR (t.created_at = tasks.created_at AND t.id <= tasks.id))
) WHERE project_id IS NOT NULL;
