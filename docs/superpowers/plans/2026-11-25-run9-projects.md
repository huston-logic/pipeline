# Run 9 "Projects" Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`. Each task:
> failing tests first, then code, `npm run check:fast` passes, one commit, one Sonnet review.

**Goal:** A Project record for delivery after the sale, made from a won deal or by hand, off by default.
**Architecture:** Three PRs, each branched from `main` (build the next on the previous tip while CI runs, rebase onto
`main` after the squash merge, no force push). A `feat/projects-core`: data, services, links, reads, MCP door, proposal
list, decision 0055. B `feat/projects-board`: every board page, section, label and action. C `feat/projects-closing`:
exports, time CSV, seed, acceptance 35 to 38, UPDATING, STATUS. No new dependencies.
**Spec:** `docs/superpowers/specs/2026-11-25-projects-design.md` (binding for this run; read the section a task names).

## Global Constraints
- AGENTS.md and CLAUDE.md hold. Every write through `commitChange`; markup through `html`; no `raw()` for data.
- Off by default: `settings.projects = 0`; every project tool, service, input and board path refuses or 404s while off
  (`PROJECTS_OFF`, design "Link rules"). Nothing about projects shows while off (ruling 10).
- Fake people only; new id prefix `pj`; migration `0020_projects.sql`, forward-only, every earlier row kept.
- A won deal is never changed by a project (anti-goal). Board copy plain and short; copy the design's quoted strings.
- Reads by id in record services go through `lookup.ts`; settings-like reads through `memo.ts` (AGENTS "Proposals").

## Review Focus
1. A project task, note or entry always has the project's person and no deal; every refusal in "Link rules" holds for
   the board, MCP direct writes and proposals alike (tests in A3, A4).
2. Apply equals running the actions one by one, with `add_project` then `add_task {project: "@1"}` in one list (A6).
3. Every column a project list writes shows in some item; `proposal-coverage.test.ts` covers each new optional field (A6).
4. The maximum-size propose and apply stay at 40 D1 calls or fewer (A6).
5. Projects off: no nav item, no section, no label, every path 404, every tool refuses (A2, B1, B4).

## PR A: `feat/projects-core`
### Task A1: Migration 0020 and the tables' plumbing
**Files:** create `migrations/0020_projects.sql`; modify `seed/defaults.sql` (the three statuses), `src/db/db.ts` (row
types, `TableName`, `project_id` on tasks, activities, time entries), `src/ids.ts`, `src/services/change.ts`
(`PRIMARY_KEYS`, `ROW_NOUNS`, `BULK_ORDER`), `src/services/labels.ts` (`projectTitle`, `projectLabel`),
`src/services/lookup.ts` (`projectById`), `src/services/undo.ts` (`DEPENDENTS`), `src/db/migrations.test.ts` (`FAKE_ROWS`).
- [ ] Tests: earlier data kept; `settings.projects` 0; three statuses in order; `projects` CHECKs (name length, archived);
  the three new `project_id` columns null on old rows; undo of a project's add refused while a task points at it.
- [ ] Schema exactly as the design's "Data". Commit `feat: projects tables (0020)`.
### Task A2: Setting and statuses
**Files:** modify `src/services/settings.ts` (`projects`, `PROJECTS_OFF`, `requireProjects`), `src/services/memo.ts`
(`projectStatusRows`), `src/mcp/tools-write.ts` (`update_settings projects`); create `src/services/project-statuses.ts`.
**Produces:** `requireProjects(src: Reader): Promise<void>`; `projectStatusLabels(src): Promise<Map<string, string>>`;
`updateProjectStatus(ctx, key, label): Promise<ChangeResult>`.
- [ ] Tests: `update_settings` turns it on and off with a summary; `get_settings` shows it; a rename is one undoable change;
  an unknown key or an empty or duplicate label refuses plainly; off refuses. Commit `feat: projects setting and statuses`.
### Task A3: Projects service and link rules
**Files:** create `src/services/projects.ts`, `src/services/project-links.ts`.
**Produces:** `addProject(ctx, input: ProjectInput): Promise<ChangeResult & { projectId: string; contactId: string }>`;
`updateProject(ctx, ref, patch): Promise<ChangeResult & { projectId: string }>`; `findProject(src, ref)` (id or exact
live name; several matches refused with ids); `projectLinks(src, ref): Promise<{ project, contact }>` (refuses archived).
- [ ] Tests: each rule and refusal in "Link rules" and "Services"; name default from a trusted deal title, required for
  an outside one; `moveOpenTasks` moves open (and snoozed) tasks, leaves done ones; undo restores the moved tasks; the
  deal row is byte-identical before and after. Commit `feat: projects service`.
### Task A4: Tasks, notes and time on a project
**Files:** modify `src/services/tasks.ts`, `src/services/activities.ts`, `src/services/time-entries.ts`,
`src/services/timer.ts`, `src/services/record-inputs.ts` (a `project` input on `add_task`, `log_activity`,
`start_timer`, `add_time_entry`, `update_time_entry`).
- [ ] Tests: each writes `project_id`, the person, no deal; a deal with a project refused; another person refused; a
  task on a project puts an entry on it; a task of another project refused; clearing an entry's project keeps its
  person; a stopped project timer logs its note with `project_id`; any `project` while off is `PROJECTS_OFF`.
- [ ] Commit `feat: tasks, notes and time on a project`.
### Task A5: Reads
**Files:** create `src/services/project-read.ts`; modify `src/services/read.ts` (task items and `list_tasks` carry
`projectId`, `projectName`, `project` filter; `get_deal` lists projects; only while on).
- [ ] Tests: list filters, sort, cap 200 with total, open-task counts; `getProject` sections and time totals (on only);
  an outside value listed in `untrusted_fields`. Commit `feat: read projects`.
### Task A6: MCP door, proposal list and the Won question
**Files:** modify `src/services/proposal-actions.ts` (`RECORD_ACTIONS`, schemas, `REF_FIELDS`, `ADDS`, `runAction`),
`src/services/name-match.ts` (projects in `matchAll`), `src/services/proposal-text.ts`, `src/services/proposals.ts`
(applied Won deals: `ApplyResult.wonDeals: string[]`), `src/mcp/tools-write.ts` (`add_project`, `update_project`,
`update_project_status`), `src/mcp/tools-read.ts` (`list_projects`, `get_project`), `src/mcp/tools-proposals.ts`, `src/mcp/record-write.ts`, `src/mcp/instructions.ts`,
`src/mcp/server.test.ts`, `tests/e2e/mcp.test.ts`, `src/services/proposal-coverage.test.ts`.
- [ ] Tests: tool lists updated; `add_project`/`update_project` propose under both AI-edits settings; `@n` project
  refs; ambiguous project names are questions; each list line names the project; the unshown check passes; D1 counts;
  the Won line and `startProject` appear only when on and the deal has no live project, with no outside text.
- [ ] Commit `feat: projects in the AI app`.
### Task A7: Decision, spec and rules files
**Files:** create `docs/decisions/0055-projects.md` (the design's rulings 1 to 12) and its index line; modify
`docs/SPEC.md` (data, tools, board), AGENTS.md (a Projects bullet). Commit `docs: projects decision 0055`. Push, PR A
("Needs your eyes": AGENTS.md).

## PR B: `feat/projects-board`
### Task B1: Nav, list and 404s
**Files:** modify `src/board/routes.ts` (`moreItemsFor`, `boardRoutes`), `src/board/layout.ts` (`PageFrame.projects`),
`src/board/router.ts`, `src/board/context.ts`; create `src/board/pages/projects.ts`.
- [ ] Tests: More lists Projects only when on; every project path 404 when off; status and sort from the address,
  unknown is the default; cards and table (caption, `th scope`, `aria-sort`); the lede. Commit `feat: Projects list`.
### Task B2: Project page
**Files:** create `src/board/pages/project.ts`, `src/board/project-actions.ts` (`PROJECT_ROUTES`); modify
`src/board/actions.ts`, `src/board/timer-start.ts` (hidden `project`), `src/board/time-actions.ts`.
- [ ] Tests: sections and their order; time card only with time tracking on; status Save, Archive, Bring back, quick add
  and log each call the service as the owner with the MCP tool name and 303 with `?change=`; a refusal is a 422 with
  values kept; Start timer with a project. Commit `feat: project page`.
### Task B3: New and edit
**Files:** create `src/board/pages/project-new.ts`, `src/board/pages/project-edit.ts`, specs in
`src/board/project-form.ts`.
- [ ] Tests: from a person and from a won deal (pre-filled name, unticked move box with the count); a not-won deal is
  404; edit sends only changed fields (`was.`); dates read in the owner's timezone. Commit `feat: start and edit a project`.
### Task B4: Deal, person, Today and brief
**Files:** modify `src/board/pages/deal.ts`, `src/board/pages/contact.ts`, `src/board/pages/today.ts`,
`src/board/records.ts`, `src/brief/compose.ts` (and its input in `src/brief/run.ts`).
- [ ] Tests: "Start a project?" on a won deal with no project, gone once one exists; Projects sections on both pages; a
  project task's label on Today and in task cards; the brief line names the project; none of it while off.
- [ ] Commit `feat: projects on the deal, person, Today and brief`. Run `npm run test:a11y` if Chromium runs (Needs
  Grant 10); `review-a11y` on B1 to B4. Push, PR B.

## PR C: `feat/projects-closing`
### Task C1: Exports and the time CSV
**Files:** modify `src/http/export.ts`, `src/board/pages/export.ts`, `src/http/time-csv.ts`.
- [ ] Tests: JSON has both tables; the CSV links only when on; the time CSV's project column and grouping, a formula-like
  name guarded. Commit `feat: projects in the exports`.
### Task C2: Demo seed
**Files:** modify `scripts/seed-dev.ts` (and `tests/helpers/fixture-seed.ts` if a test needs it).
- [ ] The design's two projects; `npm run screenshots` only if Chrome runs. Commit `feat: demo projects`.
### Task C3: Acceptance, UPDATING, STATUS
- [ ] `docs/ACCEPTANCE.md` sentences 35 to 38 with e2e tests in `tests/e2e/projects.test.ts` (own `extraVars`): "Turn on
  projects"; "Mark the retrofit deal won" then the AI's question and a yes; "Add a task to the retrofit project: order
  anchors, due Friday"; "How much time is on the retrofit project?".
- [ ] `docs/UPDATING.md` "Run 9: after you update" (migration 0020; projects stay off until turned on); STATUS.md
  (state, changelog, Needs Grant: the Lighthouse slot (ruling 9) and the cut-off brief line (ruling 1), the timing
  table, judgment calls). Commit, push, PR C.
