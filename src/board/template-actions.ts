// The template pages' posts (run 10, area 4): New template, Save a template, Add a task, a task's Edit, Move and Remove,
// Duplicate, and Archive or Bring back. Each calls the service the matching MCP tool would call, as the owner under that
// tool's name. While projects are off, or for an id that is no template or task, every path here is a 404.
import { getSettings } from "../db/queries.ts";
import { isTemplateTaskId } from "../ids.ts";
import { templateTaskById } from "../services/lookup.ts";
import { addTemplate, addTemplateTask, archiveTemplateTask, duplicateTemplate, moveTemplateTask, type TemplateMove, updateTemplate, updateTemplateTask } from "../services/templates.ts";
import { type ActionContext, type ActionResult, asOwner, backTo, notFound, page, pageContext, redirect, refusal, refusedFormPage, refusedPage, type Route, stateOf } from "./action-kit.ts";
import type { PageContext } from "./context.ts";
import { collectEdit, collectNew } from "./record-form.ts";
import { withChange } from "./return-to.ts";
import { templateHref, templateSpecs, templateTaskSpecs } from "./template-form.ts";
import { liveTemplateTask, templateTaskEditPage } from "./pages/template-task-edit.ts";
import { addTaskForm, templateOrNull, templatePage, workTypesFor } from "./pages/template.ts";
import { templateNewPage, TEMPLATES_NEW_PATH } from "./pages/templates.ts";

const NOTHING_TO_SAVE = "Nothing to save: every field is as it was. Change a value, or cancel to go back.";
const MOVES = new Set<string>(["up", "down", "in", "out"]);

/** The page context a refused form draws with: projects are on (the paths 404 otherwise) and time tracking as set. */
async function formContext(ctx: ActionContext, here: string): Promise<PageContext> {
  return { ...pageContext(ctx, here), projects: true, timeTracking: (await getSettings(ctx.db)).time_tracking === 1 };
}

const projectsOn = async (ctx: ActionContext): Promise<boolean> => (await getSettings(ctx.db)).projects === 1;

/** POST /templates: add_template. Then the new template's page. */
async function addNew(ctx: ActionContext): Promise<ActionResult> {
  if (!(await projectsOn(ctx))) return notFound(ctx);
  const collected = collectNew(templateSpecs(), ctx.form);
  const refused = async (extra: string[] = []) => page(422, (await templateNewPage(await formContext(ctx, TEMPLATES_NEW_PATH), stateOf(collected, extra))) ?? "");
  if (collected.errors.length > 0) return refused();
  try {
    const input = collected.input as { name: string; description?: string };
    const result = await addTemplate(asOwner(ctx, "add_template"), input);
    return redirect(withChange(templateHref(result.templateId), result.changeId));
  } catch (error) {
    return refused([refusal(error, "template")]);
  }
}

/** POST /templates/<id>: update_template with only the fields the owner changed. */
async function save(ctx: ActionContext, id: string): Promise<ActionResult> {
  const view = (await projectsOn(ctx)) ? await templateOrNull(ctx.db, id) : null;
  if (view === null) return notFound(ctx);
  const collected = await collectEdit(templateSpecs(), ctx.form, { name: view.name, description: view.description, fields: "{}", untrusted_fields: "[]" }, "UTC");
  const here = templateHref(id);
  const refused = async (extra: string[] = []) => page(422, (await templatePage(await formContext(ctx, here), id, stateOf(collected, extra))) ?? "");
  if (collected.errors.length > 0) return refused();
  if (Object.keys(collected.input).length === 0) return refused([NOTHING_TO_SAVE]);
  try {
    const result = await updateTemplate(asOwner(ctx, "update_template"), id, collected.input as { name?: string; description?: string | null });
    return redirect(withChange(here, result.changeId));
  } catch (error) {
    return refused([refusal(error, "template")]);
  }
}

/** POST /templates/<id>/archive: update_template with archived 1 (Archive) or 0 (Bring back). */
async function archive(ctx: ActionContext, id: string): Promise<ActionResult> {
  const view = (await projectsOn(ctx)) ? await templateOrNull(ctx.db, id) : null;
  if (view === null) return notFound(ctx);
  const back = backTo(ctx, templateHref(id));
  try {
    const result = await updateTemplate(asOwner(ctx, "update_template"), id, { archived: ctx.form.get("archived") === "1" });
    return redirect(withChange(back, result.changeId));
  } catch (error) {
    return page(422, refusedPage(ctx, "The template wasn't changed", refusal(error, "template"), back, "", "/templates"));
  }
}

/** POST /templates/<id>/duplicate: duplicate_template. Then the copy's page. */
async function duplicate(ctx: ActionContext, id: string): Promise<ActionResult> {
  const view = (await projectsOn(ctx)) ? await templateOrNull(ctx.db, id) : null;
  if (view === null) return notFound(ctx);
  const back = backTo(ctx, templateHref(id));
  try {
    const result = await duplicateTemplate(asOwner(ctx, "duplicate_template"), id);
    return redirect(withChange(templateHref(result.templateId), result.changeId));
  } catch (error) {
    return page(422, refusedPage(ctx, "The template wasn't copied", refusal(error, "template"), back, "", "/templates"));
  }
}

/** POST /templates/<id>/tasks: add_template_task, at the top level or under the chosen task. */
async function addTask(ctx: ActionContext, id: string): Promise<ActionResult> {
  const view = (await projectsOn(ctx)) ? await templateOrNull(ctx.db, id) : null;
  if (view === null) return notFound(ctx);
  const back = backTo(ctx, templateHref(id));
  const workTypes = await workTypesFor(ctx.db, (await getSettings(ctx.db)).time_tracking === 1);
  const specs = templateTaskSpecs(workTypes);
  const collected = collectNew(specs, ctx.form);
  const under = (ctx.form.get("under") ?? "").trim();
  const refused = (extra: string[] = []) => {
    const form = addTaskForm(view, workTypes, { csrf: ctx.csrf, here: back }, { shown: collected.shown, under, errors: stateOf(collected, extra).errors });
    return page(422, refusedFormPage(ctx, "The task wasn't added", form, back, "/templates"));
  };
  if (collected.errors.length > 0) return refused();
  const input = collected.input as { title: string; description?: string; dueDays?: number; workType?: string };
  try {
    const result = await addTemplateTask(asOwner(ctx, "add_template_task"), id, { ...input, ...(under === "" ? {} : { parent: under }) });
    return redirect(withChange(back, result.changeId));
  } catch (error) {
    return refused([refusal(error, "template")]);
  }
}

/** POST /template-tasks/<id>: update_template_task with only the fields the owner changed. */
async function editTask(ctx: ActionContext, id: string): Promise<ActionResult> {
  const task = (await projectsOn(ctx)) && isTemplateTaskId(id) ? await templateTaskOfId(ctx, id) : null;
  if (task === null) return notFound(ctx);
  const specs = templateTaskSpecs(await workTypesFor(ctx.db, (await getSettings(ctx.db)).time_tracking === 1));
  const collected = await collectEdit(specs, ctx.form, { ...task, fields: "{}", untrusted_fields: "[]" }, "UTC");
  const refused = async (extra: string[] = []) =>
    page(422, (await templateTaskEditPage(await formContext(ctx, templateHref(task.template_id)), task.template_id, id, stateOf(collected, extra))) ?? "");
  if (collected.errors.length > 0) return refused();
  if (Object.keys(collected.input).length === 0) return refused([NOTHING_TO_SAVE]);
  try {
    const result = await updateTemplateTask(asOwner(ctx, "update_template_task"), id, collected.input as { title?: string; description?: string | null; dueDays?: number | null; workType?: string | null });
    return redirect(withChange(templateHref(task.template_id), result.changeId));
  } catch (error) {
    return refused([refusal(error, "template")]);
  }
}

/** The live task of a live template with this id, or null. */
async function templateTaskOfId(ctx: ActionContext, id: string) {
  const task = await templateTaskById(ctx.db, id);
  return task === null ? null : liveTemplateTask(ctx.db, task.template_id, id);
}

/** POST /template-tasks/<id>/move: move_template_task up, down, in (under the task above) or out. */
async function moveTask(ctx: ActionContext, id: string): Promise<ActionResult> {
  const task = (await projectsOn(ctx)) && isTemplateTaskId(id) ? await templateTaskOfId(ctx, id) : null;
  if (task === null) return notFound(ctx);
  const back = backTo(ctx, templateHref(task.template_id));
  const dir = ctx.form.get("dir") ?? "";
  const refused = (message: string) => page(422, refusedPage(ctx, "The task wasn't moved", message, back, "", "/templates"));
  if (!MOVES.has(dir)) return refused("Say which way to move it: up, down, in or out.");
  try {
    const result = await moveTemplateTask(asOwner(ctx, "move_template_task"), id, dir as TemplateMove);
    return redirect(withChange(back, result.changeId));
  } catch (error) {
    return refused(refusal(error, "template"));
  }
}

/** POST /template-tasks/<id>/archive: archive_template_task (the task and everything under it). */
async function removeTask(ctx: ActionContext, id: string): Promise<ActionResult> {
  const task = (await projectsOn(ctx)) && isTemplateTaskId(id) ? await templateTaskOfId(ctx, id) : null;
  if (task === null) return notFound(ctx);
  const back = backTo(ctx, templateHref(task.template_id));
  try {
    const result = await archiveTemplateTask(asOwner(ctx, "archive_template_task"), id);
    return redirect(withChange(back, result.changeId));
  } catch (error) {
    return page(422, refusedPage(ctx, "The task wasn't removed", refusal(error, "template"), back, "", "/templates"));
  }
}

export const TEMPLATE_ROUTES: Route[] = [
  { path: /^\/(templates)$/, handle: (ctx) => addNew(ctx) },
  { path: /^\/templates\/([^/]+)$/, handle: save, big: true },
  { path: /^\/templates\/([^/]+)\/archive$/, handle: archive },
  { path: /^\/templates\/([^/]+)\/duplicate$/, handle: duplicate },
  { path: /^\/templates\/([^/]+)\/tasks$/, handle: addTask, big: true },
  { path: /^\/template-tasks\/([^/]+)$/, handle: editTask },
  { path: /^\/template-tasks\/([^/]+)\/move$/, handle: moveTask },
  { path: /^\/template-tasks\/([^/]+)\/archive$/, handle: removeTask },
];
