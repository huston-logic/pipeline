// /templates/<tp id> (run 10, area 4): a template's name and description, its task tree to three levels, Add a task,
// Duplicate, and Archive or Bring back. 404 while projects are off and for an id that is no template's.
import { isTemplateId } from "../../ids.ts";
import { liveWorkTypeRows } from "../../services/memo.ts";
import { getTemplate, type TemplateView } from "../../services/template-read.ts";
import { UserError } from "../../services/errors.ts";
import type { Db } from "../../db/db.ts";
import type { PageContext } from "../context.ts";
import { type FormContext, hidden, postForm } from "../forms.ts";
import { type Html, html } from "../html.ts";
import { field } from "../inputs.ts";
import { renderPage } from "../layout.ts";
import { empty, section, tag } from "../parts.ts";
import { formErrorSummary, specFields } from "../record-fields.ts";
import { editShown, type Shown } from "../record-form.ts";
import { TASK_PREFIX, TEMPLATE_PREFIX, TEMPLATES_PATH, templateHref, templateSpecs, templateTaskSpecs } from "../template-form.ts";
import { templateTaskList } from "../template-tree.ts";
import type { FormState } from "./record-page.ts";

/** The live work types as the task forms list them, or null while time tracking is off. */
export async function workTypesFor(db: Db, on: boolean): Promise<{ id: string; name: string }[] | null> {
  if (!on) return null;
  return (await liveWorkTypeRows(db)).map((row) => ({ id: row.id, name: row.name }));
}

/** The template, or null when it is not there (a name or an unknown id both refuse as a UserError). */
export async function templateOrNull(db: Db, id: string): Promise<TemplateView | null> {
  if (!isTemplateId(id)) return null;
  try {
    return await getTemplate(db, id);
  } catch (error) {
    if (error instanceof UserError) return null;
    throw error;
  }
}

/** Level-1 and level-2 tasks, the ones another task can go under. */
function underChoices(view: TemplateView): { value: string; label: string }[] {
  const counters: number[] = [];
  const choices: { value: string; label: string }[] = [];
  for (const task of view.tasks) {
    counters.length = task.depth + 1;
    counters[task.depth] = (counters[task.depth] ?? 0) + 1;
    // The outline number ("1.2.") makes two tasks with one title tell apart and shows the level.
    if (task.depth < 2) choices.push({ value: task.id, label: `${counters.map((n) => n ?? 0).join(".")}. ${task.title}` });
  }
  return choices;
}

export type AddState = { shown: Map<string, Shown>; under: string; errors: FormState["errors"] };

/** The Add a task form; `state` keeps what was posted when it was refused. */
export function addTaskForm(view: TemplateView, workTypes: { id: string; name: string }[] | null, form: FormContext, state?: AddState): Html {
  const specs = templateTaskSpecs(workTypes);
  const prefix = `${TASK_PREFIX}-new`;
  const choices = underChoices(view);
  return postForm(
    "record-form",
    `${templateHref(view.id)}/tasks`,
    form,
    html`${formErrorSummary(state?.errors ?? [], specs, prefix)}<div class="card form-card">
${specFields(specs, state?.shown ?? new Map(), prefix)}
${choices.length === 0 ? "" : field({ id: `${prefix}-under`, name: "under", label: "Under", kind: "choice", value: state?.under ?? "", blank: "Top level", groups: [{ label: "", options: choices }], hint: "The new task goes under the one you choose." })}
</div>
<div class="form-actions"><button class="button" type="submit">Add the task</button></div>`,
    { novalidate: true },
  );
}

function infoForm(view: TemplateView, form: FormContext, state: FormState | undefined, shown: Map<string, Shown>): Html {
  const specs = templateSpecs();
  return postForm(
    "record-form",
    templateHref(view.id),
    form,
    html`${formErrorSummary(state?.errors ?? [], specs, TEMPLATE_PREFIX)}<div class="card form-card">
${specFields(specs, shown, TEMPLATE_PREFIX)}
</div>
<div class="form-actions"><button class="button" type="submit">Save changes</button></div>`,
    { novalidate: true },
  );
}

export async function templatePage(ctx: PageContext, id: string, state?: FormState): Promise<string | null> {
  if (ctx.projects !== true) return null;
  const view = await templateOrNull(ctx.db, id);
  if (view === null) return null;
  const form: FormContext = { csrf: ctx.csrf, here: ctx.here };
  const tracking = ctx.timeTracking === true;
  const workTypes = await workTypesFor(ctx.db, tracking);
  const shown =
    state?.shown ??
    (await editShown(templateSpecs(), { name: view.name, description: view.description, fields: "{}", untrusted_fields: "[]" }, "UTC"));
  const tasks = view.tasks.length === 0 ? empty("No tasks yet.") : templateTaskList(view.id, view.tasks, { form, timeTracking: tracking, editable: !view.archived });
  const live = !view.archived;
  const refused = (state?.errors.length ?? 0) > 0;
  return renderPage({
    title: refused ? `Error: ${view.name}` : view.name,
    description: "A project template: its name, description and task list.",
    current: TEMPLATES_PATH,
    frame: ctx,
    body: html`<p class="back"><a href="${TEMPLATES_PATH}">Back to templates</a></p>
<h1>${view.name}</h1>
${view.archived ? html`<p class="lede">${tag("Archived")} This template is archived. Bring it back to change it.</p>` : ""}
${live ? section("template-details", "Name and description", infoForm(view, form, state, shown)) : ""}
${section("template-tasks", "Tasks", html`${tasks}`)}
${live ? section("template-add", "Add a task", addTaskForm(view, workTypes, form)) : ""}
${section(
  "template-more",
  "Copy or archive",
  html`${live ? postForm("template-duplicate", `${templateHref(view.id)}/duplicate`, form, html`<button class="button button-quiet button-small" type="submit">Duplicate this template</button>`) : ""}
${live ? html`<p class="field-hint">Archived templates aren't offered when you start a project. You can bring one back.</p>` : ""}
${postForm("template-archive", `${templateHref(view.id)}/archive`, form, html`${hidden("archived", view.archived ? "0" : "1")}<button class="button button-quiet button-small" type="submit">${view.archived ? "Bring back" : "Archive"}</button>`)}`,
)}`,
  });
}
