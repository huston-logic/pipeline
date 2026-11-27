# 0062: Layout and ease of use (run 12): task descriptions and edits, actions in place, the status corner, one task row, new navigation and the brief switch

Run 12, 2026-11-26. Builds on 0014, 0017, 0018 (board writes), 0042 and 0043 (views and tables), 0047 (Today), 0050
(the timer bar), 0055 to 0059 (projects) and 0011 (the brief). Design: `docs/superpowers/specs/2026-11-26-run12-layout-ease-design.md`.

## Context

The owner's run 12 brief asked for a calmer, faster board: task descriptions and edits, actions that happen in place,
a status corner for the timer and the latest change, one task row on every page that lists tasks, new navigation, and
the brief as an optional module. The brief left several calls open. This record makes them.

## Decision

1. In place means the script posts the real form and swaps marked regions of the page the server would show. [Medium:
   a fragment API would touch every page.]
2. The old change banner moves into the status corner. [Small.]
3. The "Time logged" note lasts across pages for 2 minutes unless closed. Close is a cookie, not a database row. [Small.]
4. Task edits are board only. There is no `update_task` MCP tool. [Small: a tool over `updateTask` plus proposal text.]
5. The three-level cap counts from the top. Deeper existing rows stay and still show. [Small.]
6. A due at local midnight is a date with no time. A task really due at midnight shows as a day. [Small: a flag column.]
7. Timer Undo archives the running entry (`cancel_timer`) and asks first after 5 minutes. [Small.]
8. Project facts are a settings column of view column keys. [Medium: moving them to views later needs a migration.]
9. Project rows on Today count top-level tasks that are open or have open sub-tasks. Overdue counts any depth. [Small.]
10. Marketing is under More on phones. [Small: CSS and the More page.]
11. The brief is a module switch (`settings.brief`), apart from `brief_enabled`, which still means "email it". [Small.]
12. Two pages are added to the a11y list. Lighthouse stays at 22 routes. [Small.]

Also decided:

- `save_project_as_template` copies levels 1 to 3 and leaves deeper tasks out, instead of refusing. [Small.]
- Description links say "(opens in a new tab)" in hidden words. [Small.]
- A task import merge fills an empty description from the file, as outside text. [Small.]

## Why

- One renderer and one write path: the script posts the same forms to the same routes, so every check and audit row
  still runs (approach a/b/c in the design; c chosen).
- Native `details` and `summary` for opening rows: the brief's rule, and no script needed to open a row.
- Project facts reuse `view-spec.ts` and its checks through a settings column, so no saved view row shows in the switch.
- Timer Undo as `cancel_timer` works for a timer started anywhere, including by the AI app, and deletes nothing.

## Consequences

- `public/live.js` loads on every signed-in page. AGENTS.md "Browser JavaScript" changes in PR B to say so.
- The status corner adds one D1 read per page (the latest timer change, batched with the running timer read).
- Today and the project page are held to at most 20 D1 calls a render, counted by a unit test.
- The brief is off by default for every copy, existing ones included. An owner turns it on by asking the AI app.
  Stored `briefs` rows stay.

## Rulings made during the build

One line each, cost to change in brackets. Rulings 1 to 12 above are the spec's.

- Work happens in the main checkout on feature branches, not in a worktree. [cost: none noted]
- Project task rows reuse the task edit form function (`taskEditForm`) unchanged. [cost: none noted]
- The close cookie is `pipeline_corner`, exported from the corner module as `CORNER_COOKIE`. [cost: none noted]
- The browser test that writes to the preview data restores it by Undo at the end. [cost: none noted]
- Autosubmit is an in-place GET swap with `replaceState`, not a page load. [cost: one extra code path in `live.js`]
- Tab order in a task row: Done, the row, the open content, then the sub-tasks. [cost: open rows put actions before the sub-task toggle]
- Add a deal, Add a lead and Import sit on a quiet line at the foot of Today. [cost: one more scroll to add a deal from Today]
- At most 200 task rows on Today in all, dated rows first. [cost: very busy owners see fewer undated rows]
- A project's count on Today counts only open, awake tasks (top level, or with an open one below). [cost: none known]
- "Overdue" stays on every overdue row; on a phone, the due date and "belongs to" share line 2 with an ellipsis. [cost: "belongs to" is cut on phone rows]
- A project's status is the head tag only; the facts pairs do not repeat it. [cost: the owner can hide the tag only through the facts chooser]
- "Notes" appears twice on the project page (the facts block and the notes section). [cost: two things named Notes]
- More is `aria-current` on `/campaigns` at every width, and the wide CSS hides its look. [cost: wide-screen readers hear More as current too]
- `renderPage` takes `region: true` only on read-only list and board pages, never on form pages. [cost: other pages need a reload to show a corner Undo's effect]
- The corner's Undo works in place only for task and timer changes. [cost: other Undos reload the page]
- Row actions are in a `<noscript>` for scripts off, and fetched from `/tasks/<id>/actions` with scripts on (Lighthouse and CodeQL). [cost: one small request per row open]
- The timer clock, the note's expiry and the corner's scroll room moved to `public/clock.js`, loaded on every signed-in page. [cost: one more script on every signed-in page]
- Migration 0029 adds an `audit_log (tool, time)` index. [cost: one more migration]
- The Brief and emailing the brief are named apart in change text and settings. [cost: none noted]
- At most two pages added to the a11y list (`/projects/facts`, `/timer/notes`). The `/pending` region and the two `layout=cards` entries were removed. [cost: less axe coverage of card fallbacks]
