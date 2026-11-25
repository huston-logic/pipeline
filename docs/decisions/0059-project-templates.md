# 0059: Project templates

Run 10, 2026-11-25. Builds on 0055 to 0058 (projects, sub-tasks, task plans). Migration 0024. The design is in
`docs/superpowers/specs/2026-11-25-projects-finished-design.md`, "Area 4".

## Context

The owner starts the same kind of project again and again (a website, a remodel) and re-describes its tasks each time.
A task plan (0058) saves the typing but not the memory: the steps, their order and their day offsets live in the
owner's head.

## Decision

- Tables (migration 0024): `project_templates` (`tp_`: name, description, archived, `untrusted_fields`, version) and
  `template_tasks` (`tt_`: template, parent, position, title, `due_days`, `work_type_id`, archived, version), plus
  `tasks.work_type_id` (a timer started on the task defaults to it). All are change tables: audited and undoable. A task
  is removed by archiving it and its subtree in one change. At most 100 live tasks per template; a live template name is
  unique ignoring case.
- Services: `src/services/templates.ts` (add, update, task add, update, move and archive, duplicate),
  `template-read.ts` (`listTemplates`, `getTemplate`), `template-copy.ts` (the copy into a project).
- `add_project {template}` (an id or an exact live name) copies the live tree into the project's tasks in the same
  change: titles, nesting, order, work types, due = start + days at local midnight. Ruling 9: a template with any day
  offset and no start date makes today the start, and the summary says so. Ruling 17: no link back is kept, so editing a
  template never changes a project and there is no "used by" list.
- MCP: `add_template`, `update_template` (its `tasks` replace the tree in one change) and `save_project_as_template` are
  record actions, proposed like the others; `list_templates` and `get_template` read. A saved project's outside-titled
  tasks are left out of the template with their subtrees and the answer says how many (the AI can not rename a task, so
  refusing would block for ever). A template's tasks in a proposal count toward the 100 of ruling 6 and show as indented
  lines.
- Board: Templates in More while projects are on (`/templates`, `/templates/new`, `/templates/<id>`, a task's edit page),
  every post one audited change. The three Start a project screens (from a person, from a won deal, and
  `/projects/new`) gain a "Start from a template" fieldset above the form: radios, None by default, then each live
  template, and a "Show tasks" button. Ruling 10: it is a GET form to the same page carrying only `template=<tp id>`, so
  nothing typed is lost; the chosen template's tasks show as a preview (three levels, "Day N", and "Starts today unless
  you set a start date." when it has offsets) and the project form carries `template` as a hidden field. An unknown or
  archived id falls back to None; with no live template the fieldset is not drawn. The post passes `template` to
  `add_project`; the deal screen's move and complete boxes still work. The redirect after Won lands on this screen.
- Work types on templates are accepted only while time tracking is on; the board hides them while it is off.

## Why

- A copy that keeps no link has nothing to keep in step and nothing to surprise the owner later.
- A GET step before the form needs no JavaScript and costs the owner only choosing the template first.

## Consequences

- Choosing a template after typing reloads the page and the typed values are not kept: choose the template first.
- Due dates do not follow a later change to the start date.
- Deferred minors: undoing a task archive can push a template over 100 live tasks; positions may have gaps.
