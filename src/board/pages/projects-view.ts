// /projects?view=<vw id>: a saved projects view (decision 0042, run 10), after Open and each status in the Projects view
// switch. Without a status filter it shows every project that is not archived. At most 200, with the total (decision
// 0020). An id that isn't a live projects view is the board's 404. Cards or a table (decision 0043): the view's stored
// layout, or `layout=` in the address for that visit only; `sort=<key>-<dir>` the same.
import { ownerTimezone } from "../../services/lookup.ts";
import { projectsInView, VIEW_ROW_LIMIT } from "../../services/view-read.ts";
import { parseColumns, parseFilters, parseSort } from "../../services/view-spec.ts";
import { filterLabels, filterWords, liveView, sortLine } from "../../services/views.ts";
import type { PageContext } from "../context.ts";
import { html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { empty } from "../parts.ts";
import { viewSwitch } from "../people-switch.ts";
import { layoutDescription, layoutSwitch, layoutTitle, pickLayout } from "../table.ts";
import { countLine } from "../view-parts.ts";
import { projectsList, sortFromQuery, tableSummary } from "../view-table.ts";

export async function projectsViewPage(ctx: PageContext, id: string): Promise<string | null> {
  const { db } = ctx;
  if (ctx.projects !== true) return null;
  const view = await liveView(db, id, "projects");
  if (view === null) return null;
  const filters = parseFilters(view.filters);
  const sort = sortFromQuery("projects", ctx.query, parseSort("projects", view.sort));
  const layout = pickLayout(ctx.query, view.layout);
  const tz = await ownerTimezone(db);
  const [list, labels] = await Promise.all([projectsInView(db, filters, sort, VIEW_ROW_LIMIT), filterLabels(db)]);
  const words = filterWords("projects", filters, labels);
  const shows = `${words.length === 0 ? "Every project that is not archived" : `Projects with ${words.join(", ")}`}; ${sortLine(sort)}.`;
  const body =
    list.total === 0
      ? html`<p class="lede">${shows}</p>
${empty("No projects match this view.", "Ask your AI app to change its filters.")}`
      : html`<p class="lede">${shows} ${countLine(list.items.length, list.total, "project", "projects")}</p>
${projectsList(list.items, {
  layout,
  path: "/projects",
  query: ctx.query,
  sort,
  columns: parseColumns("projects", view.columns),
  fields: labels.fields,
  tz,
  name: view.name,
  summary: tableSummary(list.items.length, list.total, "project", "projects", sort),
})}`;
  return renderPage({
    region: true,
    title: layoutTitle(view.name, layout, "cards"),
    description: layoutDescription("A saved view of your projects.", layout, "cards"),
    current: "/projects",
    frame: ctx,
    body: html`<h1>${view.name}</h1>
${await viewSwitch(db, "projects", { kind: "saved", id: view.id })}
${layoutSwitch("/projects", ctx.query, layout)}
${body}`,
  });
}
