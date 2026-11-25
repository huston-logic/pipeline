# Run 10 "Projects, finished" Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`. Each task:
> failing tests first, then code, `npm run check:fast` passes, one commit, one Sonnet review.

**Goal:** Projects shaped by the owner, sub-tasks, AI task plans, templates, and approving AI changes on the board.
**Architecture:** Five PRs in order, each branched from the previous tip while CI runs and rebased onto `main` after
its squash merge (first push after the rebase; no force push). Cut from the bottom (E, then D) if the run gets long.
**Spec:** `docs/superpowers/specs/2026-11-25-projects-finished-design.md` (binding; read the area and rulings a task names).

## Global Constraints
- AGENTS.md and CLAUDE.md hold: every write through `commitChange`; markup through `html`; reads by id via `lookup.ts`,
  settings-like reads via `memo.ts`; new record actions in `RECORD_ACTIONS` via `recordWrite`; every written column
  shown by `proposal-text.ts`; new tools in `src/mcp/server.test.ts` and `tests/e2e/mcp.test.ts`.
- Projects off: every new tool, input, path and section refuses (`PROJECTS_OFF`) or 404s, and nothing shows.
- Migrations 0021 to 0025, forward-only, every earlier row kept; `FAKE_ROWS` for each new table and column.
- Fake people only. Board copy is the design's quoted strings, plain and short. Phone-first, no JavaScript needed.
- The D1 ceiling of 40 calls for a maximum-size propose and apply stays (ruling 18).

## Review Focus
1. An internal project (no person) on every reader: list, page, Today, brief, time CSV, export, person-less time rates.
2. Archiving or re-kinding a status that would leave no live open or no live closed status is refused (A2).
3. A plan or template whose `under` points forward, at itself, or past 100 items is refused plainly (C1, D2).
4. Undo of a change that added a parent task, a template or a template task, while something points at it, refuses (B1, D1).
5. Approve on the board of a proposal whose rows changed since is a 422 with the message, nothing written (E2).

## PR A `feat/projects-shaped` (area 1, decision 0056)
### Task A1: Migration 0021
**Files:** create `migrations/0021_projects_shaped.sql`; modify `src/db/db.ts` (`ProjectStatusRow.kind/archived`,
`ProjectRow.contact_id: string | null`, `ProjectRow.fields`, `FieldDefRow.entity`, `ViewRow.module`),
`src/db/migrations.test.ts`.
- [ ] Tests: every row of the five rebuilt or altered tables kept with ids and versions; `done` is `closed`, the others
  `open`; a project with `contact_id` null and an activity with only `project_id` insert; `field_defs.entity 'project'`
  and `views.module 'projects'` insert; time entries' `activity_id` and tasks' `project_id` links survive.
- [ ] Undo of a project change recorded before 0021 (snapshot without `fields`) still works (`src/services/undo.test.ts`).
- [ ] Design "Area 1" migration bullets and "Builder check answers" (no status DEFAULT). Commit `feat: shape projects (0021)`.
### Task A2: Project statuses by talking
**Files:** modify `src/services/project-statuses.ts`, `src/services/projects.ts` (default status), `src/services/memo.ts`,
`src/services/project-read.ts` (`status: "open" | "closed"`), `src/mcp/tools-write.ts`, `src/mcp/tools-read.ts`.
**Produces:** `addProjectStatus(ctx, {label, kind?, position?})`, `updateProjectStatus(ctx, key, {label?, kind?, position?})`,
`archiveProjectStatus(ctx, key)`, `defaultProjectStatus(src): Promise<ProjectStatusRow>`, `isClosedStatus(src, key)`.
- [ ] Tests: slug key fixed on rename; unique label; reorder shifts others; archive refused while a live project has it
  (count in message); last live open or closed refused for archive and kind change; archived never accepted on a
  project; new project defaults to the first live open status. Commit `feat: project statuses by talking`.
### Task A3: Internal projects and the complete box
**Files:** modify `src/services/projects.ts` (`completeOpenTasks`), `project-links.ts`, `project-read.ts`, `labels.ts`,
`read.ts`, `time-entries.ts`, `timer.ts`, `src/http/time-csv.ts`, `src/brief/compose.ts`, `record-inputs.ts`,
`proposal-text.ts`, `src/mcp/tools-write.ts`, `src/mcp/start-project.ts`; every `JOIN contacts` reached from projects.
- [ ] Tests: `add_project` with neither person nor deal; its task, note, entry and timer have no person and no deal;
  each reader shows it (LEFT JOIN, "Internal", "No person"); rate is the work type's; `completeOpenTasks` sets
  `done_at` on the deal's open tasks, leaves them on the deal, and wins over `moveOpenTasks`; proposal list shows it. Commit.
### Task A4: Custom fields on projects
**Files:** modify `src/services/fields.ts` (`FieldEntity` + `"project"`), `projects.ts` (`fields`), `project-read.ts`,
`record-inputs.ts`, `proposal-text.ts`, `proposal-coverage.test.ts`, `src/http/export.ts` (projects CSV `fields`),
`src/mcp/tools-write.ts` (`add_field` entity).
- [ ] Tests: add, rename, archive a project field; values validated like a deal's; shown in `get_project` and the
  proposal list; export JSON and CSV carry them. Commit `feat: custom fields on projects`.
### Task A5: Saved project views and the list's statuses
**Files:** modify `src/services/view-spec.ts`, `views.ts`, `view-read.ts`, `src/board/pages/projects.ts`,
`src/board/people-switch.ts`, `src/board/view-table.ts`, `src/board/routes.ts` (a `/projects?view=` route).
- [ ] Tests: `add_view {module: "projects"}` filters, sorts, columns per design; `/projects?view=vw_…` and unknown 404;
  status choices `open` (default), live keys, `closed`, `archived`, `all`; archived filtered in SQL (fix a). Commit.
### Task A6: Board: fields, internal projects, the Won flow and the fixes
**Files:** modify `src/board/pages/project.ts`, `project-new.ts`, `project-edit.ts`, `src/board/project-form.ts`,
`src/board/project-actions.ts`, `src/board/actions.ts` (`moveDeal`), `src/board/pages/contact.ts`,
`src/services/read.ts` (done tasks in SQL), `src/board/routes.ts` (`LIGHTHOUSE_MAX_ROUTES = 22`, `/projects/new`).
- [ ] Tests: fields on page and forms (`was.` only changed); `/projects/new` makes an internal project; Won confirm
  303s to `/deals/<id>/projects/new?change=` only with projects on and no live project; move box ticked, complete box
  unticked, both shown only with open tasks; person timeline says "on project"; done read is the latest 20 in SQL;
  `lighthouseRoutes` holds `/projects` and `/projects/pj_seed01`, cap 22. `review-a11y` on A5, A6. Commit.
### Task A7: Decision 0056 and docs
- [ ] `docs/decisions/0056-projects-shaped.md` (rulings 1 to 5, 18), index line; SPEC.md data and tools; AGENTS.md
  Projects bullet (statuses, fields, views, no person, cap 22). Commit, push, PR A ("Needs your eyes": AGENTS.md).
## PR B `feat/subtasks` (area 2, decision 0057)
### Task B1: Migration 0022 and sub-task writes
**Files:** create `migrations/0022_subtasks.sql`, `src/services/subtasks.ts`; modify `tasks.ts`, `projects.ts`
(appended positions), `lookup.ts` (`lastPosition` planned read), `undo.ts` (`DEPENDENTS`), `record-inputs.ts`,
`proposal-text.ts`, `db.ts`, `migrations.test.ts`.
**Produces:** `add_task {parent}`; `nextPosition(src, projectId, parentId | null): Promise<number>`;
`moveTask(ctx, id, "up" | "down")`; `descendants(src, taskId): Promise<TaskRow[]>`.
- [ ] Tests: existing project tasks numbered by `created_at, id`; parent must be an open task on a live project;
  project mismatch refused; non-project parent refused; any depth stored; undo refused while a child exists; two
  `add_task` actions under one parent in a proposal get positions 1 and 2. Commit `feat: sub-tasks (0022)`.
### Task B2: Completing a parent
**Files:** modify `src/services/tasks.ts`, `record-inputs.ts`, `src/mcp/tools-write.ts`, `src/board/edit-actions.ts`.
- [ ] Tests: open descendants and no `subTasks` refused with the design's question; `complete` finishes all in one
  change; `leave` only the task; the board confirm page with "Complete them too" / "Only this task" / Cancel. Commit.
### Task B3: Reads, Today and the brief
**Files:** modify `src/services/read.ts` (`TaskItem` `parentId`, `parentTitle`, `depth`, `position`, `subTasks`),
`src/board/task-list.ts`, `src/board/records.ts`, `src/brief/compose.ts`.
- [ ] Tests: "<title>, under <parent>, <project>" on Today and in the brief; an outside parent title is "a task".
  Commit `feat: sub-tasks on Today and in the brief`.
### Task B4: The project page tree
**Files:** modify `src/board/pages/project.ts`, `src/board/project-actions.ts` (`/tasks/<id>/move`, sub-task add).
- [ ] Tests: nested lists to three levels; "2 of 5" from direct sub-tasks; add a sub-task under levels 1 and 2 only;
  Move up/down is one change; the deeper note; done subtree in Done; 500-task note. `review-a11y`.
- [ ] Decision 0057 (rulings 11 to 14), SPEC, AGENTS. Commit, push, PR B.
## PR C `feat/task-plans` (area 3, decision 0058)
### Task C1: add_task_plan
**Files:** create `src/services/task-plan.ts`; modify `proposal-actions.ts`, `proposals.ts` (100-task total),
`proposal-text.ts` (indented lines), `proposal-coverage.test.ts`, `src/mcp/tools-write.ts`, `src/mcp/record-write.ts`.
**Produces:** `addTaskPlan(ctx, input: TaskPlanInput): Promise<ChangeResult & { taskIds: string[] }>`;
`TaskPlanItem = { title: string; due?: string; dueDays?: number; under?: number; workType?: string }` (workType from D2);
`checkTree(items): void` (shared with templates).
- [ ] Tests: `under` forward, self or out of range refused; 101 items refused; `dueDays` without a start refused; due
  and dueDays together refused; `add_project` + plan with `@1`; existing project appends; list indented; apply equals
  one-by-one; one change, one undo. Commit `feat: AI task plans`.
### Task C2: D1, instructions and capture
**Files:** modify `src/services/proposals-d1.test.ts`, `docs/PAID-PLAN.md`, `src/mcp/instructions.ts` (+ test),
`seed/defaults.sql`; create `migrations/0023_capture_plans.sql`.
- [ ] Tests: 100-task plan propose and apply each 40 calls or fewer (statements recorded); rule 3's record-text line;
  0023 updates only an unchanged capture document. Decision 0058 (rulings 6 to 8). Commit, push, PR C.
## PR D `feat/project-templates` (area 4, decision 0059)
### Task D1: Migration 0024 and template services
**Files:** create `migrations/0024_templates.sql`, `src/services/templates.ts`, `src/services/template-read.ts`; modify
`db.ts`, `ids.ts` (`tp`, `tt`), `change.ts`, `undo.ts`, `lookup.ts`, `timer.ts` (task work type default), `migrations.test.ts`.
**Produces:** `addTemplate`, `updateTemplate`, `addTemplateTask`, `updateTemplateTask`, `moveTemplateTask(ctx, id,
"up"|"down"|"in"|"out")`, `archiveTemplateTask`, `duplicateTemplate`, `listTemplates`, `getTemplate`.
- [ ] Tests: unique live name; 100-task cap; indent under the task above, outdent to its parent's level; archive takes
  the subtree; duplicate copies the live tree; timer on a task uses its work type. Commit.
### Task D2: Using templates and the AI door
**Files:** modify `projects.ts` (`template`), `proposal-actions.ts`, `proposal-text.ts`, `proposal-coverage.test.ts`,
`task-plan.ts` (`workType`), `src/mcp/tools-write.ts`, `src/mcp/tools-read.ts`, server tests.
- [ ] Tests: `add_project {template}` copies tree, order, work types and dates (start today when offsets and no start);
  later template edits leave the project; `add_template`, `update_template`, `save_project_as_template` propose and
  apply; template tasks count toward 100 and show indented. Commit.
### Task D3: Templates on the board
**Files:** create `src/board/pages/templates.ts`, `template.ts`, `template-task-edit.ts`, `src/board/template-actions.ts`;
modify `routes.ts`, `router.ts`, `actions.ts`, `pages/projects.ts` (link).
- [ ] Tests: list, new, edit, task Edit/Up/Down/Indent/Outdent/Remove, Duplicate, Archive, each one change with 303;
  three levels; work types hidden while time tracking is off; 404 while projects are off. `review-a11y`. Commit.
### Task D4: Start a project from a template, and the seed
**Files:** modify `src/board/pages/project-new.ts`, `project-actions.ts`, `scripts/seed-dev.ts` (+ test).
- [ ] Tests: Template radios with None default; Show tasks previews the tree; save copies it; two seeded templates.
- [ ] Decision 0059 (rulings 9, 10, 17), SPEC, AGENTS. Commit, push, PR D.
## PR E `feat/board-approval` (area 5 and closing, decision 0060)
### Task E1: The setting and the MCP refusal
**Files:** create `migrations/0025_ai_approval.sql`; modify `settings.ts`, `proposals.ts`, `src/mcp/tools-proposals.ts`,
`src/mcp/record-write.ts`, `src/mcp/server.ts` (origin), `src/mcp/instructions.ts`, CLAUDE.md (0054 wording).
- [ ] Tests: `approveIn` board over MCP works, chat refused while board; `apply_changes` refused with
  `<origin>/pending`; propose answers carry the line. Commit `feat: where AI changes are approved`.
### Task E2: Pending changes page
**Files:** create `src/board/pages/pending.ts`, `src/board/pending-actions.ts`; modify `routes.ts`, `router.ts`,
`actions.ts`, `pages/today.ts`.
- [ ] Tests: lists open unexpired proposals; Approve applies as owner with 303 `?change=`; changed-since is 422; Discard
  drops; the setting form; Today notice only when any wait. `review-a11y`, `review-security`. Commit.
### Task E3: Closing
- [ ] Decision 0060 (rulings 15, 16). SPEC.md, AGENTS.md, UPDATING.md "Run 10: after you update" (migrations 0021 to
  0025), ACCEPTANCE.md two sentences per area with e2e tests, STATUS.md (timing table, under 150 lines). Final Opus
  whole-run review. Commit, push, PR E.
