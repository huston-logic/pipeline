# 0055: Projects: delivery after the sale

Run 9, 2026-11-25. Builds on 0044 (proposals), 0045 (the AI edits setting), 0046 (standalone tasks) and 0049 (time).
Migration 0020. The design is in `docs/superpowers/specs/2026-11-25-projects-design.md`.

## Context

Owners who deliver work after the sale (engineering jobs, the owner's own pilots) need a place for that work. It is not
the sales pipeline. A won deal must stay won: the brief, the rules and "What it caught" keep treating it as finished.
The brief left open how to hold the work. This decision records the calls.

## Decision

Data
- `settings.projects` (0 or 1, default 0). `update_settings projects` turns it on.
- `projects` (`pj_`): name (1 to 200 characters, one line), person (required), optional won deal, status key, start
  and target dates, notes, archived, `untrusted_fields` (always empty this run), version. Archived, never deleted.
- `project_statuses`: fixed keys `active`, `on_hold`, `done`. Renamed only, through `update_project_status`. Seeded by
  migration 0020 only.
- `tasks.project_id`, `activities.project_id` and `time_entries.project_id`: nullable, each indexed.

Link rules (`src/services/project-links.ts`)
- A project's person is required. With a deal, the person is the deal's person, and the deal must be Won and not
  archived. Several projects may come from one deal.
- A record on a project (task, note, time entry, timer) gets the project's person and no deal. A deal given with a
  project is refused. An archived project takes nothing new.
- A project never changes its deal. Making one does not reopen, move or edit the deal. Open tasks move only when the
  owner ticks the box, or the AI's proposal says so.

Services and MCP
- `addProject` and `updateProject` (`src/services/projects.ts`), one audited change each. Reads are in
  `src/services/project-read.ts`.
- Record actions `add_project` and `update_project` (in `RECORD_ACTIONS`, proposed under Review first). Reads
  `list_projects` and `get_project`.
- `add_task`, `log_activity`, `start_timer`, `add_time_entry` and `update_time_entry` take a project.
- The Won question (`src/services/won-offers.ts`, `src/mcp/start-project.ts`) asks the owner whether to start a
  project. It is built from the rows the change wrote, never from the action text. The AI never adds a project
  without the owner's yes.

Board
- Off until `settings.projects` is on. While off, nothing shows: no Projects item, no project label, no offer.
- A Projects list (status filter, cards or table) and a project page. A won deal offers "Start a project?", never
  automatically. The person and deal pages link to their projects. These pages arrive in a later PR.

Rulings (from the design)
1. The brief's last line is read as "can later grow without reshaping its data". Statuses are a table with fixed
   keys. Nothing else is built for it.
2. The person is required. A deal is optional and must be Won.
3. Three statuses, renamed only. No fourth status this run.
4. A project's records leave the deal (`deal_id` null, the person kept).
5. The offer lives on the won deal's page, until a project exists.
6. The move-tasks box is unticked by default.
7. Notes on a project are activities with `project_id`.
8. No board settings switch. "In settings" means `update_settings`.
9. No Lighthouse slot. The list is at its cap of 20, and changing it is CI behavior (Grant's call).
10. While projects are off, nothing shows. The data stays.
11. No project saved views, no import of project links, no custom fields on projects.
12. Several projects per deal. A project keeps its `deal_id` if the deal is later reopened.
13. A moved task keeps its due date. "No live project" means none unarchived. A project whose person is archived stays
    as it is.

Calls made while building
- The three statuses are seeded by migration 0020 only (as person statuses were in 0011).
- A task given with a project must be that project's.
- `update_time_entry` never moves an entry off its project implicitly. A deal, contact or another task given for a
  project entry is refused unless `project` null is given.
- A note on a project touches no deal: an open deal of the same person keeps its last contact, so delivery work never hides a quiet sale.
- While projects are off, any project input or project action in a proposal is refused with `PROJECTS_OFF`, before
  names are matched.
- The Won question is built from the rows the change wrote, never from the action text.
- Under Apply small changes, a call or note logged on an existing project applies at once, like one on an existing
  person or deal; one on a project an earlier action adds is proposed.

## Why

- A project is its own record. A won deal stays finished, so every rule, read and brief keeps working as before.
- Projects use the same services, proposals and undo as time entries (0049). No new write path is needed.
- Three fixed statuses keep the table small. A rename covers the owner's own wording.

## Consequences

- No Lighthouse slot yet (ruling 9). Project pages are covered by the axe scan only, until Grant gives a slot.
- If the brief's cut-off sentence asked for more than a rename, that is a later run (ruling 1).
- A fourth status needs only a row. A person with no client needs a migration, since `contact_id` is required (ruling 2).
- The tasks import does not read `project_id`. A tasks export imported into another copy loses its project links
  (ruling 11).
- Moved tasks keep their due date and show on Today's To do list, like any task. Today's Overdue and Due today sections
  stay deals' next steps.
