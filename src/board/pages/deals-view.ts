// /pipeline?view=<vw id>: a saved deals view (decision 0042), as cards after Board and List in the Pipeline's view
// switch. Without a stage filter it shows open deals; with one, the deals in that stage, open or closed. At most 200,
// with the total (decision 0020). An id that isn't a live deals view is the board's 404. A table layout is drawn as
// cards until the table layout task.
import { isViewId } from "../../ids.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { dealsInView, VIEW_ROW_LIMIT } from "../../services/view-read.ts";
import { parseFilters, parseSort } from "../../services/view-spec.ts";
import { filterLabels, filterWords, liveView, sortLine } from "../../services/views.ts";
import type { PageContext } from "../context.ts";
import { html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { empty } from "../parts.ts";
import { viewSwitch } from "../people-switch.ts";
import { countLine, dealCard } from "../view-parts.ts";

export async function dealsViewPage(ctx: PageContext, id: string): Promise<string | null> {
  const { db, now } = ctx;
  const view = isViewId(id) ? await liveView(db, id, "deals") : null;
  if (view === null) return null;
  const filters = parseFilters(view.filters);
  const sort = parseSort("deals", view.sort);
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
<ul class="cards">${list.items.map(dealCard)}</ul>`;
  return renderPage({
    title: view.name,
    description: `Your saved view ${view.name}: ${shows}`,
    current: "/pipeline",
    frame: ctx,
    body: html`<h1>${view.name}</h1>
${await viewSwitch(db, "deals", { kind: "saved", id: view.id })}
${body}`,
  });
}
