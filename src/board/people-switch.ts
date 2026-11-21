// The People tab's three views: Contacts, Leads and Companies (decisions 0016 and 0027).
import { type Html, html } from "./html.ts";

export type PeopleView = "contacts" | "leads" | "companies";

const VIEWS: { view: PeopleView; href: string; label: string }[] = [
  { view: "contacts", href: "/contacts", label: "Contacts" },
  { view: "leads", href: "/leads", label: "Leads" },
  { view: "companies", href: "/companies", label: "Companies" },
];

export function peopleSwitch(current: PeopleView): Html {
  const items = VIEWS.map(
    ({ view, href, label }) => html`<li><a href="${href}"${view === current ? html` aria-current="page"` : ""}>${label}</a></li>`,
  );
  return html`<ul class="view-switch" aria-label="Show people as">
${items[0]}
${items[1]}
${items[2]}
</ul>`;
}
