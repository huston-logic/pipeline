# Run 12 "App layout and ease of use" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** dense rows, task descriptions and edits, one-tap actions in place with a status corner and timer, new nav,
names, table defaults and a brief switch (FR-16). **Architecture:** pages stay server-rendered; `public/live.js` posts
the real forms and swaps `[data-region]` parts of the page the 303 leads to. Services stay the one write path.
**Spec:** `docs/superpowers/specs/2026-11-26-run12-layout-ease-design.md` (read it; rulings 1 to 12, builder answers).

## Global constraints
- AGENTS.md and CLAUDE.md rules; `html` tag only; services only; changed fields only; outside text labelled.
- No new dependency; CSP unchanged; scripts at most 3 KB gzipped; no threshold or check change; 44 px targets; 17/15
  px text; tokens only; no arrows on buttons, no all-caps, no dot-joined facts.
- Labels: Title, Description, Due; Start timer, Timer started, Stop, Time logged; Done, Snoozed, Saved, Added, Moved.
- Works with scripts off; old addresses keep working; nothing deleted; migrations 0026 (A), 0027 (C), 0028 (D) with
  `FAKE_ROWS` coverage in `src/db/migrations.test.ts`.
- Board markup or CSS tasks: run `npm run test:a11y` locally and the `review-a11y` agent.

## Review focus
1. Outside text in a description or title: never a link, labelled in the row, the corner and the proposal list (A3, B3).
2. A refused post (422) with scripts on: the form error page shows; nothing is written twice (B4 test).
3. Two tabs: a timer stopped in one, Stop tapped in the other: plain "No timer is running." (B2 test).
4. A task three levels deep: no Add a sub-task offered; MCP refuses level 4; existing level-4 rows still show (A1, C1).
5. Brief off: the hourly run still fires follow-up rules and stores no brief (D3 test).

## PR A `feat/run12-tasks` (this branch; seed and spec already committed)

### Task A1: description, updateTask and the depth cap (services, migration 0026)
**Files:** `migrations/0026_task_descriptions.sql`, `seed/defaults.sql`, `src/db/db.ts`, `src/services/tasks.ts`,
`subtasks.ts`, `task-plan.ts`, `templates.ts`, `template-copy.ts`, `record-inputs.ts`, `lookup.ts`, tests beside them.
**Produces:** `TaskRow.description: string | null`; `TaskInput.description?: string`;
`updateTask(ctx: Ctx, id: string, patch: { title?: string; dueAt?: string | null; description?: string | null }): Promise<ChangeResult>`
(tool `update_task`; refused on a done task: "This task is done. Reopen it before editing.");
`taskLevel(src: Source, taskId: string): Promise<number>`; `MAX_TASK_LEVEL = 3`;
`TOO_DEEP = "Sub-tasks go three levels deep. Add this one under a task higher up."`.
- [ ] Tests first: description stored trimmed, 10,001 characters refused, line breaks kept; `updateTask` changes only
  given fields, drops an edited key from `untrusted_fields`, undo restores; level-4 refused for `addTask`, a plan's
  `under` chain, `addTemplateTask`, `save_project_as_template`; an existing level-4 row still reads; template copy and
  save-as-template carry the description (an outside one is left out). Migration keeps data; the capture document
  gains the title line only when unchanged.
- [ ] Implement; `npm run check:fast`; commit "feat: task descriptions, task edits and the three-level cap".

### Task A2: the AI app and the data doors
**Files:** `src/services/read.ts` (`TaskItem.description`), `project-read.ts`, `proposal-text.ts`,
`src/mcp/tools-write.ts`, `tools-read.ts`, `instructions.ts`, `src/import/modules/tasks.ts`, tests.
- [ ] Tests first: `add_task`, `add_task_plan` items and `propose_changes` task actions accept `description`;
  `list_tasks`, `get_project`, `whats_due` return it; the proposal item shows "Description: <first 80>…"
  (`proposal-coverage.test.ts` variant); instructions contain "Keep a task's title short, about 80 characters at most,
  and put steps and detail in its description."; tasks import maps `description` (aliases `notes`, `details`) as
  outside text, limit 10,000; the export CSV has the column.
- [ ] Implement; check:fast; commit.

### Task A3: board labels, Edit, description display, day-only dues
**Files:** `src/board/task-forms.ts`, `project-tree.ts`, `template-form.ts`, `edit-actions.ts`, new `src/board/links.ts`
(`linkify(text: string, trusted: boolean): Html`), `src/time.ts` (`dueText(iso: string, tz: string): string`), tests.
- [ ] Tests first: every task form's labels are exactly Title, Description, Due (no "What to do", no "Add a to-do");
  `POST /tasks/<id>/edit` (big) saves changed fields only and redirects with the change; a refused edit is a 422 with
  values kept; `linkify` makes `https://…` a `target="_blank" rel="noopener noreferrer"` link only when trusted and
  never matches `javascript:`; `dueText` gives "Fri Nov 27" at local midnight and "Fri Nov 27, 8:00 PM" otherwise.
- [ ] Implement (Edit is a `details` with the form under each task's actions for now; C1 moves it into the row).
- [ ] check:fast; commit. Push and open PR A ("Needs your eyes": AGENTS.md if touched; migration 0026).

## PR B `feat/run12-live` (from A's tip; rebase onto main after A merges)

### Task B1: cancel and amend the timer (services and MCP)
**Files:** `src/services/timer.ts`, `src/mcp/tools-write.ts`, `record-write.ts`, `proposal-actions.ts`,
`proposal-text.ts`, `instructions.ts`, both tool-list tests.
**Produces:** `cancelTimer(ctx: Ctx): Promise<ChangeResult & { entryId: string }>` (archives the running entry; "No timer
is running."); `amendTime(ctx: Ctx, entryId: string, input: StopInput): Promise<ChangeResult & { taskId: string | null }>`
(tool `log_time`; shares `timeLogEffects` with `stopTimer`); MCP `cancel_timer` (no input, in `RECORD_ACTIONS`, small).
- [ ] Tests first: cancel then `runningTimer` is null and totals skip it; undo of the cancel restores it, refused while
  another timer runs; amend writes entry, note and Next step task in one change; `stopTimer` behaves as before;
  proposal text "Discard the running timer (<name>, started 9:10 AM)". Implement; check:fast; commit.

### Task B2: timer and corner routes, and coming back at the row
**Files:** `src/board/time-actions.ts`, `action-kit.ts` (`redirect` appends `#<at>`; `AT_PATTERN =
/^[a-z][a-z0-9_-]{0,80}$/`), new `src/board/pages/timer-notes.ts`, `router.ts`, `routes.ts`, tests.
- [ ] Tests first: `POST /timer/stop/now` stops with `{}` and 303s to `return_to?change=`; a second one says "No timer
  is running."; `POST /timer/cancel` over 5 minutes without `confirm=yes` answers the confirm page, with it cancels;
  `GET /timer/notes?entry=te_…&back=/` shows notes, work type, billable, next step date, start, end and Ask Claude;
  its post calls `amendTime`, sets the close cookie and returns to `back`; `POST /corner/close` sets
  `pipeline_corner=<chg id>` (HttpOnly, SameSite=Strict, Path=/, Max-Age=300); a bad `at` is ignored; off is 404.
- [ ] Implement; `/timer/notes?entry=te_seed01` into `boardRoutes`; check:fast; commit.

### Task B3: the status corner
**Files:** new `src/board/corner.ts`, `timer-bar.ts` (extend `timerState` with `startedAt`, `latestTimerChange`),
`banner.ts`, `layout.ts`, `router.ts`, `context.ts`, `public/board.css`, tests.
**Produces:** `corner(state: CornerState, form: FormContext): Html` with `data-region="corner"`;
`noticeText(change: ChangeItem, name: string | null): string`.
- [ ] Tests first: chip shows a safe label cut to 32 characters, "since 9:10 AM", Stop and Undo forms; notice
  "Done: <title>" (task title from outside shows "task tk_…"); Time logged note rules (2 minutes, closed cookie,
  undone, a newer start); the old banner is gone from after the h1; one live region; the clock is outside it.
- [ ] Implement, CSS per spec §7.25; run local a11y and `review-a11y`; commit.

### Task B4: `public/live.js` and the in-place proof
**Files:** `public/live.js`, `src/board/forms.ts` (`postForm` option `live?: { after?: string }` adds `data-live`,
`data-after`, hidden `at`), `layout.ts`, `scripts/build.test.mjs` size case, `src/security.test.ts`, AGENTS.md,
`docs/STYLE-GUIDE.md` (§9 motion, §12 scripts), new `tests/a11y/in-place.spec.ts`, decision 0062.
- [ ] Mark Done, Snooze presets, add task or sub-task, Edit save, Move, Start timer, Stop, Undo, Close as live forms.
- [ ] `tests/a11y/in-place.spec.ts`: with scripts on, Done, Start timer, Stop and Undo leave
  `performance.getEntriesByType("navigation").length` at 1 and a `window.marker` set before the tap survives; with
  `javaScriptEnabled: false` each still works and lands on the same page. Restore the data it changes.
- [ ] Implement; gzip size under 3 KB; local a11y; `review-a11y` and `review-security`; commit. Push, PR B.

## PR C `feat/run12-rows` (from B's tip)

### Task C1: the shared task row, deal and person pages
**Files:** new `src/board/task-row.ts`, `records.ts`, `pages/deal.ts`, `pages/contact.ts`, `project-tree.ts`,
`public/board.css`, `docs/STYLE-GUIDE.md` (§1 and §4 lists rule, §7.24), tests.
**Produces:** `taskRow(row: RowTask, opts: RowOptions, form: FormContext): Html`;
`RowTask = TaskItem & { children?: RowTask[]; level: 1 | 2 | 3 }`; `RowOptions = { now: Date; tz: string; showBelongs: boolean; at?: string }`.
- [ ] Tests first: row markup per spec (Done button with hidden name, `details#open-<id>`, `details#subs-<id>` only
  with children, "Overdue" in words, outside title labelled, description linkified only when trusted, Add a sub-task
  only below level 3 on project tasks). Implement; a11y; `review-a11y`; commit.

### Task C2: Today
**Files:** `src/services/read.ts` (`todayRows(db, now, tz, view): Promise<TodayGroups>`), `pages/today.ts`,
`public/board.css`, `docs/STYLE-GUIDE.md` §5, `tests/a11y/today-density.spec.ts`, tests.
- [ ] Tests first: groups Overdue, Today, Upcoming, No due date; one row per project with N, M and soonest due (ruling
  9); deals due as rows; sort and show (`data-autosubmit`: live.js submits on change, hides the button, closes the
  `details` under 40rem); no Latest brief; at most 20 D1 calls (counting-db); Playwright counts `[data-task-row]`
  fully in view: at least 12 at 1440 x 900, at least 6 at 390 x 844. Implement; a11y; commit.

### Task C3: the project page and its facts (migration 0027)
**Files:** `migrations/0027_project_facts.sql`, `src/services/settings.ts`, `view-spec.ts` (`PROJECT_FACT_KEYS`),
`src/mcp/tools-write.ts` (`projectFacts`), `pages/project.ts`, new `pages/project-facts.ts`, `project-actions.ts`.
- [ ] Tests first: default facts; `update_settings { projectFacts }` refuses unknown keys; one column order per spec;
  `/projects/facts` saves as the owner; at most 20 D1 calls. Implement; add `/projects/facts` to `boardRoutes`;
  a11y; `review-a11y`; commit. Push, PR C.

## PR D `feat/run12-nav` (from C's tip)

### Task D1: tabs and names
**Files:** `src/board/routes.ts`, `layout.ts`, `people-switch.ts`, `view-spec.ts`, pages for contacts, leads,
companies, pipeline, deal, `record-form.ts`, `src/import/modules/people.ts`, `deals.ts`, `src/mcp/*` descriptions,
`public/board.css`, `pages/more.ts`, nav tests.
- [ ] Tests first: tab order and on/off rules (four tabs with projects, campaigns and brief off); People links `/leads`
  and is current on `/contacts`; Marketing hidden under 60rem and listed on More; Deals, Accounts, Account labels; import
  aliases `Account`, `Company`; the 320 px tab bar keeps 44 px targets. Implement; a11y; `review-a11y`; commit.

### Task D2: tables by default
- [ ] Tests first: People, Leads, Accounts, status views, Projects, Templates, Campaigns, Time open as tables with Show
  as; Deals opens as the board; saved views keep their layout; Projects links Templates. Implement; a11y; commit.
### Task D3: the brief switch (migration 0028)
**Files:** migration, `src/cron.ts`, `src/brief/run.ts`, `settings.ts`, `tools-write.ts` (`brief`), `router.ts`,
`routes.ts`, `push-actions.ts`, `scripts/seed-dev.ts` (brief on), tests.
- [ ] Tests first: off: no Brief item, `/brief` and `/notifications` 404, no brief stored, rules still fire; on:
  everything back. Implement; commit.
### Task D4: closing
- [ ] After shots into `.owner-review/run12/after/`, looked at; final Opus review; STATUS (Needs Grant copy, timings).
