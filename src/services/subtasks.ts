// Sub-tasks (migration 0022, decision 0057): a project's task may sit under another task of the same project, at any
// depth, and siblings keep an order (`position`, from 1). Only project tasks nest (ruling 11); reordering is the
// board's Move up/down (ruling 14), with no MCP tool.
import type { TaskRow } from "../db/db.ts";
import { type ChangeResult, commitChange, type Ctx, type Row, updatedRow } from "./change.ts";
import { rowLabel } from "./describe.ts";
import { UserError } from "./errors.ts";
import { siblingTasks, sourceOf, type Source, taskById, withPlanned } from "./lookup.ts";
import { checkGiven, type ProjectLinks, projectLinks } from "./project-links.ts";
import { findProject } from "./projects.ts";
import { requireProjects } from "./settings.ts";
import { MAX_TASK_LEVEL, taskLevel, TOO_DEEP } from "./task-depth.ts";

export { nextPosition } from "./lookup.ts";
export { listLevels, MAX_TASK_LEVEL, TOO_DEEP, taskLevel } from "./task-depth.ts";

const taskName = (task: TaskRow) => rowLabel("tasks", task as Row);

/**
 * The parent a new sub-task goes under, with the project's links: an open task on a live project. A project, deal or
 * person given beside it must agree (the sub-task takes the parent's project and its person, and has no deal).
 */
export async function parentLinks(
  src: Source,
  parentId: string,
  given: { project?: string | undefined; dealId?: string | undefined; contactId?: string | undefined },
): Promise<{ parent: TaskRow; links: ProjectLinks; level: number }> {
  await requireProjects(src);
  const id = parentId.trim();
  const parent = id === "" ? null : await taskById(src, id);
  if (!parent) throw new UserError(`No task "${id}" to put this under. Use list_tasks or get_project to find the parent task's id.`);
  if (parent.project_id == null) {
    throw new UserError("Sub-tasks go under a project's task. Give a task that is on a project.");
  }
  if (parent.done_at !== null) {
    throw new UserError(`${taskName(parent)} is already done, so nothing can go under it. Give an open task, or add this as a top-level task of the project.`);
  }
  const links = await projectLinks(src, parent.project_id);
  if (given.project !== undefined && (await findProject(src, given.project)).id !== parent.project_id) {
    throw new UserError("A sub-task is on its parent's project. Leave out the project, or give the parent's own.");
  }
  await checkGiven(src, links, given);
  const level = await taskLevel(src, parent.id);
  if (level >= MAX_TASK_LEVEL) throw new UserError(TOO_DEEP);
  return { parent, links, level };
}

/** Every task under this one, at every level, in tree order (siblings by position). Empty for a task not on a project. */
export async function descendants(src: Source, taskId: string): Promise<TaskRow[]> {
  const root = await taskById(src, taskId);
  if (!root || root.project_id == null) return [];
  const projectId = root.project_id;
  const found = await sourceOf(src).db.prepare("SELECT * FROM tasks WHERE project_id = ?").bind(projectId).all<TaskRow>();
  const all = withPlanned(src, "tasks", found.results, (row) => row.project_id === projectId);
  const children = new Map<string, TaskRow[]>();
  for (const task of all) {
    if (task.parent_id == null) continue;
    children.set(task.parent_id, [...(children.get(task.parent_id) ?? []), task]);
  }
  const out: TaskRow[] = [];
  // Bad data (a parent that points at its own descendant) must end the walk: a task already seen is skipped.
  const seen = new Set<string>([taskId]);
  const walk = (id: string) => {
    const kids = (children.get(id) ?? []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id));
    for (const kid of kids) {
      if (seen.has(kid.id)) continue;
      seen.add(kid.id);
      out.push(kid);
      walk(kid.id);
    }
  };
  walk(taskId);
  return out;
}

/** Swaps a project task's position with the neighbouring sibling, in one change. */
export async function moveTask(ctx: Ctx, id: string, direction: "up" | "down"): Promise<ChangeResult & { taskId: string }> {
  await requireProjects(ctx);
  const task = await taskById(ctx, id.trim());
  if (!task) throw new UserError(`No task "${id.trim()}". Use get_project to find the task's id.`);
  if (task.project_id == null) throw new UserError("Only a task on a project can be moved up or down. This task is not on a project.");
  // The page lists only open top-level tasks (done ones are in Done), so there a move skips done siblings.
  const siblings = (await siblingTasks(ctx, task.project_id, task.parent_id ?? null)).filter(
    (sibling) => task.parent_id != null || sibling.done_at === null || sibling.id === task.id,
  );
  const at = siblings.findIndex((sibling) => sibling.id === task.id);
  const next = siblings[direction === "up" ? at - 1 : at + 1];
  if (at < 0 || next === undefined) {
    throw new UserError(`${taskName(task)} is already ${direction === "up" ? "first" : "last"} here. Nothing to move.`);
  }
  const mine = task.position ?? at + 1;
  const theirs = next.position ?? (direction === "up" ? at : at + 2);
  const result = await commitChange(ctx, {
    target: { table: "tasks", id: task.id },
    summary: `Moved ${taskName(task)} ${direction}`,
    changes: [
      { table: "tasks", id: task.id, before: task, after: updatedRow(task, { position: theirs }, ctx.now) },
      { table: "tasks", id: next.id, before: next, after: updatedRow(next, { position: mine }, ctx.now) },
    ],
  });
  return { ...result, taskId: task.id };
}
