# Projects: design (run 9)

Brief: Grant's run 9 brief, "Projects" (2026-11-25), area 1. The brief is the owner's approval of the direction; the
calls it leaves open are rulings below, each with its cost if wrong. Decision 0055 records them for the repo.

## Why

Owners who deliver work after the sale (engineering jobs, Grant's own pilots) need a place for that work that is not
the sales pipeline. A Project record holds it, made from a won deal or by hand. Selling and delivery stay apart: a won
deal stays finished, and the brief, the rules and "What it caught" keep treating it that way.

## Goals

- A project: a name, a person, an optional won deal it came from, a status (Active, On hold, Done; the owner renames
  them by talking), optional start and target dates, notes. Archived, never deleted.
- Off by default (`settings.projects`); while off there is no Projects UI, prompt or label anywhere.
- From a won deal: the board offers "Start a project?" (never automatic), pre-filling the name, person and deal, and
  offering to move the deal's open tasks onto the project. Over MCP, an applied Won tells the AI app to ask the owner
  the same question.
- Tasks, notes, time entries and the timer can be on a project. Project tasks show on Today and in the brief like any
  task, labelled with the project.
- Board (phone first, no JavaScript needed, same accessibility bar): a Projects list (status filter, cards and table) and
  a project page (status, person, deal, open and done tasks with quick add, time totals, notes). The person and deal
  pages link to their projects.
- MCP: `list_projects`, `get_project`; record actions `add_project`, `update_project` (proposed under Review first, each
  line of the list naming the project); `add_task`, `log_activity`, `start_timer`, `add_time_entry` and
  `update_time_entry` accept a project.
- Exports include projects; the time CSV gains a project column. Demo seed: two projects, one from a won deal.

## Non-goals and anti-goals

- Not a second pipeline: no project stages, kanban, rules, brief section or "What it caught" line.
- A project never changes its deal. Making one never reopens, moves or edits the deal; the deal's tasks move only when
  the owner ticks the box or the AI's proposal says so.
- No invoicing, milestones, budgets, project saved views or project custom fields in this run.
- Anti-goal: anything that makes a won deal look open again (in `list_deals`, `whats_due`, rules or the brief).

## Approaches

1. **A `projects` table, with `project_id` on tasks, activities and time entries (chosen).** Like time entries in run 6:
   a record of its own, reached by the same services, proposals and undo. Costs one migration and a new link to check
   everywhere a task or entry is made.
2. **Projects as deals in a second "delivery" stage set.** Free kanban and tasks, but every deal read, rule, report and
   brief line would need a filter, and a won deal would turn into an open one. Works against "selling and delivery stay
   apart".
3. **A person status or tag ("In delivery").** No dates, no grouping of tasks or time, one project per person.

## Data (migration `0020_projects.sql`, forward-only, keeps every row)

- `settings.projects` INTEGER 0/1, default 0.
- `project_statuses`: `key` (PK: `active`, `on_hold`, `done`, fixed), `label`, `position`, `version`, times. Seeded in
  the migration and `seed/defaults.sql`. Renamed only (`update_project_status`); never added to or archived this run.
  A settings-like table: read through a `memo.ts` reader (`projectStatusRows`), never written by a plan.
- `projects`: `id` (`pj_`), `name` TEXT NOT NULL (1 to 200, one line), `contact_id` NOT NULL REFERENCES contacts,
  `deal_id` REFERENCES deals (NULL for a project by hand), `status_key` NOT NULL REFERENCES project_statuses DEFAULT
  `active`, `start_at`, `target_at` (ISO, a local date at midnight, as a task's due date with no time), `notes`,
  `archived` 0/1, `untrusted_fields` (always `[]` this run; kept for a later import), `version`, times. STRICT.
  Indexes on `contact_id`, `deal_id`, `(archived, status_key)`.
- `tasks.project_id`, `activities.project_id`, `time_entries.project_id`: nullable REFERENCES projects (ALTER TABLE ADD
  COLUMN, no rebuild), each indexed.
- Plumbing: `PRIMARY_KEYS`, `ROW_NOUNS` ("Project", "Project status"), `BULK_ORDER` (projects after deals, before
  tasks), `ID_PREFIXES` (`pj`), `lookup.ts` `projectById` (and a `ById` entry), undo `DEPENDENTS` (contacts and deals:
  projects; projects: tasks, activities, time entries; project_statuses: projects), `FAKE_ROWS`, the `Row` types.

## Link rules (one place: `src/services/project-links.ts`)

- A project's person is required. With a deal, the person is the deal's person (a different person given is refused,
  as `findSubject` does); the deal must be Won ("A project comes from a won deal. Mark <deal> Won first, or leave the
  deal out.") and not archived. Several projects may come from one deal.
- A record on a project (task, note, time entry, timer) gets `project_id`, `contact_id` = the project's person and
  `deal_id` = NULL. Giving a deal with a project is refused ("Give the project or the deal, not both."); a person other
  than the project's is refused. An archived project takes nothing new ("Project … is archived. Bring it back first.").
  A Done or On hold project does.
- Time: a task given with a project must be that project's; a task given alone that is on a project puts the entry on
  it. Rates are unchanged: the person's client rate, else the work type's.
- `update_time_entry` may set or clear `project` (clearing keeps the person). Tasks have no edit tool; the board's task
  edit, if any, leaves `project_id` alone.
- While projects are off, any `project` input is refused with `PROJECTS_OFF` ("Projects are off. The owner can turn
  them on (update_settings projects true)."), and every project tool and service refuses the same way, reads included.

## Services

- `src/services/projects.ts`: `addProject(ctx, input)` and `updateProject(ctx, ref, patch)`, each one `commitChange`
  (actor and tool from ctx). `ProjectInput = { name?, contact?, deal?, status?, startAt?, targetAt?, notes?,
  moveOpenTasks? }`. `name` defaults to the deal's title when the title is the owner's; with no deal, or a title from
  outside, it is required ("Name the project in a few words."). Target before start is refused. `moveOpenTasks` (only
  with a deal; default false) moves every open task of the deal (done_at null, snoozed included): `project_id` set,
  `deal_id` null, `contact_id` the person; in the same change. Patch: `name`, `status`, `startAt`, `targetAt` (null
  clears), `notes` (null clears), `archived`.
- Summaries: "Added project \"Retrofit\" for Pat Example, from \"Seismic retrofit\" (moved 2 open tasks)"; "Updated
  project \"Retrofit\" (Pat Example): status Active -> Done". Names through `labels.ts`: `projectTitle(p)` =
  `"<name>"` (or `project pj_…` when untrusted), `projectLabel(p, contact)` = `"<name>" (Pat Example)`.
- `src/services/project-statuses.ts`: `updateProjectStatus(ctx, key, label)` (configuration, writes at once, rule 5),
  labels through a `projectStatusLabels` helper (memo).
- Reads (`src/services/project-read.ts`): `listProjects(db, { status?, contact?, includeArchived?, sort? })` (at most
  200, with the total and open-task counts), `getProject(db, id, now)` (the project, person, deal, open tasks, the 20
  latest done tasks, the 20 latest notes, and with time tracking on the time totals: minutes, billable minutes, not
  billable, amount in cents from each entry's stored rate). Every read goes through `requireProjects`.
- Reads by id in a record service go through `lookup.ts` (`projectById`, and `withPlanned` for a deal's open tasks), so
  a proposal's later action sees an earlier one's project (decision 0044). The maximum-size propose and apply still make
  at most 40 D1 calls (`proposals-d1.test.ts`).

## MCP

- Record actions `add_project`, `update_project` in `RECORD_ACTIONS`, through `recordWrite`; never small. `@n` may name
  a project an earlier `add_project` adds, as the `project` of a later `add_task`, `log_activity`, `start_timer` or
  `add_time_entry` (`ADDS.add_project = ["project"]`, a `project` ref kind, name matching in `matchAll`: live projects by
  exact name ignoring case; several or none are questions).
- `project` input on `add_task`, `log_activity`, `start_timer`, `add_time_entry`, `update_time_entry` (null clears on
  the last). `start_timer` on an existing project stays small.
- Reads (`readOnlyHint`): `list_projects` (status, contact, includeArchived; answers the statuses too), `get_project`.
  `get_deal` lists the deal's projects; `list_tasks` takes `project` and its items, like `whats_due`'s, carry
  `projectId` and `projectName` (with `untrusted_fields` as today). All only while projects are on.
- Configuration: `update_settings projects`, `update_project_status { status, label }`; `get_settings` shows `projects`.
- The Won question: when an applied change marks a deal Won (`apply_changes`, or any record write that applies), projects
  are on and the deal has no live project, the answer adds one line and `startProject: { deal }`: "Ask the owner: start
  a project for <deal label>? If yes, propose add_project with deal <id> (moveOpenTasks true also moves its N open
  tasks)." `instructions.ts` gains one line: after a Won, ask that question; never add a project without the owner's yes.
- Proposal list (`proposal-text.ts`): an Add line, "Project \"Retrofit\": person Pat Example; from deal
  \"Seismic retrofit\"; status Active; start Mon Dec 1; target Fri Jan 30; notes …"; Update lines for edits; moved tasks
  show "for \"Seismic retrofit\" (Pat Example) -> project \"Retrofit\" (Pat Example)". Every task, note and time line on a
  project names it: `forWhom` answers the project label before the deal or person. `proposal-coverage.test.ts` gains a
  variant per new optional field. Columns `project_id` and every `projects` column must show (the unshown check).

## Board

- Nav: "Projects" in More while on, after Time (`moreItemsFor`, `PageFrame.projects`). Every `/projects*` path, and
  every project route under `/contacts/…` and `/deals/…`, is a 404 while off.
- `/projects` (`pages/projects.ts`): h1 "Projects"; a GET form `status=active|on_hold|done|archived|all` (default
  active) and `sort=target|name|newest` (default target: soonest first, none last); `layoutSwitch` cards (default) or
  table (`dataTable`: Project as the row header link, Status, Person, Start, Target, Open tasks). Unknown values are the
  defaults; the address carries only those keys. A lede: "To start a project, open the person's page or a won deal."
- `/projects/<pj id>` (`pages/project.ts`): h1 the name. Left: Project card (status, person link, "From deal" link,
  start, target, notes, Edit link, a Status select with Save, Archive or Bring back); Time card when time tracking is on
  (total, billable, not billable, amount; the Start timer form with hidden `project`; a link to `/time`). Right: Open
  tasks (the existing task cards, with complete, snooze and timer) and the quick add form posting
  `/projects/<id>/tasks`; Done (latest 20); Notes (the log form posting `/projects/<id>/log`, then the timeline).
- `/projects/<id>/edit`: a record form (name, status, start, target, notes) that sends only changed fields.
- New: `/contacts/<ct id>/projects/new` (by hand, linked from the person page) and `/deals/<dl id>/projects/new` (a won
  deal only, else 404): name (pre-filled with the deal's title when it is the owner's), status, start, target, notes,
  and with a deal that has open tasks an unticked box "Also move this deal's N open tasks to the project". No person
  picker: a project always starts from a person or a deal.
- The deal page of a won deal with no live project, while on, shows first in its right column a "Start a project?"
  section (one line and a "Start a project" link). With projects, a "Projects" section lists them (name link and
  status) and "Start another project". The person page gets the same "Projects" section with "Start a project".
- Labels: on Today and in each task card, a project task shows "Project" (the project link) beside its "Contact". In
  the brief, a project task line reads "title (person, project \"Retrofit\")". While off, neither shows.
- Routes (`src/board/project-actions.ts`, `PROJECT_ROUTES`, in the route table): `POST /contacts/<id>/projects`,
  `POST /deals/<id>/projects` (`add_project`), `POST /projects/<id>` (edit), `/projects/<id>/status`,
  `/projects/<id>/archive` (`update_project`), `/projects/<id>/tasks` (`add_task`), `/projects/<id>/log`
  (`log_activity`); `/timer/start` takes hidden `project`. All as the owner, 303 to `return_to` with `?change=`, a 422
  with values kept on refusal. Archive asks no confirm (it is undoable and removes nothing).
- `boardRoutes` gets `/projects`, `/projects/pj_seed01`, its edit page and both new pages. `lighthouseRoutes` is full
  (20, the cap): see ruling 9.

## Exports, time CSV, seed

- `EXPORT_TABLES` gains `project_statuses` and `projects`; `/export` lists their CSVs only while projects are on (the
  JSON always has them, as with time). The tasks, activities and time CSVs carry `project_id`.
- `GET /time/export.csv`: a `project` column after `client` (the project's name, blank for none); one row per client,
  project and work type; sorted as now, then by project (none first).
- `scripts/seed-dev.ts`: `settings.projects = 1`; `pj_seed01` "Storage building B retrofit" from won `dl_seed07`
  (`ct_seed07`), Active, with two open tasks (one moved from the deal), one done task, a note and two time entries;
  `pj_seed02` by hand for another seeded person, On hold, with a target date and one task.
- `tests/helpers/fixture-seed.ts` gains the same two rows if the unit tests need them.

## Rulings (each: the call, then its cost if wrong)

1. **The brief's last line is cut off** ("Design it so "Projects" can later…"). Read as "…can later grow (be renamed per
   copy, take more statuses, invoicing) without reshaping its data": statuses are a table with fixed keys like person
   statuses, and nothing else is built for it. Cost: if the sentence asked for something else, a follow-up run.
2. **Person required, deal optional and Won only.** Cost: an internal project with no client needs a placeholder person;
   adding "no person" later is a migration (the column would become nullable).
3. **Statuses: three fixed keys, rename only.** Cost: an owner wanting a fourth status waits for a later run (the table
   allows it).
4. **A project's records leave the deal** (`deal_id` null, the person kept). Cost: the won deal's page no longer shows
   moved tasks; they show on the project, which the deal page links to.
5. **The offer lives on the won deal's page**, shown until a project exists, not as a step after the Won confirm.
   Cost: one more scroll than a dedicated step.
6. **The move-tasks box is unticked.** Cost: one tap when the owner always wants it.
7. **Notes on a project are activities with `project_id`**, so "the activity log" is the project's own timeline, and
   `log_activity` takes a project. Cost: none known; an audit-based log would show more (status changes), which the
   change log already does.
8. **No board settings switch**: "in settings" is `update_settings` (as time tracking and campaigns; the board has no
   general settings page). Cost: a small form later if Grant meant the board.
9. **No Lighthouse slot**: the list is at its cap of 20 and changing it is CI behavior (Grant's call). The project
   pages are of kinds already scored (a cards-or-table list like People, a record page like the deal page) and are in
   `boardRoutes`, so the axe scan covers them. Cost: a Lighthouse-only regression on a project page is unseen until a
   slot is given (queued for Grant).
10. **While off, nothing shows**, including the project label on Today and in the brief; the data stays. Cost: none.
11. **No project saved views, import or custom fields.** The tasks import does not read `project_id`. Cost: an export of
    tasks imported into another copy loses their project link (the offboarding restore gap already named in Needs
    Grant 16g).
12. **Several projects per deal**, and a project keeps its `deal_id` if the deal is later reopened. Cost: none known.

13. **Builder-check calls.** A moved task keeps its due date and shows in Today's To do list (dated) like any task;
    Today's Overdue and Due today sections are deals' next steps and are unchanged. A project whose person is archived
    stays as it is. "No live project" means none unarchived, so archiving a deal's only project brings the offer back.
    Cost: none known.

## Left to the builder

File layout inside the named modules, exact headlines and error wording beyond the quoted ones (plain, short, no
outside text), the ordering of sections inside a card, test placement, and the acceptance sentences' wording
(35 onward in docs/ACCEPTANCE.md, one e2e test each: turn projects on; a Won then the AI's question; add a task to a
project; time on a project).
