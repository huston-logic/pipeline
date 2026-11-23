// Pieces the view pages share (decision 0042): the count line with the 200-row cap (decision 0020) and the cards. A
// name, company or title from outside is labelled and never a link's text (AGENTS.md).
import type { DealViewItem, PersonViewItem } from "../services/view-read.ts";
import { type Html, html } from "./html.ts";
import { contactLink, count, dealLink, formatNumber, labelled, pairs, tag, when } from "./parts.ts";

/** "3 people.", or "Showing the first 200 of 1,240 people, in this view's order." */
export function countLine(shown: number, total: number, one: string, many: string): string {
  if (shown < total) return `Showing the first ${formatNumber(shown)} of ${formatNumber(total)} ${many}, in this view's order.`;
  return `${count(total, one, many)}.`;
}

const dateOr = (iso: string | null, local: string | null, none: string): Html | string =>
  iso === null || local === null ? none : when(iso, local);

export function personCard(person: PersonViewItem): Html {
  const outside = new Set(person.untrusted_fields);
  const status = person.subStatusLabel === null ? person.personStatusLabel : `${person.personStatusLabel} (${person.subStatusLabel})`;
  return html`<li class="card">
<div class="card-head">
<h2 class="card-title">${contactLink(person.id, person.name, outside.has("name"))}</h2>
</div>
${pairs([
  person.business !== null && person.business.trim() !== "" && { name: "Company", value: labelled(person.business, outside.has("business")) },
  { name: "Person status", value: status },
  { name: "Last activity", value: dateOr(person.lastActivityAt, person.lastActivityAtLocal, "None logged yet") },
  { name: "Next task", value: dateOr(person.nextTaskAt, person.nextTaskAtLocal, "No task") },
])}
</li>`;
}

export function dealCard(deal: DealViewItem): Html {
  const has = (key: "title" | "contactName") => deal.untrusted_fields.includes(key);
  return html`<li class="card">
<div class="card-head">
<h2 class="card-title">${dealLink(deal.id, deal.title, has("title"))}</h2>
${deal.overdue ? tag("Overdue", true) : ""}
</div>
${pairs([
  { name: "Contact", value: labelled(deal.contactName, has("contactName")) },
  { name: "Stage", value: deal.stageLabel },
  deal.value !== null && { name: "Value", value: formatNumber(deal.value) },
  { name: "Next date", value: dateOr(deal.nextAt, deal.nextAtLocal, "None set") },
  { name: "In this stage", value: count(deal.daysInStage, "day") },
])}
</li>`;
}
