# 0056: Projects, shaped by the owner

Run 10, 2026-11-25. Builds on 0055 (projects), 0042 (views) and 0049 (time). Migration 0021. The design is in
`docs/superpowers/specs/2026-11-25-projects-finished-design.md`, "Area 1". It replaces 0055 rulings 2, 3, 6, 9 and 11 in
part, as set out under "Replaces" below.

## Context

Run 9 gave projects three fixed statuses, a required person, no custom fields, no saved views and no Lighthouse slot.
Owners need to shape projects the way they shape deals: their own statuses, their own fields, their own views. Some
projects have no client at all (an office move), and a won deal should lead straight into a project.

## Decision

Data (migration 0021, one file, `PRAGMA defer_foreign_keys = true`, pattern of 0016)
- `project_statuses` gains `kind` (`open` or `closed`) and `archived`. `done` becomes closed; `active` and `on_hold`
  stay open. Keys stay and every project keeps its status.
- `field_defs.entity` takes `project`; `views.module` takes `projects`. Both tables are rebuilt with the same columns,
  ids and versions.
- `projects.contact_id` is nullable and `projects.fields` (JSON object) is new. `activities` allows a row with only a
  project. Links from tasks, activities and time entries keep pointing at the same ids.

Statuses
- `add_project_status`, `update_project_status` (label, kind, position) and `archive_project_status`. They write at
  once (rule 5). The key is a slug of the label and never changes. Labels are unique ignoring case, at most 60
  characters.
- There is always one live open and one live closed status. A new project takes the first live open status.
- "Finished" means a closed status.

Custom fields
- `add_field`, `update_field` and `list_fields` take `entity: "project"`. `add_project` and `update_project` take
  `fields`. The project page, forms, JSON export and projects CSV carry them. They are never in a URL or a title.

Saved project views
- `views.module = 'projects'`: filters, sorts, layout and columns set in `view-spec.ts`. `/projects?view=<vw id>`.
  `/projects` status choices are dynamic: `open` (default), each live status key, `closed`, `archived`, `all`.

Internal projects
- `add_project` needs neither a person nor a deal. Its tasks, notes and time have no person and no deal. Every reader
  that joined `contacts` from a project now allows no person. Pages show "Internal"; the time CSV shows "No person".
- `/projects/new` starts one, linked from the Projects list as "Start a project".

The Won flow and the two boxes
- After the board's Won confirm, when projects are on and the deal has no live project, the board goes to
  `/deals/<id>/projects/new` with the change banner and its Undo.
- That screen has "Move open tasks to the project" (ticked) and "Complete all open tasks". Both ticked: complete wins.
  `add_project` takes `completeOpenTasks`; those tasks get `done_at` and stay on the deal, in the same change. Each box
  shows only when the deal has open tasks.

Lighthouse
- `LIGHTHOUSE_MAX_ROUTES` is 22, with `/projects` and `/projects/pj_seed01` added. The owner approved the new cap
  before the run (it is a CI threshold, so the approval is recorded here).

Three fixes queued from STATUS.md
- The `/projects` archived filter is in SQL. The done-task read selects its latest 20 in SQL. The person page timeline
  labels a note logged on a project.

Rulings (from the design)
1. There is always one live open and one live closed status. Cost: an owner who wants no "finished" status keeps one.
2. `done` becomes closed; `active` and `on_hold` open. Cost: none known.
3. A project's person is set when it is made and never changed. An internal project stays internal. Cost: a project
   made without a person cannot be given one later.
4. After Won, the board goes to Start a project only when the deal has no live project. Cost: a second project from
   the same deal starts from the deal page.
5. "Complete all open tasks" leaves those tasks on the deal, done. Cost: they do not show on the project.
18. The ceiling of 40 D1 calls for a maximum-size propose and apply stays; the new reads were fitted inside it. Cost:
    none.

Calls made while building
- A project view with no status filter shows every unarchived status, as a deal view with no stage filter does. Cost:
  the owner adds a status filter for open only.
- The edit form shows an archived current status as "<label> (archived)", so saving does not silently change it.
- Archiving a status in use is guarded inside the write batch, not only checked before it.
- An internal project's tasks count as linked, not standalone: `list_tasks standalone` means no person, no deal and no
  project.
- A stop-timer note on a project-only time entry is logged (it has a project, so the note has somewhere to live).

Replaces (in part)
- 0055 ruling 2: the person is now optional.
- 0055 ruling 3: statuses are the owner's, not three fixed ones.
- 0055 ruling 6 stays, and the new Won screen adds a second box beside it.
- 0055 ruling 9: there are Lighthouse slots now.
- 0055 ruling 11: saved project views and custom fields on projects exist. Import of project links is still not built.

## Why

- Statuses, fields and views already work this way for deals and people, so the owner learns nothing new.
- A project with no person is a real case (internal work). Making the person optional is cheaper than a fake client.
- The Won screen puts the tasks question where the owner already is, instead of on a page they must find.

## Consequences

- Every new reader that touches a project's person must allow none.
- Closing the last live open or closed status is refused, so an owner may need to add one first.
- Project pages are scored by Lighthouse, at 22 routes, which makes that job longer.
- A tasks export imported into another copy still loses its project links (0055 ruling 11, not changed).
