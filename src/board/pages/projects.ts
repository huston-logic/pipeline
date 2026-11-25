// /projects (decision 0055): the owner's projects as cards or a table, filtered by status and sorted by target date, name
// or newest. 404 while projects are off. The address carries only `status`, `sort` and `layout`; an unknown value is the
// default. A project's name, its person's and its deal's can be outside text: a name from outside is never a link's text.
import { listProjects, type ProjectItem, type ProjectSort } from "../../services/project-read.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { formatLocal } from "../../time.ts";
import type { PageContext } from "../context.ts";
import { type Html, html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { contactLink, empty, outsideLabel, pairs, projectHref, tag, when } from "../parts.ts";
import { dataTable, type Layout, layoutDescription, layoutSwitch, layoutTitle, pickLayout, type TableColumn, withParams } from "../table.ts";
import { countLine } from "../view-parts.ts";

export const PROJECTS_PATH = "/projects";

const STATUS_CHOICES = ["active", "on_hold", "done", "archived", "all"] as const;
type StatusChoice = (typeof STATUS_CHOICES)[number];
const SORTS = ["target", "name", "newest"] as const satisfies readonly ProjectSort[];

const SORT_LABELS: Record<ProjectSort, string> = { target: "Target date", name: "Name", newest: "Newest first" };
const SORT_NOTE: Record<ProjectSort, string> = { target: "", name: "by name", newest: "newest first" };
const EXTRA_LABELS = { archived: "Archived", all: "All" } as const;

const LEDE = "To start a project, open the person's page or a won deal.";

const statusOf = (query: URLSearchParams): StatusChoice => STATUS_CHOICES.find((s) => s === query.get("status")) ?? "active";
const sortOf = (query: URLSearchParams): ProjectSort => SORTS.find((s) => s === query.get("sort")) ?? "target";

/** A link to the project page. Its text is the name only when the name did not come from outside. */
function projectLink(project: ProjectItem): Html {
  if (!project.untrusted_fields.includes("name")) return html`<a href="${projectHref(project.id)}">${project.name}</a>`;
  return html`<a href="${projectHref(project.id)}">Project ${project.id}</a> ${outsideLabel()} <span class="outside-value">${project.name}</span>`;
}

/** A stored midnight as the day only: "Sat Dec 5". */
export const dateOr = (iso: string | null, tz: string): Html | string =>
  iso === null ? "Not set" : when(iso, formatLocal(iso, tz).replace(/,\s\d{1,2}:\d{2}\s[AP]M$/, ""));

const statusText = (project: ProjectItem): string => (project.archived ? `${project.statusLabel}, archived` : project.statusLabel);
const personOf = (project: ProjectItem): Html => contactLink(project.contactId, project.contactName, project.untrusted_fields.includes("contactName"));

function card(project: ProjectItem, tz: string): Html {
  return html`<li class="card">
<div class="card-head">
<h3 class="card-title">${projectLink(project)}</h3>
${tag(statusText(project))}
</div>
${pairs([
  { name: "Person", value: personOf(project) },
  { name: "Target", value: dateOr(project.targetAt, tz) },
  { name: "Open tasks", value: String(project.openTasks) },
])}
</li>`;
}

function table(items: ProjectItem[], view: { path: string; query: URLSearchParams; sort: ProjectSort; tz: string; caption: string }): Html {
  const sorted = (key: ProjectSort): TableColumn<ProjectItem>["sort"] => ({
    href: withParams(view.path, view.query, { sort: key }),
    ...(view.sort === key ? { now: "asc" as const } : {}),
  });
  const columns: TableColumn<ProjectItem>[] = [
    { key: "project", header: "Project", sort: sorted("name"), cell: projectLink },
    { key: "status", header: "Status", cell: statusText },
    { key: "person", header: "Person", cell: personOf },
    { key: "start", header: "Start", cell: (p) => dateOr(p.startAt, view.tz) },
    { key: "target", header: "Target", sort: sorted("target"), cell: (p) => dateOr(p.targetAt, view.tz) },
    { key: "open", header: "Open tasks", cell: (p) => String(p.openTasks) },
  ];
  return dataTable({ label: "Projects, as a table", caption: view.caption, columns, rows: items });
}

function option(value: string, label: string, chosen: string): Html {
  return html`<option value="${value}"${value === chosen ? " selected" : ""}>${label}</option>\n`;
}

/** Status and sort as a plain GET form; the layout rides along as a hidden field so the form keeps it. */
function tools(statuses: { key: string; label: string }[], status: StatusChoice, sort: ProjectSort, layout: Layout): Html {
  const statusOptions = [...statuses.map((s) => ({ value: s.key, label: s.label })), { value: "archived", label: EXTRA_LABELS.archived }, { value: "all", label: EXTRA_LABELS.all }];
  return html`<form class="search search-filters todo-filter" action="${PROJECTS_PATH}" method="get" aria-label="Filter and sort projects">
<div class="field">
<label for="project-status">Show</label>
<select id="project-status" name="status">
${statusOptions.map((o) => option(o.value, o.label, status))}</select>
</div>
<div class="field">
<label for="project-sort">Sort by</label>
<select id="project-sort" name="sort">
${SORTS.map((key) => option(key, SORT_LABELS[key], sort))}</select>
</div>
${layout === "table" ? html`<input type="hidden" name="layout" value="table">` : ""}
<button class="button" type="submit">Show projects</button>
</form>`;
}

export async function projectsPage(ctx: PageContext): Promise<string | null> {
  if (ctx.projects !== true) return null;
  const { db, query } = ctx;
  const status = statusOf(query);
  const sort = sortOf(query);
  const layout = pickLayout(query, "cards");
  const tz = await ownerTimezone(db);
  const found = await listProjects(db, {
    sort,
    ...(status === "archived" ? { includeArchived: true } : status === "all" ? {} : { status }),
  });
  const items = status === "archived" ? found.items.filter((p) => p.archived) : found.items;
  const label = found.statuses.find((s) => s.key === status)?.label ?? EXTRA_LABELS[status as keyof typeof EXTRA_LABELS] ?? "";
  const note = [status === "active" ? "" : status === "all" ? "all statuses" : label.toLowerCase(), SORT_NOTE[sort]].filter((part) => part !== "").join(", ");
  const description = "Your projects with their status, person, target date and open tasks.";
  const title = layoutTitle(note === "" ? "Projects" : `Projects, ${note}`, layout, "cards");
  const total = status === "archived" ? items.length : found.total;
  const summary = countLine(items.length, total, "project", "projects");
  const body =
    items.length === 0
      ? empty("No projects here.")
      : layout === "table"
        ? table(items, { path: PROJECTS_PATH, query, sort, tz, caption: `Projects: ${summary}` })
        : html`<ul class="cards">${items.map((project) => card(project, tz))}</ul>`;
  return renderPage({
    title,
    description: layoutDescription(note === "" ? description : `${description.replace(/\.$/, "")}: ${note}.`, layout, "cards"),
    current: PROJECTS_PATH,
    frame: ctx,
    body: html`<h1>Projects</h1>
<p class="lede">${LEDE}</p>
${tools(found.statuses, status, sort, layout)}
${layoutSwitch(PROJECTS_PATH, query, layout)}
${items.length === 0 ? "" : html`<p class="stage-more">${summary}</p>`}
${body}`,
  });
}
