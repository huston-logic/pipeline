// /projects (decision 0055): the owner's projects as cards or a table, filtered by status and sorted by target date, name
// or newest. 404 while projects are off. The address carries only `status` (`open`, a live status's key, `closed`,
// `archived` or `all`), `sort`, `layout` and `view` (a saved projects view's id); an unknown value is the default. A
// project's name, its person's and its deal's can be outside text: a name from outside is never a link's text.
import { isViewId } from "../../ids.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { projectStatusRows } from "../../services/memo.ts";
import { listProjects, type ProjectItem, type ProjectListOptions, type ProjectSort } from "../../services/project-read.ts";
import type { PageContext } from "../context.ts";
import { type Html, html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { empty } from "../parts.ts";
import { viewSwitch } from "../people-switch.ts";
import { dateOr, itemLink, personOf, projectCard, statusText } from "../project-parts.ts";
import { dataTable, type Layout, layoutDescription, layoutSwitch, layoutTitle, pickLayout, type TableColumn, withParams } from "../table.ts";
import { countLine } from "../view-parts.ts";
import { projectsViewPage } from "./projects-view.ts";

export const PROJECTS_PATH = "/projects";

const DEFAULT_STATUS = "open";
const SORTS = ["target", "name", "newest", "start"] as const satisfies readonly ProjectSort[];

const SORT_LABELS: Record<ProjectSort, string> = { target: "Target date", name: "Name", newest: "Newest first", start: "Start date" };
const SORT_NOTE: Record<ProjectSort, string> = { target: "", name: "by name", newest: "newest first", start: "by start date" };
/** The choices that are not one live status's key: where each sits in the list is `choices` below. */
const EXTRA_LABELS = { open: "Open", closed: "Closed", archived: "Archived", all: "All statuses" } as const;

const LEDE = "To start a project, open the person's page or a won deal.";

const sortOf = (query: URLSearchParams): ProjectSort => SORTS.find((s) => s === query.get("sort")) ?? "target";

/** The status choices in the order the form lists them: Open, each live status, Closed, Archived, All statuses. */
function choicesOf(statuses: readonly { key: string; label: string }[]): { value: string; label: string }[] {
  return [
    { value: "open", label: EXTRA_LABELS.open },
    ...statuses.map((s) => ({ value: s.key, label: s.label })),
    { value: "closed", label: EXTRA_LABELS.closed },
    { value: "archived", label: EXTRA_LABELS.archived },
    { value: "all", label: EXTRA_LABELS.all },
  ];
}

/** What the database is asked for, by choice: archived goes to SQL, never filtered afterwards. */
function listOptions(status: string): ProjectListOptions {
  if (status === "archived") return { archivedOnly: true };
  if (status === "all") return {};
  return { status };
}

function table(items: ProjectItem[], view: { path: string; query: URLSearchParams; sort: ProjectSort; tz: string; caption: string }): Html {
  const sorted = (key: ProjectSort): TableColumn<ProjectItem>["sort"] => ({
    href: withParams(view.path, view.query, { sort: key }),
    ...(view.sort === key ? { now: "asc" as const } : {}),
  });
  const columns: TableColumn<ProjectItem>[] = [
    { key: "project", header: "Project", sort: sorted("name"), cell: itemLink },
    { key: "status", header: "Status", cell: statusText },
    { key: "person", header: "Person", cell: personOf },
    { key: "start", header: "Start", sort: sorted("start"), cell: (p) => dateOr(p.startAt, view.tz) },
    { key: "target", header: "Target", sort: sorted("target"), cell: (p) => dateOr(p.targetAt, view.tz) },
    { key: "open", header: "Open tasks", cell: (p) => String(p.openTasks) },
  ];
  return dataTable({ label: "Projects, as a table", caption: view.caption, columns, rows: items });
}

function option(value: string, label: string, chosen: string): Html {
  return html`<option value="${value}"${value === chosen ? " selected" : ""}>${label}</option>\n`;
}

/** Status and sort as a plain GET form; the layout rides along as a hidden field so the form keeps it. */
function tools(choices: { value: string; label: string }[], status: string, sort: ProjectSort, layout: Layout): Html {
  return html`<form class="search search-filters todo-filter" action="${PROJECTS_PATH}" method="get" aria-label="Filter and sort projects">
<div class="field">
<label for="project-status">Show</label>
<select id="project-status" name="status">
${choices.map((o) => option(o.value, o.label, status))}</select>
</div>
<div class="field">
<label for="project-sort">Sort by</label>
<select id="project-sort" name="sort">
${SORTS.map((key) => option(key, SORT_LABELS[key], sort))}</select>
</div>
${layout === "cards" ? html`<input type="hidden" name="layout" value="cards">` : ""}
<button class="button" type="submit">Show projects</button>
</form>`;
}

export async function projectsPage(ctx: PageContext): Promise<string | null> {
  if (ctx.projects !== true) return null;
  const { db, query } = ctx;
  // A saved projects view (decision 0042): an id that isn't a live projects view is the board's 404.
  const asked = query.get("view");
  if (asked !== null) return isViewId(asked) ? projectsViewPage(ctx, asked) : null;
  const statuses = await projectStatusRows(db);
  const choices = choicesOf(statuses);
  const status = choices.find((c) => c.value === query.get("status"))?.value ?? DEFAULT_STATUS;
  const sort = sortOf(query);
  const layout = pickLayout(query, "table");
  const tz = await ownerTimezone(db);
  const found = await listProjects(db, { sort, ...listOptions(status) });
  const items = found.items;
  const label = choices.find((c) => c.value === status)?.label ?? "";
  const note = [status === DEFAULT_STATUS ? "" : status === "all" ? "all statuses" : label.toLowerCase(), SORT_NOTE[sort]].filter((part) => part !== "").join(", ");
  const description = "Your projects with their status, person, target date and open tasks.";
  const title = layoutTitle(note === "" ? "Projects" : `Projects, ${note}`, layout, "table");
  const summary = countLine(items.length, found.total, "project", "projects");
  const body =
    items.length === 0
      ? empty("No projects here.")
      : layout === "table"
        ? table(items, { path: PROJECTS_PATH, query, sort, tz, caption: `Projects: ${summary}` })
        : html`<ul class="cards">${items.map((project) => projectCard(project, tz))}</ul>`;
  const shown = status === "open" ? { kind: "built_in" as const, id: "open" } : statuses.some((s) => s.key === status) ? { kind: "status" as const, id: status } : null;
  return renderPage({
    region: true,
    title,
    description: layoutDescription(note === "" ? description : `${description.replace(/\.$/, "")}: ${note}.`, layout, "table"),
    current: PROJECTS_PATH,
    frame: ctx,
    body: html`<h1>Projects</h1>
<p class="lede">${LEDE}</p>
<p class="card-actions"><a class="button button-small" href="/projects/new">Start a project</a>
<a class="button button-quiet button-small" href="/templates">Templates</a></p>
${await viewSwitch(db, "projects", shown)}
${tools(choices, status, sort, layout)}
${layoutSwitch(PROJECTS_PATH, query, layout)}
${items.length === 0 ? "" : html`<p class="stage-more">${summary}</p>`}
${body}`,
  });
}
