// /people: a person status's default view (?status=<key>) or a saved people view (?view=<vw id>), as cards
// (decision 0042). A default view has no row: it is everyone with that live status, by name, so a new status shows
// here with no code. The address carries only the status key or the view id; anything unknown, archived or of the
// wrong shape is the board's 404. A saved view's table layout is drawn as cards until the table layout task.
import { isViewId } from "../../ids.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { peopleInView, VIEW_ROW_LIMIT } from "../../services/view-read.ts";
import { DEFAULT_SORT, parseFilters, parseSort } from "../../services/view-spec.ts";
import { filterLabels, filterWords, liveStatus, liveView, sortLine } from "../../services/views.ts";
import type { PageContext } from "../context.ts";
import { type Html, html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { empty } from "../parts.ts";
import { type SwitchCurrent, viewSwitch } from "../people-switch.ts";
import { countLine, personCard } from "../view-parts.ts";

export const PEOPLE_VIEW_PATH = "/people";

/** A status key as person_statuses keys are made (slug.ts): anything else can't be one, so it is 404 with no lookup. */
const STATUS_KEY = /^[a-z0-9_]{1,60}$/;

/** What the view shows, how many, and the cards; or the empty state. */
function results(shows: string, list: Awaited<ReturnType<typeof peopleInView>>, none: Html): Html {
  if (list.total === 0) return html`<p class="lede">${shows}</p>
${none}`;
  return html`<p class="lede">${shows} ${countLine(list.items.length, list.total, "person", "people")}</p>
<ul class="cards">${list.items.map(personCard)}</ul>`;
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
    const sort = parseSort("people", view.sort);
    const [list, labels] = await Promise.all([peopleInView(db, now, tz, filters, sort, VIEW_ROW_LIMIT), filterLabels(db)]);
    const words = filterWords("people", filters, labels);
    const shows = `${words.length === 0 ? "Everyone" : `Shows ${words.join(", ")}`}; ${sortLine(sort)}.`;
    return page(ctx, { kind: "saved", id: view.id }, {
      title: view.name,
      description: "A saved view of your people.",
      body: results(shows, list, empty("Nobody matches this view yet.", "Ask your AI app to change its filters, or give people the details it looks for.")),
    });
  }

  if (statusKey === null || !STATUS_KEY.test(statusKey)) return null;
  const status = await liveStatus(db, statusKey);
  if (status === null) return null;
  const sort = DEFAULT_SORT.people;
  const list = await peopleInView(db, now, tz, { person_status: status.key }, sort, VIEW_ROW_LIMIT);
  return page(ctx, { kind: "status", id: status.key }, {
    title: status.label,
    description: "Everyone with this person status.",
    body: results(`Everyone whose person status is ${status.label}, ${sortLine(sort)}.`, list, empty(`Nobody has the person status ${status.label} yet.`, "Set it on a person's Edit page, or by talking to your AI app.")),
  });
}

async function page(ctx: PageContext, current: SwitchCurrent, view: { title: string; description: string; body: Html }): Promise<string> {
  return renderPage({
    title: view.title,
    description: view.description,
    current: PEOPLE_VIEW_PATH,
    frame: ctx,
    body: html`<h1>${view.title}</h1>
${await viewSwitch(ctx.db, "people", current)}
${view.body}`,
  });
}
