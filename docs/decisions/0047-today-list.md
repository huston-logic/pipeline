# 0047: Today works like a list

Run 6, task B4, 2026-11-24. Builds on 0046 (standalone tasks), 0018 (board forms) and 0043 (table layout).

## Context

With tasks able to belong to no one (0046), Today becomes the owner's daily to-do list, not only a place that shows
what is due. The brief fixed the labels, the query keys and the route; it left open how the two lists are drawn, what
"overdue" means for the sort, and how the refused form and the empty state read.

## Decision

- **Two lists** (`openTaskLists` in `src/services/read.ts`: the open tasks that are not snoozed past now): **To do**
  (has a due date) and **Needs a due date** (none). A snoozed task shows again once its time has passed. The address's
  sort and filter are read in `src/board/task-list.ts`; since the run 6 final review the database filters, sorts and
  cuts each list (one query per list, `LIMIT 50`, plus one grouped count for "Showing 50 of N"), all in one D1 batch,
  instead of every open task being read and sorted in the Worker (16 ms of Worker CPU with 3,140 open tasks; now about
  7 ms, docs/PAID-PLAN.md).
- **Address:** `sort=due|newest|subject` and `show=all|linked|standalone`, nothing else, never record text. An unknown
  value is the default (`due`, `all`). `due` is soonest first, so overdue tasks come first; `newest` is by when the
  task was made, newest first; `subject` is by the person's name (a task on a deal uses the deal's person), without
  regard to case (SQLite's `lower()`, so ASCII case only, as with name matching in decision 0044), standalone tasks
  last, then by due date. Ties go by when made, then id. "Linked" means on a deal or a
  person; "standalone" means on neither.
- **The form for them is a GET form** (`/` with two selects and a Show button), so it works with JavaScript off. A page
  with a non-default view says so in its `<title>` and description ("Today, newest first"), so every route in
  `boardRoutes` keeps a unique one. Done and Snooze return to the view the owner was on.
- **Quick add:** one form at the top, `POST /tasks/quick`, a text input "Add a to-do" and a date input "Due (optional)";
  Enter submits. It calls `addTask` as the owner under tool `add_task` with no deal or contact and answers 303 to the
  page it came from with `?change=`, so the Undo banner shows. A blank title is the usual 422 page (error summary, the
  values kept). A date alone is midnight in the owner's timezone, as in every other board date field.
- **A row says what it is for:** the deal link or the person as before, or "No person or deal" for a standalone task.
  An overdue task (due before today began) keeps its Overdue tag.
- **Deals stay:** deals whose next step is overdue or due today keep their Overdue and Due today sections under the
  task lists, and the pipeline summary and the brief excerpt are untouched. The old "Nothing due today" message is gone;
  an empty list says "Nothing to do." with a one-line hint.
- **Routes:** `/?sort=newest` and `/?show=standalone` are in `boardRoutes`; Today keeps its one Lighthouse slot (the
  variants are the same kind of page). The demo seed has two standalone tasks (`tk_seed14` with a due date,
  `tk_seed15` with none) so the accessibility run and the screenshots draw them.

## Why

- The owner asked for one place to see everything to do, including what has no due date yet, which the old "due today"
  view hid.
- A GET form keeps the sort in the address (bookmarkable, back button works) and needs no script.
- Keeping the deals' sections means nothing the owner relied on disappears.

## Consequences

- Today now lists every open task, not only the ones due today; it reads and draws at most 50 per list.
- Each of the two lists shows at most 50 rows (`TASK_LIST_LIMIT`), cut after the sort and filter so overdue and soonest
  tasks are never the ones left out; a list with more says "Showing 50 of 63 to-dos." beneath it, in the pipeline's
  style. There is no "show all" link: the address takes only the two fixed keys (a later decision may add one).
- The quick add title is drawn like every other required board field (AGENTS.md's board-forms rule wins over the
  brief's bare label): "Add a to-do (required)"; the date is "Due (optional)". The sort form's button is "Show to-dos",
  so it does not share a name with the "Show" select.
- `whats_due` and the brief are unchanged: they still list only what is due.
