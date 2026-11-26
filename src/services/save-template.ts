// save_project_as_template: a new template from a project's tasks, open and done, with nesting and order kept. A task's
// due date becomes days after the project's start (when both dates exist and the gap is 0 to 3650), else no due date.
import type { ProjectRow, TaskRow } from "../db/db.ts";
import { localDate } from "../time.ts";
import type { ChangeResult, Ctx } from "./change.ts";
import { ownerTimezone, projectTasksOf } from "./lookup.ts";
import { findProject } from "./projects.ts";
import { settingsRow } from "./memo.ts";
import { addTemplate, TEMPLATE_TASKS_MAX, type TemplateTaskInput } from "./templates.ts";
import { UserError } from "./errors.ts";
import { isTrusted } from "./labels.ts";
import { MAX_TASK_LEVEL } from "./task-depth.ts";

const DAY_MS = 86_400_000;

/** Whole local days from the project's start date to the task's due date, or null when it isn't 0 to 3650. */
function daysAfterStart(project: ProjectRow, task: TaskRow, tz: string): number | null {
  if (project.start_at === null || task.due_at === null) return null;
  const from = Date.parse(`${localDate(new Date(project.start_at), tz)}T00:00:00Z`);
  const to = Date.parse(`${localDate(new Date(task.due_at), tz)}T00:00:00Z`);
  const days = Math.round((to - from) / DAY_MS);
  return days >= 0 && days <= 3650 ? days : null;
}

const oneLine = (text: string) => ([...text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim()].slice(0, 200).join("") || "Task");

export async function saveProjectAsTemplate(
  ctx: Ctx,
  input: { project: string; name: string; description?: string },
): Promise<ChangeResult & { templateId: string; taskIds: string[] }> {
  const project = await findProject(ctx, input.project);
  const all = await projectTasksOf(ctx, project.id);
  if (all.length === 0) throw new UserError("That project has no tasks to save. Add its tasks first.");
  // A title from outside never reaches a template: the task and everything under it is left out.
  const out = new Set<string>();
  for (const task of all) {
    if (!isTrusted(task, "title") || (task.parent_id !== null && task.parent_id !== undefined && out.has(task.parent_id))) out.add(task.id);
  }
  // A template holds three levels: deeper tasks of an older project are not copied (they are not "left out" for their titles).
  const level = new Map<string, number>();
  const tooDeep = new Set<string>();
  for (const task of all) {
    const parentLevel = task.parent_id == null ? 0 : (level.get(task.parent_id) ?? MAX_TASK_LEVEL);
    level.set(task.id, parentLevel + 1);
    if (parentLevel + 1 > MAX_TASK_LEVEL) tooDeep.add(task.id);
  }
  const tasks = all.filter((task) => !out.has(task.id) && !tooDeep.has(task.id));
  if (tasks.length === 0) throw new UserError("Every task on this project has a title from outside, so there is nothing to save. Describe the template instead.");
  if (tasks.length > TEMPLATE_TASKS_MAX) {
    throw new UserError(`A template holds at most ${TEMPLATE_TASKS_MAX} tasks; this project has ${tasks.length}. Archive some first.`);
  }
  const tz = await ownerTimezone(ctx);
  const keepTypes = (await settingsRow(ctx)).time_tracking === 1;
  const number = new Map(tasks.map((task, i) => [task.id, i + 1]));
  const items: TemplateTaskInput[] = tasks.map((task) => {
    const dueDays = daysAfterStart(project, task, tz);
    const under = task.parent_id === null || task.parent_id === undefined ? undefined : number.get(task.parent_id);
    return {
      title: oneLine(task.title),
      ...(task.description == null || !isTrusted(task, "description") ? {} : { description: task.description }),
      ...(dueDays === null ? {} : { dueDays }),
      ...(keepTypes && task.work_type_id ? { workType: task.work_type_id } : {}),
      ...(under === undefined ? {} : { under }),
    };
  });
  return addTemplate(ctx, {
    name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
    tasks: items,
    leftOut: out.size,
  });
}
