# 0047: Today works like a list

Run 6, task B4, 2026-11-24. Builds on 0046 (standalone tasks), 0018 (board forms) and 0043 (table layout).

## Context

With tasks able to belong to no one (0046), Today becomes the owner's daily to-do list, not only a place that shows
what is due. The brief fixed the labels, the query keys and the route; it left open how the two lists are drawn, what
"overdue" means for the sort, and how the refused form and the empty state read.

## Decision

- **Two lists** from one read (`openTasks` in `src/services/read.ts`: every open task that is not snoozed past now,
  dated or not): **To do** (has a due date) and **Needs a due date** (none). A snoozed task shows again once its time
  has passed. The sort and filter are pure code in `src/board/task-list.ts`.
- **Address:** `sort=due|newest|subject` and `show=all|linked|standalone`, nothing else, never record text. An unknown
  value is the default (`due`, `all`). `due` is soonest first, so overdue tasks come first; `newest` is by when the
  task was made, newest first; `subject` is by the person's name (a task on a deal uses the deal's person), without
  regard to case, standalone tasks last, then by due date. Ties go by when made, then id. "Linked" means on a deal or a
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

- Today now lists every open task, not only the ones due today, so it grows with the list; the page is still one query
  for tasks. A very long list is not paged.
- The quick add label has no "(required)" in words, as the brief gave the label exactly; a blank title is caught by the
  server with a plain message.
- `whats_due` and the brief are unchanged: they still list only what is due.
