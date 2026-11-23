// /contacts: every contact that is not archived, as cards, with a search box and a sort control that work without
// JavaScript (a GET form). Decision 0016: search, sort and the 200-contact limit; the Contacts/Leads/Companies switch
// is people-switch.ts (decision 0027). Unqualified leads are not listed here: they are on /leads, and a search that finds
// only leads says so (decision 0033).
import { ownerTimezone } from "../../services/lookup.ts";
import { listLeads } from "../../services/leads-read.ts";
import { CONTACT_LIST_LIMIT, type ContactListItem, type ContactSort, listContacts } from "../../services/read.ts";
import { type Html, html } from "../html.ts";
import type { PageContext } from "../context.ts";
import { renderPage } from "../layout.ts";
import { peopleSwitch } from "../people-switch.ts";
import { contactLink, count, dealLink, empty, formatNumber, labelled, addButtons, pairs, when } from "../parts.ts";

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

/**
 * When a search finds no contacts, one line saying how many open leads (the Leads view's default) match, linking to
 * that view with the same search, so the owner doesn't add a person twice (decision 0033). Empty when none match.
 */
async function leadsHint(ctx: PageContext, tz: string, query: string): Promise<Html | ""> {
  const { total } = await listLeads(ctx.db, ctx.now, tz, { query, limit: 1 });
  if (total === 0) return "";
  const href = `/leads?${new URLSearchParams({ q: query }).toString()}`;
  return html`<p>${total === 1 ? "1 lead matches." : `${formatNumber(total)} leads match.`} <a href="${href}">See Leads</a></p>
`;
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
    results = empty("No contacts yet.", "Add one with Add a deal or Add a lead, or by talking to your AI app. People from your website form show up here too.");
  } else if (total === 0) {
    results = html`${empty(`No contacts match "${query}".`, "Try part of a name, an email address, a phone number or a company.")}
${await leadsHint(ctx, tz, query)}${clear}`;
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
${peopleSwitch("contacts")}
${addButtons("contacts", ["deal", "lead", "import"])}
${total === 0 && query === "" ? "" : searchForm(query, sortValue)}
${results}`,
  });
}
