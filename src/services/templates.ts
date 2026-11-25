// Project templates (migration 0024): a named task tree, with days after the project's start for each task's due date
// and an optional work type, that a new project can copy. Every service here is one audited change and refuses while
// projects are off. Tasks nest like a project's sub-tasks (siblings numbered from 1), and a template holds at most
// TEMPLATE_TASKS_MAX live tasks.
import type { ProjectTemplateRow, TemplateTaskRow } from "../db/db.ts";
import { newId } from "../ids.ts";
import { type ChangeInput, type ChangeResult, commitChange, type Ctx, isTemplateNameFailure, needsBulk, type RowChange, updatedRow } from "./change.ts";
import { rowLabel, short } from "./describe.ts";
import { UserError } from "./errors.ts";
import { clean } from "./input.ts";
import { sourceOf, type Source, templateById, templateTaskById, templateTasksOf, withPlanned } from "./lookup.ts";
import { requireProjects, requireTimeTracking } from "./settings.ts";
import { checkTree } from "./task-plan.ts";
import { findWorkType } from "./work-types.ts";

export const TEMPLATE_TASKS_MAX = 100;
const NAME_MAX = 200;
const DESCRIPTION_MAX = 2000;
const DUE_DAYS_MAX = 3650;

export interface TemplateTaskInput {
  title: string;
  /** Days after the project's start, 0 to 3650. */
  dueDays?: number;
  /** A work type's id or name; needs time tracking on. */
  workType?: string;
  /** The 1-based number of an earlier task in this list this one goes under. */
  under?: number;
}

const ONE_LINE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function checkText(input: string, what: string): string {
  const text = clean(input);
  if (text === null || ONE_LINE.test(text) || [...text].length > NAME_MAX) {
    throw new UserError(`A ${what} must be one line of plain text, 1 to ${NAME_MAX} characters.`);
  }
  return text;
}

function checkDueDays(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > DUE_DAYS_MAX) {
    throw new UserError(`dueDays must be a whole number of days from 0 to ${DUE_DAYS_MAX}.`);
  }
  return value;
}

/** A live work type's id; refused while time tracking is off. */
async function workTypeId(ctx: Ctx, ref: string): Promise<string> {
  await requireTimeTracking(ctx);
  return (await findWorkType(ctx, ref)).id;
}

const taskText = (task: TemplateTaskRow) => `"${short(task.title, 60)}"`;
const templateText = (template: ProjectTemplateRow) => rowLabel("project_templates", template);

/** Refuses a name another live template has (ignoring case); `except` is the one being renamed or restored. */
async function checkNameFree(src: Source, name: string, except?: string): Promise<void> {
  const { db } = sourceOf(src);
  const found = await db
    .prepare("SELECT * FROM project_templates WHERE archived = 0 AND lower(name) = lower(?)")
    .bind(name)
    .all<ProjectTemplateRow>();
  const wanted = name.toLowerCase();
  const live = withPlanned(src, "project_templates", found.results, (row) => row.archived === 0 && String(row.name).toLowerCase() === wanted);
  if (live.some((row) => row.id !== except)) {
    throw new UserError(`There's already a template called "${short(name, 60)}". Use another name.`);
  }
}

/** A template by id, or by exact name among the live ones (ignoring case). */
export async function findTemplate(src: Source, ref: string): Promise<ProjectTemplateRow> {
  await requireProjects(src);
  const text = ref.trim();
  if (text === "") throw new UserError("Say which template: give its id or its exact name.");
  const byId = await templateById(src, text);
  if (byId) return byId;
  const { db } = sourceOf(src);
  const found = await db
    .prepare("SELECT * FROM project_templates WHERE archived = 0 AND lower(name) = lower(?)")
    .bind(text)
    .all<ProjectTemplateRow>();
  const wanted = text.toLowerCase();
  const [only] = withPlanned(src, "project_templates", found.results, (row) => row.archived === 0 && String(row.name).toLowerCase() === wanted);
  if (!only) throw new UserError(`No template matches "${short(text, 60)}". Use list_templates to find the template's id.`);
  return only;
}

async function findLiveTemplate(src: Source, ref: string): Promise<ProjectTemplateRow> {
  const template = await findTemplate(src, ref);
  if (template.archived === 1) throw new UserError(`${templateText(template)} is archived. Restore it first (archived false).`);
  return template;
}

async function liveTask(src: Source, id: string): Promise<{ task: TemplateTaskRow; template: ProjectTemplateRow }> {
  await requireProjects(src);
  const text = id.trim();
  const task = text === "" ? null : await templateTaskById(src, text);
  if (!task || task.archived === 1) throw new UserError(`No template task "${short(text, 40)}". Use get_template to find the task's id.`);
  const template = await templateById(src, task.template_id);
  if (!template) throw new Error(`Template task ${task.id} points at a missing template.`);
  return { task, template };
}

/**
 * commitChange, as a bulk change when it is big (100 tasks of long titles would near D1's statement limit), and a lost
 * race on the live name is explained as the name check explains it.
 */
async function commitTemplate(ctx: Ctx, input: ChangeInput, name?: string, except?: string): Promise<ChangeResult> {
  try {
    return await commitChange(ctx, { ...input, bulk: needsBulk(input.changes) });
  } catch (error) {
    if (name !== undefined && isTemplateNameFailure(error)) await checkNameFree(ctx, name, except);
    throw error;
  }
}

const stamps = (ctx: Ctx) => ({ version: 1, created_at: ctx.now.toISOString(), updated_at: ctx.now.toISOString() });

export async function addTemplate(
  ctx: Ctx,
  input: { name: string; description?: string | null; tasks?: TemplateTaskInput[] },
): Promise<ChangeResult & { templateId: string; taskIds: string[] }> {
  await requireProjects(ctx);
  const name = checkText(input.name, "template name");
  const description = checkDescription(input.description ?? null);
  const items = input.tasks ?? [];
  if (items.length > TEMPLATE_TASKS_MAX) throw tooMany(items.length);
  checkTree(items);
  await checkNameFree(ctx, name);
  const resolved: { title: string; dueDays: number | null; workType: string | null }[] = [];
  // Each distinct work type reference is looked up once.
  const known = new Map<string, string>();
  for (const [i, item] of items.entries()) {
    let workType: string | null = null;
    if (item.workType !== undefined) {
      const key = item.workType.trim().toLowerCase();
      workType = known.get(key) ?? (await workTypeId(ctx, item.workType));
      known.set(key, workType);
    }
    resolved.push({
      title: clean(item.title) === null ? fail(`Task ${i + 1} needs a title. Say in a few words what to do.`) : checkText(item.title, "task title"),
      dueDays: item.dueDays === undefined ? null : checkDueDays(item.dueDays),
      workType,
    });
  }
  const template: ProjectTemplateRow = { id: newId("tp"), name, description, archived: 0, untrusted_fields: "[]", ...stamps(ctx) };
  const ids = items.map(() => newId("tt"));
  const next = new Map<string | null, number>();
  const rows: TemplateTaskRow[] = items.map((item, i) => {
    const parent = item.under === undefined ? null : (ids[item.under - 1] ?? null);
    const position = (next.get(parent) ?? 0) + 1;
    next.set(parent, position);
    const r = resolved[i];
    return {
      id: ids[i] ?? "",
      template_id: template.id,
      parent_id: parent,
      position,
      title: r?.title ?? "",
      due_days: r?.dueDays ?? null,
      work_type_id: r?.workType ?? null,
      archived: 0,
      ...stamps(ctx),
    };
  });
  const group = `template:${template.id}`;
  const count = rows.length;
  const result = await commitTemplate(ctx, {
    target: { table: "project_templates", id: template.id },
    summary: `Added ${templateText(template)}${count === 0 ? "" : ` with ${count} ${count === 1 ? "task" : "tasks"}`}`,
    changes: [
      { table: "project_templates", id: template.id, before: null, after: template, group },
      ...rows.map((row) => ({ table: "template_tasks" as const, id: row.id, before: null, after: row, group })),
    ],
  }, name);
  return { ...result, templateId: template.id, taskIds: ids };
}

function checkDescription(value: string | null): string | null {
  const text = clean(value);
  if (text !== null && [...text].length > DESCRIPTION_MAX) throw new UserError(`A template description is at most ${DESCRIPTION_MAX} characters.`);
  return text;
}

const tooMany = (n: number) =>
  new UserError(`A template holds at most ${TEMPLATE_TASKS_MAX} tasks${n > TEMPLATE_TASKS_MAX ? `; this one would have ${n}` : ""}. Archive some first, or split it in two.`);

function fail(message: string): never {
  throw new UserError(message);
}

export async function updateTemplate(
  ctx: Ctx,
  ref: string,
  patch: { name?: string; description?: string | null; archived?: boolean },
): Promise<ChangeResult & { templateId: string }> {
  const before = await findTemplate(ctx, ref);
  const set: Partial<ProjectTemplateRow> = {};
  const parts: string[] = [];
  const restoring = patch.archived === false && before.archived === 1;
  if (patch.name !== undefined) {
    const name = checkText(patch.name, "template name");
    if (name !== before.name) {
      set.name = name;
      parts.push(`renamed from "${short(before.name, 60)}"`);
    }
  }
  if (patch.description !== undefined) {
    const description = checkDescription(patch.description);
    if (description !== before.description) {
      set.description = description;
      parts.push(description === null ? "description cleared" : "description changed");
    }
  }
  if (patch.archived !== undefined && (patch.archived ? 1 : 0) !== before.archived) {
    set.archived = patch.archived ? 1 : 0;
    parts.push(patch.archived ? "archived" : "restored");
  } else if (before.archived === 1 && parts.length > 0) {
    throw new UserError(`${templateText(before)} is archived. Restore it first (archived false).`);
  }
  if (parts.length === 0) throw new UserError(`Nothing to change on ${templateText(before)}: every value you gave is already set.`);
  if (set.name !== undefined || restoring) await checkNameFree(ctx, set.name ?? before.name, before.id);
  const after = updatedRow(before, set, ctx.now);
  const result = await commitTemplate(ctx, {
    target: { table: "project_templates", id: before.id },
    summary: `Updated ${templateText(after)}: ${parts.join(", ")}`,
    changes: [{ table: "project_templates", id: before.id, before, after }],
  }, after.name, before.id);
  return { ...result, templateId: before.id };
}

const lastPosition = (tasks: TemplateTaskRow[], parent: string | null) =>
  tasks.filter((t) => t.parent_id === parent).reduce((most, t) => Math.max(most, t.position), 0);

export async function addTemplateTask(
  ctx: Ctx,
  templateRef: string,
  input: { title: string; dueDays?: number; workType?: string; parent?: string },
): Promise<ChangeResult & { taskId: string }> {
  const template = await findLiveTemplate(ctx, templateRef);
  const title = checkText(input.title, "task title");
  const dueDays = input.dueDays === undefined ? null : checkDueDays(input.dueDays);
  const work = input.workType === undefined ? null : await workTypeId(ctx, input.workType);
  const tasks = await templateTasksOf(ctx, template.id);
  if (tasks.length >= TEMPLATE_TASKS_MAX) throw tooMany(tasks.length + 1);
  const parentId = input.parent === undefined ? null : input.parent.trim();
  if (parentId !== null && !tasks.some((t) => t.id === parentId)) {
    throw new UserError(`No task "${short(parentId, 40)}" in ${templateText(template)} to put this under. Use get_template to find the parent's id.`);
  }
  const row: TemplateTaskRow = {
    id: newId("tt"),
    template_id: template.id,
    parent_id: parentId,
    position: lastPosition(tasks, parentId) + 1,
    title,
    due_days: dueDays,
    work_type_id: work,
    archived: 0,
    ...stamps(ctx),
  };
  const result = await commitTemplate(ctx, {
    target: { table: "template_tasks", id: row.id },
    summary: `Added ${taskText(row)} to ${templateText(template)}`,
    changes: [{ table: "template_tasks", id: row.id, before: null, after: row }],
  });
  return { ...result, taskId: row.id };
}

export async function updateTemplateTask(
  ctx: Ctx,
  id: string,
  patch: { title?: string; dueDays?: number | null; workType?: string | null },
): Promise<ChangeResult & { taskId: string }> {
  const { task: before, template } = await liveTask(ctx, id);
  const set: Partial<TemplateTaskRow> = {};
  const parts: string[] = [];
  if (patch.title !== undefined) {
    const title = checkText(patch.title, "task title");
    if (title !== before.title) {
      set.title = title;
      parts.push(`renamed from ${taskText(before)}`);
    }
  }
  if (patch.dueDays !== undefined) {
    const dueDays = patch.dueDays === null ? null : checkDueDays(patch.dueDays);
    if (dueDays !== before.due_days) {
      set.due_days = dueDays;
      parts.push(dueDays === null ? "no due date" : `due ${dueDays} ${dueDays === 1 ? "day" : "days"} after the start`);
    }
  }
  if (patch.workType !== undefined) {
    const work = patch.workType === null ? null : await workTypeId(ctx, patch.workType);
    if (work !== before.work_type_id) {
      set.work_type_id = work;
      parts.push(work === null ? "work type cleared" : "work type changed");
    }
  }
  if (parts.length === 0) throw new UserError(`Nothing to change on ${taskText(before)}: every value you gave is already set.`);
  const after = updatedRow(before, set, ctx.now);
  const result = await commitTemplate(ctx, {
    target: { table: "template_tasks", id: before.id },
    summary: `Updated ${taskText(after)} in ${templateText(template)}: ${parts.join(", ")}`,
    changes: [{ table: "template_tasks", id: before.id, before, after }],
  });
  return { ...result, taskId: before.id };
}

export type TemplateMove = "up" | "down" | "in" | "out";

export async function moveTemplateTask(ctx: Ctx, id: string, direction: TemplateMove): Promise<ChangeResult & { taskId: string }> {
  const { task, template } = await liveTask(ctx, id);
  const tasks = await templateTasksOf(ctx, template.id);
  const siblings = tasks.filter((t) => t.parent_id === task.parent_id);
  const at = siblings.findIndex((t) => t.id === task.id);
  const edit = (before: TemplateTaskRow, patch: Partial<TemplateTaskRow>): RowChange => ({
    table: "template_tasks",
    id: before.id,
    before,
    after: updatedRow(before, patch, ctx.now),
  });
  const changes: RowChange[] = [];
  let summary: string;
  if (direction === "up" || direction === "down") {
    const next = siblings[direction === "up" ? at - 1 : at + 1];
    if (next === undefined) throw new UserError(`${taskText(task)} is already ${direction === "up" ? "first" : "last"} here. Nothing to move.`);
    changes.push(edit(task, { position: next.position }), edit(next, { position: task.position }));
    summary = `Moved ${taskText(task)} ${direction}`;
  } else if (direction === "in") {
    const above = siblings[at - 1];
    if (above === undefined) throw new UserError(`${taskText(task)} has no task above it to go under. Nothing to move.`);
    changes.push(edit(task, { parent_id: above.id, position: lastPosition(tasks, above.id) + 1 }));
    summary = `Moved ${taskText(task)} under ${taskText(above)}`;
  } else {
    const parent = task.parent_id === null ? undefined : tasks.find((t) => t.id === task.parent_id);
    if (parent === undefined) throw new UserError(`${taskText(task)} is already at the top level. Nothing to move.`);
    // Next sibling after its parent: the parent's later siblings each move down one place.
    for (const later of tasks.filter((t) => t.parent_id === parent.parent_id && t.position > parent.position)) {
      changes.push(edit(later, { position: later.position + 1 }));
    }
    changes.unshift(edit(task, { parent_id: parent.parent_id, position: parent.position + 1 }));
    summary = `Moved ${taskText(task)} out from under ${taskText(parent)}`;
  }
  const result = await commitTemplate(ctx, { target: { table: "template_tasks", id: task.id }, summary, changes });
  return { ...result, taskId: task.id };
}

/** Archives the task and everything under it, in one change. */
export async function archiveTemplateTask(ctx: Ctx, id: string): Promise<ChangeResult & { taskId: string; archivedIds: string[] }> {
  const { task, template } = await liveTask(ctx, id);
  const tasks = await templateTasksOf(ctx, template.id);
  const doomed = new Set<string>([task.id]);
  // The list is in tree order, so a task's parent comes before it.
  for (const t of tasks) if (t.parent_id !== null && doomed.has(t.parent_id)) doomed.add(t.id);
  const rows = tasks.filter((t) => doomed.has(t.id));
  const extra = rows.length - 1;
  const result = await commitTemplate(ctx, {
    target: { table: "template_tasks", id: task.id },
    summary: `Archived ${taskText(task)}${extra > 0 ? ` and ${extra} ${extra === 1 ? "task" : "tasks"} under it` : ""} from ${templateText(template)}`,
    changes: rows.map((row) => ({ table: "template_tasks" as const, id: row.id, before: row, after: updatedRow(row, { archived: 1 }, ctx.now) })),
  });
  return { ...result, taskId: task.id, archivedIds: rows.map((row) => row.id) };
}

/** A copy of a template and its live tasks, named `name` or "<name> (copy)" (made unique). */
export async function duplicateTemplate(
  ctx: Ctx,
  ref: string,
  name?: string,
): Promise<ChangeResult & { templateId: string; taskIds: string[] }> {
  const source = await findLiveTemplate(ctx, ref);
  const tasks = await templateTasksOf(ctx, source.id);
  const copyName = name === undefined ? await freeCopyName(ctx, source.name) : checkText(name, "template name");
  await checkNameFree(ctx, copyName);
  const template: ProjectTemplateRow = { ...source, id: newId("tp"), name: copyName, archived: 0, ...stamps(ctx) };
  const ids = new Map(tasks.map((t) => [t.id, newId("tt")]));
  const rows: TemplateTaskRow[] = tasks.map((t) => ({
    ...t,
    id: ids.get(t.id) ?? "",
    template_id: template.id,
    parent_id: t.parent_id === null ? null : (ids.get(t.parent_id) ?? null),
    ...stamps(ctx),
  }));
  const group = `template:${template.id}`;
  const result = await commitTemplate(ctx, {
    target: { table: "project_templates", id: template.id },
    summary: `Copied ${templateText(source)} as ${templateText(template)} with ${rows.length} ${rows.length === 1 ? "task" : "tasks"}`,
    changes: [
      { table: "project_templates", id: template.id, before: null, after: template, group },
      ...rows.map((row) => ({ table: "template_tasks" as const, id: row.id, before: null, after: row, group })),
    ],
  }, copyName);
  return { ...result, templateId: template.id, taskIds: rows.map((row) => row.id) };
}

async function freeCopyName(src: Source, base: string): Promise<string> {
  const trimmed = [...base].slice(0, NAME_MAX - 12).join("");
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? `${trimmed} (copy)` : `${trimmed} (copy ${n})`;
    try {
      await checkNameFree(src, candidate);
      return candidate;
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
    }
  }
  throw new UserError("Give the copy a name of its own: every default name is taken.");
}
