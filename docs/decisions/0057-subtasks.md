# 0057: Sub-tasks on projects

Run 10, 2026-11-25. Builds on 0055 (projects) and 0056 (projects, shaped). Migration 0022. The design is in
`docs/superpowers/specs/2026-11-25-projects-finished-design.md`, "Area 2".

## Context

Project work is rarely flat: "Kitchen" breaks into cabinets, plumbing and paint, and each of those into steps. Run 9 and
run 10's first PR gave projects flat task lists. Owners need nested tasks with order and progress, and the AI app needs
to read the shape.

## Decision

Data (migration 0022)
- `tasks.parent_id` (a task, indexed) and `tasks.position` (order among siblings: same project, same parent). The
  migration numbers every existing project task 1 to n by `created_at, id` within its project, all top level. Tasks not
  on a project keep both null.

Writing
- `add_task` takes `parent`, a task id: the parent must be an open task on a live project. The sub-task gets the
  parent's project and person and no deal; a `project` given must match. Any depth is stored. A new task goes last among
  its siblings. Positions are read as a planned read, so a proposal sees the rows an earlier action planned. A task
  moved onto a project (`moveOpenTasks`) is appended at top level.
- Undo of a change that added a parent is refused while a child points at it.
- `moveTask` (`src/services/subtasks.ts`) swaps a task with its neighbour, one change, tool `move_task`. It is on the
  board only: there is no MCP tool and no re-parenting. At top level it skips hidden done siblings.
- `complete_task` takes `subTasks`: `complete` or `leave`. A task with open sub-tasks and no `subTasks` is refused with a
  question that gives the count and both answers. `complete` finishes every open descendant in the same change. It is
  never a small change when it says `complete`, so under Apply small changes it is still proposed.

Reads
- Task items (`list_tasks`, `get_project`, the services' `TaskItem`) carry `parentId`, `parentTitle` (null when the
  title came from outside), `depth`, `position` and `subTasks: {open, done}`.
- Today shows a sub-task with an "Under" and a "Project" pair; the brief shows one comma line ("title, under parent,
  project"). An outside parent title becomes "a task".
- The project page shows the tasks as nested lists to three levels, "N of M done" on each parent (direct sub-tasks),
  and "Has N more level(s) below. Your AI app can show them." on a third-level task with more beneath. At most 500 tasks
  of a project are read for the tree; beyond that the page says "Showing the first 500 tasks."

Rulings (from the design)
11. Sub-tasks only on project tasks. Cost: personal to-dos stay flat.
12. "N of M" counts direct sub-tasks. Cost: deeper progress shows on each sub-task.
13. The board shows three levels and says how many more exist. Cost: deeper edits need the AI app.
14. Reorder and re-parent of project tasks: board Move up and Move down only; no MCP reorder, no re-parent. Cost: the
    owner reorders on the board; moving a task to another parent means adding it again.

Calls made while building
- `parent` takes a task id only, not `@n`: task plans (decision 0058) add a whole tree in one proposal. Cost: separate
  `add_task` actions in one proposal cannot nest under a task that proposal adds.
- A sub-task added between the read and the write of a parent's completion stays open under the completed parent. Cost:
  a rare open child of a done task; the owner completes it.
- A cycle in bad data ends the walk instead of looping.

## Why

- A sub-task being an ordinary task means Today, the brief, timers, undo and exports keep working unchanged.
- Three levels fit a phone screen; the AI app has no such limit and can read the rest.
- Asking before completing a parent stops a silent half-finished tree.

## Consequences

- Every task reader that lists a project's tasks must handle a parent and a position.
- A change that adds a parent cannot be undone while its children exist; undo the children first.
- A crafted POST can still move a done top-level task, and past the 500-task cut a move may swap with a neighbour the
  page did not draw. Both stay inside one project.
