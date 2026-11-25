// The template choice on the Start a project screens (run 10, area 4, rulings 9 and 10): a GET form of radios (None, then
// each live template) that reloads the same page with `template=<tp id>`, so nothing typed in the project form is lost
// (that form is a separate form below it); a preview of the chosen template's tasks; and the hidden field the project form
// posts. An unknown or archived id falls back to None, and with no live templates nothing is drawn.
import type { Db } from "../db/db.ts";
import { isTemplateId } from "../ids.ts";
import { listTemplates } from "../services/template-read.ts";
import { hidden } from "./forms.ts";
import { type Html, html } from "./html.ts";
import { templateOrNull } from "./pages/template.ts";
import { empty } from "./parts.ts";
import { templateTaskList } from "./template-tree.ts";

export type TemplateChoice = { above: Html | ""; hiddenField: Html | "" };

const NONE: TemplateChoice = { above: "", hiddenField: "" };

const radio = (id: string, value: string, label: string, checked: boolean): Html =>
  html`<div class="check"><input id="${id}" name="template" type="radio" value="${value}"${checked ? " checked" : ""}><label for="${id}">${label}</label></div>`;

const CHANGE_ID = /^chg_[a-z0-9]+$/;

export async function templateChoice(db: Db, path: string, asked: string | null, timeTracking: boolean, change: string | null = null): Promise<TemplateChoice> {
  const live = await listTemplates(db);
  if (live.length === 0) return NONE;
  const picked = asked !== null && isTemplateId(asked) && live.some((item) => item.id === asked) ? await templateOrNull(db, asked) : null;
  const view = picked !== null && !picked.archived ? picked : null;
  const offsets = view?.tasks.some((task) => task.dueDays !== null) === true;
  const preview =
    view === null
      ? ""
      : html`<section class="section" aria-labelledby="template-preview-h">
<h2 id="template-preview-h">Tasks from ${view.name}</h2>
${offsets ? html`<p class="field-hint">Starts today unless you set a start date.</p>` : ""}
${view.tasks.length === 0 ? empty("This template has no tasks.") : templateTaskList(view.id, view.tasks, { form: { csrf: "", here: path }, timeTracking, editable: false })}
</section>`;
  const above = html`<form class="template-choice" method="get" action="${path}">
${change !== null && CHANGE_ID.test(change) ? hidden("change", change) : ""}<fieldset class="field" aria-describedby="template-hint">
<legend>Start from a template</legend>
<p class="field-hint" id="template-hint">Choose a template, then press Show tasks to use it.</p>
${radio("template-none", "", "None", view === null)}
${live.map((item) => radio(`template-${item.id}`, item.id, item.name, view?.id === item.id))}
</fieldset>
<button class="button button-quiet button-small" type="submit">Show tasks</button>
</form>
${preview}`;
  return { above, hiddenField: view === null ? "" : hidden("template", view.id) };
}
