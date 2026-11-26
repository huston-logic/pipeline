// Copying a template's live tasks onto a new project (add_project `template`). The template is read through the
// planned-read helpers, so a proposal's apply plans against the template as it is then. Nothing keeps a link back to the
// template (ruling 17): the copy is plain tasks.
import type { ProjectRow, ProjectTemplateRow, TaskRow, TemplateTaskRow } from "../db/db.ts";
import { newId } from "../ids.ts";
import { addDays, localDate, parseWhen } from "../time.ts";
import type { Ctx } from "./change.ts";
import { UserError } from "./errors.ts";
import { templateTasksOf } from "./lookup.ts";
import { findTemplate } from "./templates.ts";

export interface TemplateCopy {
  template: ProjectTemplateRow;
  /** The live tasks in tree order (a parent before its children). */
  tasks: TemplateTaskRow[];
}

/** The live template and its live tasks; refuses an archived or empty one. */
export async function readTemplateCopy(ctx: Ctx, ref: string): Promise<TemplateCopy> {
  const template = await findTemplate(ctx, ref);
  if (template.archived === 1) throw new UserError(`Template "${template.name}" is archived, so a project can't copy it. Restore it first or pick another.`);
  return { template, tasks: await templateTasksOf(ctx, template.id) };
}

/**
 * Project tasks for the template's tasks: titles, nesting, order (siblings number from `first` at the top level, from 1
 * below), work types, and a due date of the project's start plus due_days at local midnight.
 */
export function templateTaskRows(
  ctx: Ctx,
  tasks: readonly TemplateTaskRow[],
  to: { project: ProjectRow; startAt: string | null; tz: string; contactId: string | null; first: number },
): TaskRow[] {
  const now = ctx.now.toISOString();
  const ids = new Map(tasks.map((task) => [task.id, newId("tk")]));
  const startDate = to.startAt === null ? null : localDate(new Date(to.startAt), to.tz);
  const next = new Map<string | null, number>();
  return tasks.map((task) => {
    const parent = task.parent_id === null ? null : (ids.get(task.parent_id) ?? null);
    const position = next.get(parent) ?? (parent === null ? to.first : 1);
    next.set(parent, position + 1);
    const due = task.due_days === null || startDate === null ? null : parseWhen(addDays(startDate, task.due_days), to.tz).toISOString();
    return {
      id: ids.get(task.id) ?? "",
      deal_id: null,
      contact_id: to.contactId,
      project_id: to.project.id,
      parent_id: parent,
      position,
      title: task.title,
      description: task.description ?? null,
      due_at: due,
      done_at: null,
      snoozed_until: null,
      work_type_id: task.work_type_id,
      source: "owner",
      untrusted_fields: "[]",
      version: 1,
      created_at: now,
      updated_at: now,
    };
  });
}
