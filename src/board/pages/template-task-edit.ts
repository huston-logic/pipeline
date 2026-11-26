// /templates/<tp id>/tasks/<tt id>/edit (run 10, area 4): a template task's title, days after the start and work type.
// Only the fields the owner changes are saved (decision 0018). 404 while projects are off, for a task that is not in
// that template or is removed, and for an archived template.
import { isTemplateId, isTemplateTaskId } from "../../ids.ts";
import { templateById, templateTaskById } from "../../services/lookup.ts";
import type { TemplateTaskRow } from "../../db/db.ts";
import type { PageContext } from "../context.ts";
import { editShown } from "../record-form.ts";
import { TASK_PREFIX, templateHref, templateTaskPost, templateTaskSpecs } from "../template-form.ts";
import { type FormState, recordFormPage } from "./record-page.ts";
import { workTypesFor } from "./template.ts";

/** A live task of a live template, by the two ids of its address, or null. */
export async function liveTemplateTask(db: PageContext["db"], templateId: string, taskId: string): Promise<TemplateTaskRow | null> {
  if (!isTemplateId(templateId) || !isTemplateTaskId(taskId)) return null;
  const task = await templateTaskById(db, taskId);
  const template = await templateById(db, templateId);
  if (task === null || template === null || task.template_id !== templateId || task.archived === 1 || template.archived === 1) return null;
  return task;
}

export async function templateTaskEditPage(ctx: PageContext, templateId: string, taskId: string, state?: FormState): Promise<string | null> {
  if (ctx.projects !== true) return null;
  const task = await liveTemplateTask(ctx.db, templateId, taskId);
  if (task === null) return null;
  const specs = templateTaskSpecs(await workTypesFor(ctx.db, ctx.timeTracking === true));
  const shown = state?.shown ?? (await editShown(specs, { ...task, fields: "{}", untrusted_fields: "[]" }, "UTC"));
  const back = templateHref(templateId);
  return recordFormPage(ctx, {
    title: "Edit template task",
    description: "Change a template task's title, description, days after the start or work type.",
    heading: "Edit template task",
    lede: "Change what you need and save.",
    current: "/templates",
    back: { href: back, text: "Back to the template" },
    action: templateTaskPost(task.id),
    cancel: back,
    submit: "Save changes",
    prefix: TASK_PREFIX,
    groups: [{ specs }],
    shown,
    errors: state?.errors ?? [],
  });
}
