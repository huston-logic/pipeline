// /leads: the People tab's Leads view (decision 0027). People you plan to approach, as cards, with a status filter, a
// source filter, a search box and a sort control that work without JavaScript (a GET form). Reads only through
// listLeads. A name, company or source from outside is labelled and never the text of a link (AGENTS.md). `layout=table`
// draws a table instead of cards (decision 0043).
import { ownerTimezone } from "../../services/lookup.ts";
import { LEAD_LIST_LIMIT, LEAD_SORTS, type LeadItem, type LeadSort, type LeadSource, leadCounts, listLeads } from "../../services/leads-read.ts";
import { CLOSED_OUT_STATUSES, type LeadStatus, OPEN_LEAD_STATUSES } from "../../services/lead-status.ts";
import { type StatusLabels, statusLabels } from "../../services/status-labels.ts";
import { formatLocal } from "../../time.ts";
import { type Html, html } from "../html.ts";
import type { PageContext } from "../context.ts";
import { renderPage } from "../layout.ts";
import { peopleSwitch } from "../people-switch.ts";
import { dataTable, type Layout, layoutDescription, layoutSwitch, layoutTitle, pickLayout, type TableColumn, withParams } from "../table.ts";
import { addButtons, contactLink, count, empty, formatNumber, labelled, pairs, when } from "../parts.ts";

const QUERY_MAX = 100;

type StatusFilter = "open" | "new" | "contacted" | "not_now" | "closed";

/** The status filter's choices, in the order shown. The first is the default. */
const STATUS_FILTERS: { value: StatusFilter; statuses: readonly LeadStatus[]; title: string; description: string }[] = [
  { value: "open", statuses: OPEN_LEAD_STATUSES, title: "Leads", description: "People you plan to approach, with their status, last contact and next task." },
  { value: "new", statuses: ["new"], title: "New leads", description: "Leads you have not reached yet, with their last contact and next task." },
  { value: "contacted", statuses: ["contacted"], title: "Contacted leads", description: "Leads you have reached, with their last contact and next task." },
  { value: "not_now", statuses: ["not_now"], title: "Leads for later", description: "Leads set aside for now, with their last contact and next task." },
  { value: "closed", statuses: CLOSED_OUT_STATUSES, title: "Closed out leads", description: "Leads marked Not a fit or Bad lead." },
];

const SORT_LABELS: Record<LeadSort, string> = {
  next_task: "Next task first",
  last_contact: "Longest since last contact",
  added: "Newest first",
};

/** What the URL asked for; anything unknown falls back to the default. */
export function leadsQuery(params: URLSearchParams): { filter: (typeof STATUS_FILTERS)[number]; source: string; query: string; sort: LeadSort } {
  const asked = params.get("status") ?? "open";
  const filter = STATUS_FILTERS.find((f) => f.value === asked) ?? STATUS_FILTERS[0]!;
  const sortAsked = params.get("sort") ?? "next_task";
  const sort = LEAD_SORTS.find((s) => s === sortAsked) ?? "next_task";
  return {
    filter,
    source: (params.get("source") ?? "").trim().slice(0, QUERY_MAX),
    query: (params.get("q") ?? "").trim().slice(0, QUERY_MAX),
    sort,
  };
}

function dateCell(iso: string | null, tz: string, none: string): Html | string {
  return iso === null ? none : when(iso, formatLocal(iso, tz));
}

function leadCard(lead: LeadItem, tz: string): Html {
  const outside = new Set<string>(lead.untrusted_fields);
  return html`<li class="card">
<div class="card-head">
<h2 class="card-title">${contactLink(lead.id, lead.name, outside.has("name"))}</h2>
</div>
${pairs([
  lead.business !== null && lead.business.trim() !== "" && { name: "Company", value: labelled(lead.business, outside.has("business")) },
  { name: "Status", value: lead.leadStatusLabel },
  { name: "Last contact", value: dateCell(lead.lastContactAt, tz, "No contact yet") },
  { name: "Next task", value: dateCell(lead.nextTaskAt, tz, "No task") },
])}
</li>`;
}

/** Each sort's column, and the way that sort runs (a sort has one direction here). */
const TABLE_SORT_DIR: Record<LeadSort, "asc" | "desc"> = { next_task: "asc", last_contact: "asc", added: "desc" };

function leadsTable(leads: LeadItem[], tz: string, params: URLSearchParams, current: LeadSort): Html {
  const sortFor = (sort: LeadSort): TableColumn<LeadItem>["sort"] => ({
    href: withParams("/leads", params, { sort }),
    now: sort === current ? TABLE_SORT_DIR[sort] : undefined,
  });
  const columns: TableColumn<LeadItem>[] = [
    { key: "name", header: "Name", cell: (l) => contactLink(l.id, l.name, l.untrusted_fields.includes("name")) },
    {
      key: "company",
      header: "Company",
      cell: (l) => (l.business === null || l.business.trim() === "" ? "None" : labelled(l.business, l.untrusted_fields.includes("business"))),
    },
    { key: "status", header: "Status", cell: (l) => l.leadStatusLabel },
    { key: "last_contact", header: "Last contact", sort: sortFor("last_contact"), cell: (l) => dateCell(l.lastContactAt, tz, "No contact yet") },
    { key: "next_task", header: "Next task", sort: sortFor("next_task"), cell: (l) => dateCell(l.nextTaskAt, tz, "No task") },
    { key: "added", header: "Added", sort: sortFor("added"), cell: (l) => when(l.createdAt, formatLocal(l.createdAt, tz)) },
  ];
  return dataTable({ label: "Leads, as a table", caption: `Leads: ${SORT_LABELS[current]}.`, columns, rows: leads });
}

/**
 * An opaque stand-in for a source key (the lowercased source text, which may come from outside): two FNV-1a hashes in
 * hex. Option values and links carry only this, never the source text (AGENTS.md, decision 0016).
 */
export function sourceToken(key: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < key.length; i++) {
    a = Math.imul(a ^ key.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ key.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

function sourceOptions(sources: LeadSource[], selectedToken: string): Html {
  return html`<option value="">All sources</option>
${sources.map((s) => {
  const token = sourceToken(s.key);
  return html`<option value="${token}"${token === selectedToken ? " selected" : ""}>${s.label} (${s.outside ? `${s.count}, from outside` : s.count})</option>\n`;
})}`;
}

/** A filter's label by the owner's current lead status labels: "New", or "Open (New, Contacted, Not now)". */
function filterLabel(filter: (typeof STATUS_FILTERS)[number], labels: StatusLabels): string {
  const names = filter.statuses.map((status) => labels.lead(status)).join(", ");
  if (filter.value === "open") return `Open (${names})`;
  if (filter.value === "closed") return `Closed out (${names})`;
  return names;
}

function searchForm(asked: ReturnType<typeof leadsQuery>, sources: LeadSource[], selectedToken: string, labels: StatusLabels, layout: Layout): Html {
  return html`<form class="search search-filters" action="/leads" method="get" role="search" aria-label="Search leads">
<div class="field field-grow">
<label for="leads-q">Search leads</label>
<p id="leads-q-hint" class="field-hint">Name, email, phone or company</p>
<input id="leads-q" type="search" name="q" value="${asked.query}" aria-describedby="leads-q-hint" maxlength="${QUERY_MAX}" autocomplete="off" enterkeyhint="search">
</div>
<div class="field">
<label for="leads-status">Status</label>
<select id="leads-status" name="status">
${STATUS_FILTERS.map((f) => html`<option value="${f.value}"${f.value === asked.filter.value ? " selected" : ""}>${filterLabel(f, labels)}</option>\n`)}</select>
</div>
<div class="field">
<label for="leads-source">Source</label>
<select id="leads-source" name="source">
${sourceOptions(sources, selectedToken)}</select>
</div>
<div class="field">
<label for="leads-sort">Sort</label>
<select id="leads-sort" name="sort">
${LEAD_SORTS.map((s) => html`<option value="${s}"${s === asked.sort ? " selected" : ""}>${SORT_LABELS[s]}</option>\n`)}</select>
</div>
${layout === "table" ? html`<input type="hidden" name="layout" value="table">\n` : ""}<button class="button" type="submit">Show leads</button>
</form>`;
}

function countLine(shown: number, total: number, query: string): string {
  const quoted = `"${query}"`;
  if (shown < total) {
    const what = query === "" ? "leads" : `leads that match ${quoted}`;
    return `Showing the first ${formatNumber(shown)} of ${formatNumber(total)} ${what}. Search to narrow it down.`;
  }
  if (query === "") return `${count(total, "lead")}.`;
  return `${count(total, "lead")} ${total === 1 ? "matches" : "match"} ${quoted}.`;
}

export async function leadsPage(ctx: PageContext): Promise<string> {
  const { db, now, query: params } = ctx;
  const tz = await ownerTimezone(db);
  const asked = leadsQuery(params);
  const layout = pickLayout(params, "cards");
  const options = { statuses: [...asked.filter.statuses], query: asked.query, sort: asked.sort, limit: LEAD_LIST_LIMIT };
  // The source filter is an opaque token; the sources come from the same list call, so a token is resolved against
  // them and only a known one narrows the list (an unknown token means All sources, with no second query).
  let list = await listLeads(db, now, tz, options);
  let token = "";
  const known = asked.source === "" ? undefined : list.sources.find((s) => sourceToken(s.key) === asked.source);
  if (known) {
    token = asked.source;
    list = await listLeads(db, now, tz, { ...options, source: known.key });
  }
  const plain = asked.filter.value === "open" && asked.query === "" && token === "";

  const keep = new URLSearchParams();
  if (layout === "table") keep.set("layout", "table");
  if (asked.filter.value !== "open") keep.set("status", asked.filter.value);
  if (token !== "") keep.set("source", token);
  if (asked.sort !== "next_task") keep.set("sort", asked.sort);
  const clearHref = keep.size === 0 ? "/leads" : `/leads?${keep.toString()}`;
  const clear = asked.query === "" ? "" : html`<p class="search-clear"><a href="${clearHref}">Clear search</a></p>`;

  let results: Html;
  if (list.total === 0 && asked.query !== "") {
    results = html`${empty(`No leads match "${asked.query}".`, "Try part of a name, an email address, a phone number or a company.")}
${clear}`;
  } else if (list.total === 0 && token === "") {
    // One more query, only here: do any people hold a lead status at all?
    const held = Object.entries(await leadCounts(db)).some(([status, n]) => status !== "qualified" && n > 0);
    if (!held) results = empty("No leads yet. A lead is someone you plan to approach who hasn't asked for anything yet.");
    else if (plain) results = empty("No open leads.", "Choose Closed out under Status to see the rest.");
    else results = empty("No leads with that status.");
  } else if (list.total === 0) {
    results = empty("No leads in this view.", "Try another status or source.");
  } else {
    results = html`${clear}
<p class="lede">${countLine(list.items.length, list.total, asked.query)}</p>
${layout === "table" ? leadsTable(list.items, tz, params, asked.sort) : html`<ul class="cards">${list.items.map((lead) => leadCard(lead, tz))}</ul>`}`;
  }
  return renderPage({
    title: layoutTitle(asked.filter.title, layout, "cards"),
    description: layoutDescription(asked.filter.description, layout, "cards"),
    current: "/leads",
    frame: ctx,
    body: html`<h1>Leads</h1>
${await peopleSwitch(ctx.db, "leads")}
${layoutSwitch("/leads", params, layout)}
${addButtons("leads", ["lead", "import"])}
${searchForm(asked, list.sources, token, await statusLabels(db), layout)}
${results}`,
  });
}
