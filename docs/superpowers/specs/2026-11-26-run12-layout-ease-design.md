# Run 12 "App layout and ease of use": design

Date: 2026-11-26. Brief: Grant's run 12 brief (FR-16 in the 09 doc; complete, it ends with END OF BRIEF). The brief is
the owner's approval of the direction; where it leaves something open, this design makes the call and records it as a
ruling (decision 0062) with its cost if wrong. Builds on 0014/0017/0018 (board writes), 0047 (Today), 0050 (timer bar),
0055 to 0059 (projects), 0042/0043 (views and tables), 0011 (brief).

## Intent

The owner and non-technical clients use the board every day. Today it is slow to scan (cards, about one and a half
to-dos per laptop screen), every tap reloads the page, a task cannot be edited and has no description, the project
page squeezes its tasks into a column, and the timer needs a page and a form to stop. Goal: every screen is a dense,
calm list that reads in seconds; one tap opens detail in place; one-tap actions happen where the owner is, with no
reload, and can always be undone.

## Goals

1. Tasks have a Title and a Description, and can be edited on the board. Sub-tasks are capped at three levels.
2. With scripts on, Done, Snooze presets, add task or sub-task, save an edit, move a task, Start timer, Stop and Undo
   happen in place: no navigation, scroll and open rows kept. With scripts off the same forms post and come back at
   the same row.
3. A status corner (top right, every page) holds the timer chip and the latest change notice, with Undo.
4. One shared task row on Today, the project page, and the deal and person pages. Today groups rows under Overdue,
   Today, Upcoming, No due date, with one row per project.
5. Navigation: Today, Deals, People, Projects, Marketing, More. Lists open as tables. The brief becomes a module that
   is off by default.

## Non-goals (from the brief)

In-app AI, voice notes, a new deals board design, new colours or fonts, drag and drop for tasks, reports, campaign
follow-up series, gating more AI writes under On the board only, accounts as records. Also not here: sub-tasks on tasks
that are not on a project (run 10 ruling 11 stands), an MCP tool to edit a task (ruling 4).

## Anti-goals

- A page that needs JavaScript for any action. Every enhanced form is a real form that works without it.
- A second write path. The script posts the same forms to the same routes; every server check (sign-in, origin, size,
  CSRF, the service rules, the audit row) still runs, and the swapped markup comes from the same page renderers.
- Outside text losing its label anywhere: rows, descriptions, the status corner, notices.
- An address that stops working, or a row deleted from any table.
- Motion that loops or runs by itself (the running clock counts, nothing slides on its own).

## Constraints

AGENTS.md and CLAUDE.md hold: `html` tag only; one write path (`commitChange`), audited and undoable; board handlers
call the services; record forms send changed fields only (`was.`); migrations forward-only and data-keeping
(`FAKE_ROWS`); new record actions in `RECORD_ACTIONS` through `recordWrite`, shown by `proposal-text.ts`, covered by
`proposal-coverage.test.ts`; new tools in both tool-list tests. CSP unchanged (`script-src 'self'`; `fetch` to the
same origin is allowed by `default-src 'self'`). Each first-party script at most 3 KB gzipped. No new dependency. The
four required checks and every threshold unchanged; the Lighthouse and a11y lists may drop or swap the brief page and
add at most two pages. Tap targets 44 px (style guide §11), body text 17 px, secondary 15 px.

## Approaches considered

- **In place: (a) a JSON API plus client rendering, (b) the server answers fragments for script requests, (c) the
  script posts the real form, follows the 303 to the same page the no-script user would see, and swaps marked
  regions.** Chosen: (c). One renderer and one write path; nothing new to secure; the swapped markup is exactly the
  no-script page. Cost: a full page render per tap (a few ms of CPU) and a few KB more per response than (b). (a) means
  a second renderer in the browser and loosens the "no framework" rule; (b) doubles every page into page and fragment.
- **Opening rows: (a) a script-driven accordion, (b) native `details`/`summary`.** Chosen: (b), the brief's rule; the
  script only keeps open rows open across swaps (by `id`).
- **Project facts chooser: (a) a new "page layout" table, (b) a saved view of module `projects` reused as the facts
  list, (c) a settings column holding column keys checked by the views column spec.** Chosen: (c). It reuses
  `view-spec.ts`'s projects columns and custom-field keys and its checks, without a view row that would show in the
  switch. Cost: one settings column.
- **Timer Undo: (a) undo the start change, (b) a `cancel_timer` service that archives the running entry.** Chosen:
  (b): it works for a timer started anywhere (also by the AI app, which needs the same tool) and deletes nothing.

## Design direction (style guide changes in the same PRs)

Palette, system fonts, accent, focus ring and the banned list stay. Three changes to docs/STYLE-GUIDE.md, as the brief
words them: (1) lists of records are rows on one quiet panel with thin dividers, cards only for one record's facts,
tight row spacing, whitespace between groups; (2) short motion that answers a tap (a row opening, a notice arriving, a
row leaving when done; 150 to 200 ms, `opacity` and `transform` only, tokens `--motion-fast`, `--ease`) is allowed,
nothing loops or moves by itself, all of it off under reduced motion; (3) the board works with scripts off and is
better with them on. The guide also gains the task row (§7.24), the status corner (§7.25) and the new Today and
project layouts (§5), and §12 says which scripts load where.

One bold element: the status corner, on an `--accent` fill with `--on-accent` text, `--r-card`, `--shadow-bar`. All
else quiet: rows on one white panel, `--divider` lines, no tags except words that carry state (Overdue). Rows are
aligned columns (a CSS grid with fixed column widths shared by every row of a list), never facts joined with dots. No
arrows on buttons, no all-caps, no labels above content. Disclosure marks are CSS-drawn chevrons, not text arrows.
Names stay the same through a flow: Start timer, Timer started, Stop, Time logged; Done, Snoozed, Saved, Added, Moved,
Undone.

## The shared task row (§7.24, `src/board/task-row.ts`)

```
laptop:  [box] Title (one line, ellipsis) .......... Due ........ Belongs to ......... [v]
phone:   [box] Title (up to two lines) ..................................................[v]
               Due · Belongs to   (second line, ink-2; a grid, not a dotted string)
```
- `li.task-row#t-<id>` holds, in order: the Done form (a submit button drawn as a 24 px box inside a 44 px target,
  hidden words "Done: <name>"), one `details#open-<id>` whose `summary` is the row text (title, due, what it belongs to,
  all plain text, no links; the chevron is drawn by CSS at the right end), then, for a row with sub-tasks, a second
  `details#subs-<id>` whose summary ("3 open sub-tasks", hidden words name the task) is placed at the row's right edge
  and whose content is the nested list of the same rows, indented one step, down to level 3.
- Due: day only when the stored time is local midnight ("Fri Nov 27"; with a time "Today 8 PM"); "Overdue" in words
  beside an overdue date (rust), never colour alone. No due: an empty cell (laptop), nothing (phone).
- Belongs to: the project, deal or person name (labelled when outside); a sub-task's parent is shown by its indent.
  Rows inside a project page omit the project.
- Open row content: the description (`pre-wrap`; in owner text, `http(s)://` addresses become links with
  `target="_blank" rel="noopener noreferrer"` and the address as text; outside text never becomes a link and keeps its
  label), the links (Open the deal / person / project), then actions as quiet small buttons in one wrapping line:
  Start timer (when time tracking is on and none runs), Snooze (a nested `details` with the presets and the date),
  Edit (a nested `details` with Title, Due, Description and Save), Add a sub-task (project tasks below level 3 only),
  Move up / Move down (project tasks with siblings only).
- Done rows (project page, Done section) show "Done Thu Nov 26" in the due column and no actions.

## Area 1: titles, descriptions, editing (PR A, migration 0026)

- Migration 0026: `tasks.description TEXT` and `template_tasks.description TEXT`, nullable, CHECK length at most
  10,000. The capture rulebook document gains the title line only when its text is still the seeded one (decision
  0058's pattern), in the same migration and in `seed/defaults.sql`.
- Services: `addTask`, `TaskInput`, `addTaskInput` and `taskPlanItemInput` take `description` (optional, trimmed,
  empty means none, 1 to 10,000 characters, line breaks kept). Owner and AI text is trusted; a description from an
  import is listed in `untrusted_fields`. Template tasks take it too; `template-copy.ts` copies it into a project and
  `save_project_as_template` copies it back (an outside description is left out, as an outside title is).
- `updateTask(ctx, id, patch: { title?, dueAt?: string | null, description?: string | null })` in
  `src/services/tasks.ts`: one audited change (tool `update_task`, actor owner), refused on a done task, reads through
  `lookup.ts`. Board only, no MCP tool (ruling 4). An edited field leaves `untrusted_fields`.
- Depth cap (ruling 5): a task's level is 1 plus its parent's; `addTask` with a parent at level 3, `add_task_plan`
  with an `under` chain deeper than 3 (counting from `under` on the action), and `addTemplateTask` / `update_template`
  / `save_project_as_template` producing level 4 are refused with "Sub-tasks go three levels deep. Add this one under
  a task higher up." Existing deeper rows are kept and still shown in the tree (level 3 says "Has N more levels
  below").
- MCP: `description` on `add_task`, `add_task_plan` items, the task actions in `propose_changes`, and in what
  `list_tasks`, `get_project` and `whats_due` return (`TaskItem.description`; the key is in `untrusted_fields` when it
  came from outside). Proposal text shows a description as "Description: <first 80 characters>…" so
  `proposal-coverage.test.ts` passes. Instructions gain one line: "Keep a task's title short, about 80 characters at
  most, and put steps and detail in its description." The capture document gains the same sentence.
- Export: `tasks` is `SELECT *`, so the column rides along (the JSON export and the CSV both). Import: the tasks module
  gains a `description` column (aliases `notes`, `details`), outside text, limit 10,000.
- Board labels: every task form uses exactly Title and Description (Today's add form, project tasks, sub-tasks, deal
  and person tasks, template tasks). "What to do" and "Add a to-do" go away as field labels.
- Due display: `formatLocal` callers for task dues use a `dueText(iso, tz)` helper that drops the time at local midnight
  (ruling 6). Task routes that take a description are `big` (128 KB).

## Area 2: in place, the status corner and the timer (PR B, no migration, decision 0062)

- `public/live.js` (new, `defer`, at most 3 KB gzipped) loads on every signed-in page. It enhances every form with
  `data-live` (the board's one-tap and row forms): on submit it sends the form with `fetch` (same origin, `redirect:
  "follow"`, the form's own fields including `csrf` and `return_to`). Then:
  - final URL has the current path: parse the HTML with `DOMParser`, and for every `[data-region]` in the new page
    replace the element with the same `data-region` here (`replaceWith` of an imported node; never `innerHTML`); keep
    every `details[id]` that was open open; keep scroll; move focus to the form's `data-after` element, else the
    same control by `id`, else the corner. The address does not change.
  - another path (a confirm page, the 422 page, an error): `location.assign(url)` for a redirect to a GET page; for a
    422 or any non-OK answer, submit the form natively (a refused post wrote nothing), so the page shows the error.
  - a network failure: the corner shows "Couldn't save. Check your connection and try again." and nothing else.
- Regions: `corner` on every page; Today `today-head`, `today-list`; the project page `project-facts`,
  `project-tasks`, `project-done`; deal and person pages `tasks`. Add forms sit in the region they add to, so a
  successful add clears them.
- Scripts off: forms may carry a hidden `at` (an element id, `^[a-z][a-z0-9_-]{0,80}$`); the action kit appends
  `#<at>` to the 303 location. Done sets `at` to the next row's id (or the group's heading), so the page comes back at
  the same place. `return_to` keeps refusing fragments; `at` is checked on its own.
- Status corner (§7.25, `src/board/corner.ts`): first child of `.app-body`, `position: sticky; top: 0`, aligned right,
  zero height when empty, never covering more than its own chips, no focus trap. It holds:
  - the timer chip while a timer runs: the elapsed time (`<time data-since>`; the script counts it every 15 s, as
    H:MM; scripts off show "since 9:10 AM" as today), a short name of what is timed (the safe label, cut to 32
    characters with an ellipsis), Stop and Undo. The clock is outside the live region, so it is never announced.
  - one notice (`role="status"`, always present, empty when quiet): the change of `?change=` in words with Undo,
    "<Verb>: <safe name>" for one-record task and timer changes (Done, Snoozed, Added, Saved, Moved, Timer started,
    Time logged, Timer discarded, Undone), else the change's summary. Replaces the old banner after the h1.
  - the Time logged note: after a stop, "Time logged: 1:16 PM to 1:58 PM", then Edit or add notes, Undo and Close.
    It shows on every page while no timer runs, the latest timer change is that stop, it is at most 2 minutes old, not
    undone, and not closed. Close posts `/corner/close`, which sets an HttpOnly, SameSite=Strict cookie naming that
    change (no database write). With scripts on, the note also leaves when its 2 minutes are up.
- Timer: Start timer posts `/timer/start` in place. Stop posts `POST /timer/stop/now`: `stopTimer` with `{}` (start to
  now, the timer's work type and billable), then back to `return_to` with the change. `GET /timer/stop` (the old form)
  keeps working. Undo on the chip posts `/timer/cancel`: `cancelTimer` archives the running entry (end stays empty,
  `archived = 1`, so totals and the one-running index skip it); when it has run more than 5 minutes and the form has no
  `confirm=yes`, the board answers a confirm page ("Discard the timer? It has run 12 minutes."); with scripts on the
  chip asks inline instead (Discard timer / Keep it), then posts with `confirm=yes`. Undoing the cancel brings the timer
  back unless another runs.
- Edit or add notes: `GET /timer/notes?entry=te_…&back=<path>` (the stop form's fields for the saved entry: notes, work
  type, billable, next step date, start, end; the timer done page's Ask Claude rows) and `POST /timer/notes`, which
  calls `amendTime(ctx, entryId, input)` in `src/services/timer.ts`: the same effects `stopTimer` writes (entry fields,
  a note when notes are given, a Next step task for a date), one change, tool `stop_timer`, built by the shared helper
  that `stopTimer` now also uses. Saving returns to `back` (checked by `boardReturnPath`), else `/timer/done`.
- MCP `cancel_timer` (no input): a record action in `RECORD_ACTIONS`, through `recordWrite`, small exactly when
  `stop_timer` with no next step is (so: always small), refused when no timer runs; proposal text "Discard the running
  timer (<safe name>, started 9:10 AM)". Instructions mention it in the timer line.

## Area 3: the row everywhere, Today and the project page (PR C, migration 0027)

- Today (`/`): head as the sketch: h1 "Today", the date, the summary line, and the stage counts as a compact block at
  the top right (a wrapped line on a phone). The Latest brief block goes. The waiting-AI-changes notice stays as one
  slim line. The add form is one line: Title, Due, Add. Sort and Show are one line, in a `details open` the script
  closes under 40rem; with scripts on, choosing applies at once (the submit button hides).
- Groups, plain h2s: Overdue, Today, Upcoming, No due date (empty groups are left out; nothing at all is the empty
  state). Which to-dos qualify does not change (`openTaskLists`: every open, awake task). Rows: loose tasks and tasks
  on a deal or person, deal next steps due today or overdue (as rows with Open the deal), and one row per project.
- A project row: the project name (labelled when outside), "N tasks, M overdue" (N = top-level tasks that are open or
  have open sub-tasks; M = qualifying tasks at any depth that are overdue), the soonest due date, in that date's group.
  Opening it shows those top-level tasks as rows in position order, each with its open sub-task count, opening further
  down the same way, and Open the project.
- Sort (due, newest, person) orders rows inside each group; Show (all, linked, standalone) filters as today.
- Project page (`/projects/<id>`), one column: Back to projects; h1 and the status tag, Edit, Archive; the facts block
  (`project-facts`): the owner's chosen facts, notes and long text behind "Notes"; change status inline; then Add a
  task (Title, Due, Description, Add task); Open tasks as rows with "3 of 24 done" on the heading line; Done behind a
  `details`; Notes (log and timeline). Start timer stays in the facts block while time tracking is on.
- Facts chooser (ruling 8): migration 0027 adds `settings.project_facts TEXT` (JSON array or null). Keys: the projects
  view columns except `project` (`status`, `person`, `deal`, `start`, `target`, `open_tasks`), `time`, and
  `fields.<key>`, checked by `view-spec.ts`. Null means the default: status, person, deal, start, target, time (when
  time tracking is on), then every live custom field. MCP `update_settings { projectFacts: string[] }`, shown by
  `get_settings`. Board: "Choose facts" in the block opens `/projects/facts` (a checkbox and a position per key, Save),
  calling the same settings service as the owner.
- Deal and person pages: their task lists become the shared rows (region `tasks`).

## Area 4: navigation, names, tables and the brief switch (PR D, migration 0028)

- Tabs (`navItems`): Today `/`, Deals `/pipeline`, People `/leads`, Projects `/projects` (projects on), Marketing
  `/campaigns` (campaigns on), More. Phone tab bar: columns follow the item count; under 60rem Marketing is not a tab
  and the More page lists it (ruling 10: at 320 px six tabs give 53 px each and "Marketing" needs about 64 px at 13 px).
  More lists Time, Templates, Brief (when on), Rules, Changes, Pending changes, What it caught, Export, Import,
  Notifications (when the brief is on), Email logging. The Projects page links Templates.
- Renames (labels only, addresses kept): the Pipeline tab and page become Deals (h1 "Deals", "Back to deals"); the
  product name stays Pipeline. Companies becomes Accounts (People switch and `/companies` page). The person field
  Company becomes Account everywhere the owner sees it (forms, list columns, sort labels "Account, A to Z", search
  hints, the empty group "No account", MCP descriptions); the import's people and deals modules accept "Account" and
  "Company" as aliases of `business`. Stored names and tool parameters do not change.
- People switch order: Leads, Contacts, Accounts, Partners, other statuses, saved views. People opens on Leads.
- Tables by default: People, Leads, Accounts, people status views, Projects, Templates, Campaigns, Time; each offers
  Show as (cards or table) where it has both. Deals opens as the board; List one tap away. Saved views keep their
  stored layout.
- Brief switch (ruling 11): migration 0028 adds `settings.brief INTEGER NOT NULL DEFAULT 0` (every copy off, existing
  ones included). Off: no Brief item, `/brief` and `/notifications` are 404, the hourly run skips `runBrief` (so no
  compose, email or push), the notification test send refuses. Rules keep running (a test runs the scheduled jobs with
  the brief off and proves the rules job ran and no brief row was stored). `update_settings { brief: boolean }`; the
  demo seed turns it on, so a11y and Lighthouse keep scanning `/brief`.

## Pages added to the lists

`/projects/facts` and `/timer/notes?entry=te_seed01` join `boardRoutes` (a11y); Lighthouse keeps its 22 and swaps in
nothing (rulings 12). No threshold changes.

## Seed and screenshots

The demo seed has three projects (5 to 25 tasks, three levels deep in two of them) and 30 loose to-dos, some overdue.
`tests/screenshots/owner-screens.screens.ts` saves Today, Deals, People, a project and the timer stop page at 390 x 844
and 1440 x 900, before (main's code) and after. A Playwright test in `tests/a11y/` (run by the required a11y job)
proves: Done, Start timer, Stop and Undo cause no navigation with scripts on and work with scripts off; Today shows at
least 12 rows at 1440 x 900 and 6 at 390 x 844 with the demo seed.

## Builder check answers (settled here; none needed the owner)

1. Budgets: hosting is Workers Paid (1,000 D1 queries a request, decision 0054), but Today and the project page are
   held to at most 20 D1 calls a render each, counted by a unit test with `tests/helpers/counting-db.ts`. If `live.js`
   cannot fit 3 KB gzipped, the clock and the note's expiry move to a second file `/clock.js` (same rules); if still
   over, the inline Discard confirm is cut and the server's confirm page is used.
2. The script compares path plus query with `change` removed; equal means swap. The address bar is never changed.
   A reload after a swap shows the page without the notice (the change is in Changes).
3. The corner adds one D1 read per page (the latest timer change with its time, batched with the running timer read in
   `timerState`); the close cookie is read in `contextFor` from the request. `POST /corner/close` is a route in the
   action table (sign-in, origin and CSRF are checked) that writes no data and only sets the cookie.
4. `/contacts` keeps serving Contacts. The People tab links `/leads`; `/contacts`, `/leads`, `/companies`, `/people`
   and person pages all mark People current.
5. Lighthouse keeps exactly its 22 entries (the new pages are form pages of kinds already scored). The demo seed turns
   the brief on, and `npm run preview` loads that seed, so `/brief` and `/notifications` stay scored.
6. Stored `briefs` rows stay. With the brief off nothing new is stored; `/api` still answers the latest stored brief;
   `get_settings` still reports `lastBriefAt`. Nothing else reads briefs.
7. PR B updates AGENTS.md "Browser JavaScript" (live.js on every framed page, same-origin `fetch` of board forms only,
   `DOMParser` and `replaceWith`, never `innerHTML`), `renderPage` always adds `/live.js` when it has a frame, and
   the script-size test covers it.
8. `time` is a facts-only key: the facts check is the projects view columns without `project`, plus `time`, plus
   `fields.<key>`. Saved views do not gain `time`.
9. The one-running index is `WHERE ended_at IS NULL AND archived = 0` (migration 0018) and `runningTimer` skips
   archived rows, so `cancel_timer` needs no migration.
10. `amendTime` writes under tool `log_time`. The note's rule looks only at `start_timer`, `stop_timer` and
    `cancel_timer`; saving notes also sets the close cookie, so the note does not come back.

## Rulings (decision 0062; cost to change in brackets)

1. In place = the script posts the real form and swaps marked regions of the page the server would show. [Medium:
   a fragment API would touch every page.]
2. The old change banner moves into the status corner. [Small.]
3. The Time logged note lasts across pages for 2 minutes unless closed; Close is a cookie, not a database row. [Small.]
4. Task edits are board only; no `update_task` MCP tool. [Small: a tool over `updateTask` plus proposal text.]
5. The three-level cap counts from the top; deeper existing rows stay. [Small.]
6. A due at local midnight is a date with no time. A task really due at midnight shows as a day. [Small: a flag column.]
7. Timer Undo archives the running entry (`cancel_timer`); asks first after 5 minutes. [Small.]
8. Project facts are a settings column of view column keys. [Medium: moving to views later needs a migration.]
9. Project rows on Today count top-level tasks open or with open sub-tasks; overdue counts any depth. [Small.]
10. Marketing is under More on phones. [Small: CSS and the More page.]
11. The brief is a module switch (`settings.brief`), apart from `brief_enabled` (which still means "email it"). [Small.]
12. Lists: two pages added to a11y, Lighthouse unchanged at 22. [Small.]
