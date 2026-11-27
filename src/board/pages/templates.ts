// /templates and /templates/new (run 10, area 4): the project templates, and the form that starts one. 404 while projects
// are off. `?show=archived` lists the archived ones; any other value is the live list.
import { listTemplates } from "../../services/template-read.ts";
import type { PageContext } from "../context.ts";
import { html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { count, empty } from "../parts.ts";
import type { Shown } from "../record-form.ts";
import { dataTable, layoutDescription, layoutSwitch, layoutTitle, pickLayout, type TableColumn } from "../table.ts";
import { TEMPLATE_PREFIX, TEMPLATES_PATH, templateHref, templateSpecs } from "../template-form.ts";
import { type FormState, recordFormPage } from "./record-page.ts";

export const TEMPLATES_NEW_PATH = "/templates/new";

export async function templatesPage(ctx: PageContext): Promise<string | null> {
  if (ctx.projects !== true) return null;
  const archived = ctx.query.get("show") === "archived";
  const all = await listTemplates(ctx.db, { includeArchived: archived });
  const items = archived ? all.filter((item) => item.archived) : all;
  const layout = pickLayout(ctx.query, "table");
  const firstLine = (description: string | null): string => (description === null ? "" : (description.split("\n")[0] ?? "").slice(0, 200));
  const cards = items.map(
    (item) => html`<li class="card">
<h2 class="card-title"><a href="${templateHref(item.id)}">${item.name}</a></h2>
${item.description === null ? "" : html`<p>${firstLine(item.description)}</p>`}
<p class="row-head">${count(item.taskCount, "task")}</p>
</li>`,
  );
  const columns: TableColumn<(typeof items)[number]>[] = [
    { key: "template", header: "Template", cell: (item) => html`<a href="${templateHref(item.id)}">${item.name}</a>` },
    { key: "tasks", header: "Tasks", cell: (item) => String(item.taskCount) },
    { key: "description", header: "Description", cell: (item) => firstLine(item.description) },
  ];
  const list =
    layout === "table"
      ? dataTable({ label: "Templates, as a table", caption: `${archived ? "Archived templates" : "Templates"}: ${count(items.length, "template")}.`, columns, rows: items })
      : html`<ul class="cards">${cards}</ul>`;
  return renderPage({
    title: layoutTitle(archived ? "Templates, archived" : "Templates", layout, "table"),
    description: layoutDescription(archived ? "Archived project templates." : "Project templates: a task list a new project can start from.", layout, "table"),
    current: TEMPLATES_PATH,
    frame: ctx,
    body: html`<p class="back"><a href="/projects">Back to projects</a></p>
<h1>${archived ? "Archived templates" : "Templates"}</h1>
<p class="lede">A template is a task list a new project can start from.</p>
<p class="card-actions"><a class="button button-small" href="${TEMPLATES_NEW_PATH}">New template</a>
${archived ? html`<a class="button button-quiet button-small" href="${TEMPLATES_PATH}">Back to live templates</a>` : html`<a class="button button-quiet button-small" href="${TEMPLATES_PATH}?show=archived">Archived templates</a>`}</p>
${items.length === 0 ? "" : layoutSwitch(TEMPLATES_PATH, ctx.query, layout)}
${items.length === 0 ? empty(archived ? "No archived templates." : "No templates yet.") : list}`,
  });
}

export async function templateNewPage(ctx: PageContext, state?: FormState): Promise<string | null> {
  if (ctx.projects !== true) return null;
  const specs = templateSpecs();
  const blank = new Map<string, Shown>(specs.map((spec) => [spec.name, { value: "", outside: false }]));
  return recordFormPage(ctx, {
    title: "New template",
    description: "Name a new project template and say what it is for.",
    heading: "New template",
    lede: "Name it now. You add its tasks on the next page.",
    current: TEMPLATES_PATH,
    back: { href: TEMPLATES_PATH, text: "Back to templates" },
    action: TEMPLATES_PATH,
    cancel: TEMPLATES_PATH,
    submit: "Add the template",
    prefix: TEMPLATE_PREFIX,
    groups: [{ specs }],
    shown: state?.shown ?? blank,
    errors: state?.errors ?? [],
  });
}
