// add_task_plan (decision 0057): a project's task plan as one flat list, written as one change. An item's `under` is the
// 1-based number of an earlier item, so a tree needs no ids from the caller; dueDays counts from the project's start.
import type { TaskRow } from "../db/db.ts";
import { newId } from "../ids.ts";
import { addDays, localDate, parseWhen } from "../time.ts";
import { type ChangeResult, commitChange, type Ctx } from "./change.ts";
import { UserError } from "./errors.ts";
import { clean, taskDescription, whenOrNull } from "./input.ts";
import { projectLabel } from "./labels.ts";
import { nextPosition, ownerTimezone } from "./lookup.ts";
import { projectLinks } from "./project-links.ts";
import { requireTimeTracking } from "./settings.ts";
import { findWorkType } from "./work-types.ts";
import { parentLinks } from "./subtasks.ts";
import { listLevels, MAX_TASK_LEVEL, TOO_DEEP } from "./task-depth.ts";

export const TASK_PLAN_MAX = 100;

export interface TaskPlanItem {
  title: string;
  /** Steps and detail, at most 10,000 characters. */
  description?: string;
  /** A date or time, in the owner's timezone. */
  due?: string;
  /** Days after the project's start date, at local midnight. */
  dueDays?: number;
  /** The 1-based number of an earlier item in this list this one goes under. */
  under?: number;
  /** A work type's id or name; needs time tracking on. */
  workType?: string;
}

export interface TaskPlanInput {
  /** A project id or exact name. */
  project: string;
  /** An open task of that project to put the whole plan under. */
  under?: string;
  tasks: TaskPlanItem[];
}

/** "1", "1 or 2", "1 to 3": the numbers an item may name. */
const choices = (before: number) => (before === 1 ? "1" : before === 2 ? "1 or 2" : `1 to ${before}`);

/** Each item's `under` names an earlier item (a forward or self reference, zero or a number out of range is refused). */
export function checkTree(items: readonly { under?: number }[]): void {
  items.forEach((item, i) => {
    const n = i + 1;
    if (item.under === undefined) return;
    if (!Number.isInteger(item.under) || item.under < 1 || item.under >= n) {
      const named = n === 1 ? "" : ` (${choices(n - 1)})`;
      throw new UserError(`Task ${n}'s under must name an earlier task in this plan${named}.`);
    }
  });
}

export async function addTaskPlan(ctx: Ctx, input: TaskPlanInput): Promise<ChangeResult & { taskIds: string[] }> {
  const { tasks } = input;
  if (tasks.length === 0) throw new UserError("A task plan needs at least one task.");
  if (tasks.length > TASK_PLAN_MAX) throw new UserError(`A task plan holds at most ${TASK_PLAN_MAX} tasks; this one has ${tasks.length}. Split it into two lists.`);
  checkTree(tasks);
  const { project, contact } = await projectLinks(ctx, input.project);
  const found = input.under === undefined ? null : await parentLinks(ctx, input.under, { project: project.id });
  const top = found?.parent ?? null;
  if (listLevels(tasks).some((level) => level + (found?.level ?? 0) > MAX_TASK_LEVEL)) throw new UserError(TOO_DEEP);
  const descriptions = tasks.map((item) => taskDescription(item.description));
  const tz = await ownerTimezone(ctx);
  const dueAt = tasks.map((item, i) => {
    const n = i + 1;
    if (item.due !== undefined && item.dueDays !== undefined) throw new UserError(`Task ${n}: give a due date or dueDays, not both.`);
    if (item.dueDays === undefined) return whenOrNull(item.due ?? null, tz);
    if (project.start_at === null) throw new UserError("Give the project a start date, or give due dates.");
    return parseWhen(addDays(localDate(new Date(project.start_at), tz), item.dueDays), tz).toISOString();
  });
  const titles = tasks.map((item, i) => clean(item.title) ?? fail(`Task ${i + 1} needs a title. Say in a few words what to do.`));
  // Each distinct work type is looked up once; any work type needs time tracking on.
  const types = new Map<string, string>();
  const workTypes: (string | null)[] = [];
  for (const item of tasks) {
    if (item.workType === undefined) {
      workTypes.push(null);
      continue;
    }
    await requireTimeTracking(ctx);
    const key = item.workType.trim().toLowerCase();
    const id = types.get(key) ?? (await findWorkType(ctx, item.workType)).id;
    types.set(key, id);
    workTypes.push(id);
  }

  const now = ctx.now.toISOString();
  const ids = tasks.map(() => newId("tk"));
  const group = `plan:${ids[0]}`;
  const next = new Map<string | null, number>();
  const positionUnder = async (parentId: string | null, existing: boolean): Promise<number> => {
    const taken = next.get(parentId) ?? (existing ? await nextPosition(ctx, project.id, parentId) : 1);
    next.set(parentId, taken + 1);
    return taken;
  };
  const rows: TaskRow[] = [];
  for (const [i, item] of tasks.entries()) {
    const parentId = item.under === undefined ? (top?.id ?? null) : (ids[item.under - 1] ?? null);
    rows.push({
      id: ids[i] ?? "",
      deal_id: null,
      contact_id: contact?.id ?? null,
      project_id: project.id,
      parent_id: parentId,
      position: await positionUnder(parentId, item.under === undefined),
      title: titles[i] ?? "",
      description: descriptions[i] ?? null,
      due_at: dueAt[i] ?? null,
      done_at: null,
      snoozed_until: null,
      ...(workTypes[i] === null || workTypes[i] === undefined ? {} : { work_type_id: workTypes[i] }),
      source: "owner",
      untrusted_fields: "[]",
      version: 1,
      created_at: now,
      updated_at: now,
    });
  }
  const count = tasks.length;
  const result = await commitChange(ctx, {
    target: { table: "tasks", id: ids[0] ?? "" },
    summary: `Added ${count} ${count === 1 ? "task" : "tasks"} to project ${projectLabel(project, contact)}`,
    changes: rows.map((row) => ({ table: "tasks" as const, id: row.id, before: null, after: row, group })),
  });
  return { ...result, taskIds: ids };
}

function fail(message: string): never {
  throw new UserError(message);
}
