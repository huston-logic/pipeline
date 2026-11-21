// /leads: the People tab's Leads view (decision 0027). People you plan to approach, as cards, with a status filter, a
// source filter, a search box and a sort control that work without JavaScript (a GET form). Reads only through
// listLeads. A name, company or source from outside is labelled and never the text of a link (AGENTS.md).
import { ownerTimezone } from "../../services/lookup.ts";
import { LEAD_LIST_LIMIT, LEAD_SORTS, type LeadItem, type LeadSort, type LeadSource, listLeads } from "../../services/leads-read.ts";
import { businessKey } from "../../services/lead-change.ts";
import { CLOSED_OUT_STATUSES, type LeadStatus, OPEN_LEAD_STATUSES } from "../../services/lead-status.ts";
import { formatLocal } from "../../time.ts";
import { type Html, html } from "../html.ts";
import type { PageContext } from "../context.ts";
import { renderPage } from "../layout.ts";
import { peopleSwitch } from "../people-switch.ts";
import { contactLink, count, empty, formatNumber, labelled, pairs, when } from "../parts.ts";

const QUERY_MAX = 100;

type StatusFilter = "open" | "new" | "contacted" | "not_now" | "closed";

/** The status filter's choices, in the order shown. The first is the default. */
const STATUS_FILTERS: { value: StatusFilter; label: string; statuses: readonly LeadStatus[]; title: string; description: string }[] = [
  { value: "open", label: "Open (New, Contacted, Not now)", statuses: OPEN_LEAD_STATUSES, title: "Leads", description: "People you plan to approach, with their status, last contact and next task." },
  { value: "new", label: "New", statuses: ["new"], title: "New leads", description: "Leads you have not reached yet, with their last contact and next task." },
  { value: "contacted", label: "Contacted", statuses: ["contacted"], title: "Contacted leads", description: "Leads you have reached, with their last contact and next task." },
  { value: "not_now", label: "Not now", statuses: ["not_now"], title: "Leads for later", description: "Leads set aside for now, with their last contact and next task." },
  { value: "closed", label: "Closed out (Not a fit, Bad lead)", statuses: CLOSED_OUT_STATUSES, title: "Closed out leads", description: "Leads marked Not a fit or Bad lead." },
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

function sourceOptions(sources: LeadSource[], selectedKey: string): Html {
  return html`<option value="">All sources</option>
${sources.map(
  (s) => html`<option value="${s.key}"${s.key === selectedKey ? " selected" : ""}>${s.label} (${s.outside ? `${s.count}, from outside` : s.count})</option>\n`,
)}`;
}

function searchForm(asked: ReturnType<typeof leadsQuery>, sources: LeadSource[], sourceKey: string): Html {
  return html`<form class="search search-filters" action="/leads" method="get" role="search" aria-label="Search leads">
<div class="field field-grow">
<label for="leads-q">Search leads</label>
<p id="leads-q-hint" class="field-hint">Name, email, phone or company</p>
<input id="leads-q" type="search" name="q" value="${asked.query}" aria-describedby="leads-q-hint" maxlength="${QUERY_MAX}" autocomplete="off" enterkeyhint="search">
</div>
<div class="field">
<label for="leads-status">Status</label>
<select id="leads-status" name="status">
${STATUS_FILTERS.map((f) => html`<option value="${f.value}"${f.value === asked.filter.value ? " selected" : ""}>${f.label}</option>\n`)}</select>
</div>
<div class="field">
<label for="leads-source">Source</label>
<select id="leads-source" name="source">
${sourceOptions(sources, sourceKey)}</select>
</div>
<div class="field">
<label for="leads-sort">Sort</label>
<select id="leads-sort" name="sort">
${LEAD_SORTS.map((s) => html`<option value="${s}"${s === asked.sort ? " selected" : ""}>${SORT_LABELS[s]}</option>\n`)}</select>
</div>
<button class="button" type="submit">Show leads</button>
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
  const options = { statuses: [...asked.filter.statuses], query: asked.query, sort: asked.sort, limit: LEAD_LIST_LIMIT };
  let sourceKey = asked.source === "" ? "" : businessKey(asked.source);
  let list = await listLeads(db, now, tz, { ...options, ...(sourceKey === "" ? {} : { source: sourceKey }) });
  if (sourceKey !== "" && !list.sources.some((s) => s.key === sourceKey)) {
    sourceKey = "";
    list = await listLeads(db, now, tz, options);
  }
  const plain = asked.filter.value === "open" && asked.query === "" && sourceKey === "";

  const keep = new URLSearchParams();
  if (asked.filter.value !== "open") keep.set("status", asked.filter.value);
  if (sourceKey !== "") keep.set("source", sourceKey);
  if (asked.sort !== "next_task") keep.set("sort", asked.sort);
  const clearHref = keep.size === 0 ? "/leads" : `/leads?${keep.toString()}`;
  const clear = asked.query === "" ? "" : html`<p class="search-clear"><a href="${clearHref}">Clear search</a></p>`;

  let results: Html;
  if (list.total === 0 && plain) {
    results = empty("No leads yet. A lead is someone you plan to approach who hasn't asked for anything yet.");
  } else if (list.total === 0 && asked.query !== "") {
    results = html`${empty(`No leads match "${asked.query}".`, "Try part of a name, an email address, a phone number or a company.")}
${clear}`;
  } else if (list.total === 0) {
    results = empty("No leads in this view.", "Try another status or source.");
  } else {
    results = html`${clear}
<p class="lede">${countLine(list.items.length, list.total, asked.query)}</p>
<ul class="cards">${list.items.map((lead) => leadCard(lead, tz))}</ul>`;
  }
  return renderPage({
    title: asked.filter.title,
    description: asked.filter.description,
    current: "/leads",
    frame: ctx,
    body: html`<h1>Leads</h1>
${peopleSwitch("leads")}
${searchForm(asked, list.sources, sourceKey)}
${results}`,
  });
}
