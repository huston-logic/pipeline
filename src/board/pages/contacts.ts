// /contacts: every contact that is not archived, as cards, with a search box and a sort control that work without
// JavaScript (a GET form). Decision 0016: search, sort, the 200-contact limit and the People/Companies switch.
import { ownerTimezone } from "../../services/lookup.ts";
import { CONTACT_LIST_LIMIT, type ContactListItem, type ContactSort, listContacts } from "../../services/read.ts";
import { type Html, html } from "../html.ts";
import type { PageContext } from "../context.ts";
import { renderPage } from "../layout.ts";
import { contactLink, count, dealLink, empty, formatNumber, labelled, pairs, when } from "../parts.ts";

type Dir = "asc" | "desc";

/** The sort control's choices, in the order shown. The first is the default. */
export const SORTS: { value: `${ContactSort}-${Dir}`; label: string }[] = [
  { value: "name-asc", label: "Name, A to Z" },
  { value: "name-desc", label: "Name, Z to A" },
  { value: "company-asc", label: "Company, A to Z" },
  { value: "company-desc", label: "Company, Z to A" },
  { value: "deals-desc", label: "Most open deals" },
  { value: "deals-asc", label: "Fewest open deals" },
  { value: "activity-desc", label: "Latest activity first" },
  { value: "activity-asc", label: "Oldest activity first" },
];

const DEFAULT_SORT = "name-asc";

/** Longer searches are cut to this many characters; nobody types more to find a contact. */
const QUERY_MAX = 100;

/** The search and sort asked for in the URL; anything unknown falls back to the defaults. */
export function contactsQuery(params: URLSearchParams): { query: string; sort: ContactSort; dir: Dir; sortValue: string } {
  const query = (params.get("q") ?? "").trim().slice(0, QUERY_MAX);
  const asked = params.get("sort") ?? DEFAULT_SORT;
  const sortValue = SORTS.some((s) => s.value === asked) ? asked : DEFAULT_SORT;
  const [sort, dir] = sortValue.split("-") as [ContactSort, Dir];
  return { query, sort, dir, sortValue };
}

/** People / Companies: the two views of the Contacts tab. */
export function viewSwitch(current: "/contacts" | "/companies"): Html {
  const item = (href: string, label: string) =>
    html`<li><a href="${href}"${href === current ? html` aria-current="page"` : ""}>${label}</a></li>`;
  return html`<ul class="view-switch" aria-label="Show contacts as">
${item("/contacts", "People")}
${item("/companies", "Companies")}
</ul>`;
}

function contactCard(contact: ContactListItem): Html {
  const outside = new Set<string>(contact.untrusted_fields);
  const deals = contact.openDeals;
  return html`<li class="card">
<div class="card-head">
<h2 class="card-title">${contactLink(contact.id, contact.name, outside.has("name"))}</h2>
</div>
${pairs([
  contact.business !== null && contact.business.trim() !== "" && { name: "Company", value: labelled(contact.business, outside.has("business")) },
  { name: "Open deals", value: deals.length === 0 ? "None" : String(deals.length) },
  {
    name: "Last activity",
    value:
      contact.lastActivityAt === null || contact.lastActivityAtLocal === null
        ? "None logged yet"
        : when(contact.lastActivityAt, contact.lastActivityAtLocal),
  },
])}
${
  deals.length === 0
    ? ""
    : html`<ul class="card-links">${deals.map((deal) => html`<li>${dealLink(deal.id, deal.title, deal.untrusted_fields.includes("title"))}</li>`)}</ul>`
}
</li>`;
}

function searchForm(query: string, sortValue: string): Html {
  return html`<form class="search" action="/contacts" method="get" role="search" aria-label="Search contacts">
<div class="field field-grow">
<label for="contacts-q">Search contacts</label>
<p id="contacts-q-hint" class="field-hint">Name, email, phone or company</p>
<input id="contacts-q" type="search" name="q" value="${query}" aria-describedby="contacts-q-hint" maxlength="${QUERY_MAX}" autocomplete="off" enterkeyhint="search">
</div>
<div class="field">
<label for="contacts-sort">Sort</label>
<select id="contacts-sort" name="sort">
${SORTS.map((s) => html`<option value="${s.value}"${s.value === sortValue ? " selected" : ""}>${s.label}</option>\n`)}</select>
</div>
<button class="button" type="submit">Show contacts</button>
</form>`;
}

function countLine(shown: number, total: number, query: string): string {
  const quoted = `"${query}"`;
  if (shown < total) {
    const what = query === "" ? "contacts" : `contacts that match ${quoted}`;
    return `Showing the first ${formatNumber(shown)} of ${formatNumber(total)} ${what}. Search to narrow it down.`;
  }
  if (query === "") return `${count(total, "contact")}.`;
  return `${count(total, "contact")} ${total === 1 ? "matches" : "match"} ${quoted}.`;
}

export async function contactsPage(ctx: PageContext): Promise<string> {
  const { db, query: params } = ctx;
  const tz = await ownerTimezone(db);
  const { query, sort, dir, sortValue } = contactsQuery(params);
  const { contacts, total } = await listContacts(db, tz, { query, sort, dir, limit: CONTACT_LIST_LIMIT });
  const clearHref = sortValue === DEFAULT_SORT ? "/contacts" : `/contacts?sort=${sortValue}`;
  const clear = query === "" ? "" : html`<p class="search-clear"><a href="${clearHref}">Clear search</a></p>`;
  let results: Html;
  if (total === 0 && query === "") {
    results = empty("No contacts yet.", "People from your website form, and the ones you add by talking to your AI app, show up here.");
  } else if (total === 0) {
    results = html`${empty(`No contacts match "${query}".`, "Try part of a name, an email address, a phone number or a company.")}
${clear}`;
  } else {
    results = html`${clear}
<p class="lede">${countLine(contacts.length, total, query)}</p>
<ul class="cards">${contacts.map(contactCard)}</ul>`;
  }
  return renderPage({
    title: "Contacts",
    description: "Everyone in your pipeline, with their company, open deals and last activity. Search and sort them.",
    current: "/contacts",
    frame: ctx,
    body: html`<h1>Contacts</h1>
${viewSwitch("/contacts")}
${total === 0 && query === "" ? "" : searchForm(query, sortValue)}
${results}`,
  });
}
