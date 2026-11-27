// /people: a person status's default view (?status=<key>) or a saved people view (?view=<vw id>), as cards
// (decision 0042). A default view has no row: it is everyone with that live status, by name, so a new status shows
// here with no code. The address carries only the status key or the view id; anything unknown, archived or of the
// wrong shape is the board's 404. Cards or a table (decision 0043): a saved view's stored layout, or `layout=` in the
// address for that visit only; `sort=<key>-<dir>` the same.
import { isViewId } from "../../ids.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { peopleInView, VIEW_ROW_LIMIT } from "../../services/view-read.ts";
import { DEFAULT_COLUMNS, DEFAULT_SORT, parseColumns, parseFilters, parseSort, type ViewSort } from "../../services/view-spec.ts";
import { filterLabels, filterWords, liveStatus, liveView, sortLine } from "../../services/views.ts";
import type { FieldDefRow } from "../../db/db.ts";
import type { PageContext } from "../context.ts";
import { type Html, html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { empty } from "../parts.ts";
import { type SwitchCurrent, viewSwitch } from "../people-switch.ts";
import { type Layout, layoutDescription, layoutSwitch, layoutTitle, pickLayout } from "../table.ts";
import { countLine } from "../view-parts.ts";
import { peopleList, sortFromQuery, tableSummary } from "../view-table.ts";

export const PEOPLE_VIEW_PATH = "/people";

/** A status key as person_statuses keys are made (slug.ts): anything else can't be one, so it is 404 with no lookup. */
const STATUS_KEY = /^[a-z0-9_]{1,60}$/;

type People = Awaited<ReturnType<typeof peopleInView>>;

/** What the view shows, how many, and the cards or the table; or the empty state. */
function results(ctx: PageContext, shown: { name: string; shows: string; layout: Layout; sort: ViewSort; columns: string[]; fields: FieldDefRow[]; tz: string }, list: People, none: Html): Html {
  if (list.total === 0) return html`<p class="lede">${shown.shows}</p>
${none}`;
  const options = {
    layout: shown.layout,
    path: PEOPLE_VIEW_PATH,
    query: ctx.query,
    sort: shown.sort,
    columns: shown.columns,
    fields: shown.fields,
    tz: shown.tz,
    name: shown.name,
    summary: tableSummary(list.items.length, list.total, "person", "people", shown.sort),
  };
  return html`<p class="lede">${shown.shows} ${countLine(list.items.length, list.total, "person", "people")}</p>
${peopleList(list.items, options)}`;
}

export async function peopleViewPage(ctx: PageContext): Promise<string | null> {
  const { db, now, query } = ctx;
  const viewId = query.get("view");
  const statusKey = query.get("status");
  const tz = await ownerTimezone(db);

  if (viewId !== null) {
    const view = isViewId(viewId) ? await liveView(db, viewId, "people") : null;
    if (view === null) return null;
    const filters = parseFilters(view.filters);
    const sort = sortFromQuery("people", query, parseSort("people", view.sort));
    const layout = pickLayout(query, view.layout);
    const [list, labels] = await Promise.all([peopleInView(db, now, tz, filters, sort, VIEW_ROW_LIMIT), filterLabels(db)]);
    const words = filterWords("people", filters, labels);
    const shows = `${words.length === 0 ? "Everyone" : `Shows ${words.join(", ")}`}; ${sortLine(sort)}.`;
    const shown = { name: view.name, shows, layout, sort, columns: parseColumns("people", view.columns), fields: labels.fields, tz };
    return page(ctx, { kind: "saved", id: view.id }, layout, "cards", {
      title: view.name,
      description: "A saved view of your people.",
      body: results(ctx, shown, list, empty("Nobody matches this view yet.", "Ask your AI app to change its filters, or give people the details it looks for.")),
    });
  }

  if (statusKey === null || !STATUS_KEY.test(statusKey)) return null;
  const status = await liveStatus(db, statusKey);
  if (status === null) return null;
  const sort = sortFromQuery("people", query, DEFAULT_SORT.people);
  const layout = pickLayout(query, "table");
  const [list, labels] = await Promise.all([peopleInView(db, now, tz, { person_status: status.key }, sort, VIEW_ROW_LIMIT), filterLabels(db)]);
  const shown = { name: status.label, shows: `Everyone whose person status is ${status.label}, ${sortLine(sort)}.`, layout, sort, columns: [...DEFAULT_COLUMNS.people], fields: labels.fields, tz };
  return page(ctx, { kind: "status", id: status.key }, layout, "table", {
    title: status.label,
    description: "Everyone with this person status.",
    body: results(ctx, shown, list, empty(`Nobody has the person status ${status.label} yet.`, "Set it on a person's Edit page, or by talking to your AI app.")),
  });
}

async function page(ctx: PageContext, current: SwitchCurrent, layout: Layout, usual: Layout, view: { title: string; description: string; body: Html }): Promise<string> {
  return renderPage({
    title: layoutTitle(view.title, layout, usual),
    description: layoutDescription(view.description, layout, usual),
    current: PEOPLE_VIEW_PATH,
    frame: ctx,
    body: html`<h1>${view.title}</h1>
${await viewSwitch(ctx.db, "people", current)}
${layoutSwitch(PEOPLE_VIEW_PATH, ctx.query, layout)}
${view.body}`,
  });
}
