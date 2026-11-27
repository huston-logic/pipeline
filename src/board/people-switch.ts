// The People tab's views (decisions 0016, 0027 and 0042): the built-in Contacts, Leads and Companies, then the default
// view of each person status other than Lead and Contact, in status order, then the saved people views in position
// order. Addresses carry only a status key or a view id, both owner-made, never outside text. The Pipeline tab's
// switch (Board, List, then saved deals views) and the Projects page's (Open, each live project status, then saved
// projects views) are drawn the same way.
import type { Db, ViewModule } from "../db/db.ts";
import { BUILT_IN_VIEWS } from "../services/view-spec.ts";
import { switchItems } from "../services/views.ts";
import { type Html, html } from "./html.ts";

/** Which entry is shown: a built-in view's key, a status key or a view id. Null marks none. */
export type SwitchCurrent = { kind: "built_in" | "status" | "saved"; id: string } | null;

export type PeopleView = "contacts" | "leads" | "companies";

const LABELS: Record<ViewModule, string> = { people: "Show people as", deals: "Show deals as", projects: "Show projects as" };

/** The view switch of one module: a labelled list of links, the shown one marked aria-current="page". */
export async function viewSwitch(db: Db, module: ViewModule, current: SwitchCurrent): Promise<Html> {
  const entries = [
    ...BUILT_IN_VIEWS[module].map((view) => ({ kind: "built_in" as const, id: view.key, name: view.name, path: view.path })),
    ...(await switchItems(db, module)),
  ];
  const items = entries.map((entry) => {
    const shown = current !== null && current.kind === entry.kind && current.id === entry.id;
    return html`<li><a href="${entry.path}"${shown ? html` aria-current="page"` : ""}>${entry.name}</a></li>\n`;
  });
  return html`<ul class="view-switch" aria-label="${LABELS[module]}">
${items}</ul>`;
}

export const peopleSwitch = (db: Db, current: PeopleView): Promise<Html> => viewSwitch(db, "people", { kind: "built_in", id: current });
