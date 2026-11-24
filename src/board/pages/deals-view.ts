// /pipeline?view=<vw id>: a saved deals view (decision 0042), as cards after Board and List in the Pipeline's view
// switch. Without a stage filter it shows open deals; with one, the deals in that stage, open or closed. At most 200,
// with the total (decision 0020). An id that isn't a live deals view is the board's 404. Cards or a table (decision
// 0043): the view's stored layout, or `layout=` in the address for that visit only; `sort=<key>-<dir>` the same.
import { isViewId } from "../../ids.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { dealsInView, VIEW_ROW_LIMIT } from "../../services/view-read.ts";
import { parseColumns, parseFilters, parseSort } from "../../services/view-spec.ts";
import { filterLabels, filterWords, liveView, sortLine } from "../../services/views.ts";
import type { PageContext } from "../context.ts";
import { html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { empty } from "../parts.ts";
import { viewSwitch } from "../people-switch.ts";
import { layoutDescription, layoutSwitch, layoutTitle, pickLayout } from "../table.ts";
import { countLine } from "../view-parts.ts";
import { dealsList, sortFromQuery, tableSummary } from "../view-table.ts";

export async function dealsViewPage(ctx: PageContext, id: string): Promise<string | null> {
  const { db, now } = ctx;
  const view = isViewId(id) ? await liveView(db, id, "deals") : null;
  if (view === null) return null;
  const filters = parseFilters(view.filters);
  const sort = sortFromQuery("deals", ctx.query, parseSort("deals", view.sort));
  const layout = pickLayout(ctx.query, view.layout);
  const tz = await ownerTimezone(db);
  const [list, labels] = await Promise.all([dealsInView(db, now, tz, filters, sort, VIEW_ROW_LIMIT), filterLabels(db)]);
  const words = filterWords("deals", filters, labels);
  const what = filters.stage === undefined ? "Open deals" : "Deals";
  const shows = `${words.length === 0 ? "Every open deal" : `${what} with ${words.join(", ")}`}; ${sortLine(sort)}.`;
  const body =
    list.total === 0
      ? html`<p class="lede">${shows}</p>
${empty("No deals match this view.", "Ask your AI app to change its filters.")}`
      : html`<p class="lede">${shows} ${countLine(list.items.length, list.total, "deal", "deals")}</p>
${dealsList(list.items, {
  layout,
  path: "/pipeline",
  query: ctx.query,
  sort,
  columns: parseColumns("deals", view.columns),
  fields: labels.fields,
  tz,
  name: view.name,
  summary: tableSummary(list.items.length, list.total, "deal", "deals", sort),
})}`;
  return renderPage({
    title: layoutTitle(view.name, layout, "cards"),
    description: layoutDescription("A saved view of your deals.", layout, "cards"),
    current: "/pipeline",
    frame: ctx,
    body: html`<h1>${view.name}</h1>
${await viewSwitch(db, "deals", { kind: "saved", id: view.id })}
${layoutSwitch("/pipeline", ctx.query, layout)}
${body}`,
  });
}
