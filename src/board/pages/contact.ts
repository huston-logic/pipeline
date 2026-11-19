// /contacts/<id>: one contact's details, custom fields, every deal of theirs, their open tasks and one timeline (the
// contact's own entries and their deals', newest first). Outside text is labelled exactly as on the deal page.
import type { Db } from "../../db/db.ts";
import { listFieldDefs } from "../../db/queries.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { type ContactDetail, contactDetail, type DealItem } from "../../services/read.ts";
import { formatLocal } from "../../time.ts";
import { type Html, html } from "../html.ts";
import { type Look, renderPage } from "../layout.ts";
import { dealLink, empty, formatNumber, labelled, type Pair, pairs, section, tag, when } from "../parts.ts";
import { customRows, outsideNote, STATUS, taskCard, timelineItem } from "../records.ts";

function detailsSection(detail: ContactDetail, labels: Map<string, string>, tz: string): Html {
  const { contact } = detail;
  const outside = new Set(contact.untrusted_fields);
  const text = (name: string, key: string, value: string | null): Pair | null =>
    value === null || value.trim() === "" ? null : { name, value: labelled(value, outside.has(key)) };
  return section(
    "details-heading",
    "Details",
    html`<div class="card">
${pairs([
  text("Email", "email", contact.email),
  text("Phone", "phone", contact.phone),
  text("Company", "business", contact.business),
  text("Source", "source", contact.source),
  ...customRows(contact.fields, labels, outside),
  text("Notes", "notes", contact.notes),
  { name: "Added", value: when(contact.createdAt, formatLocal(contact.createdAt, tz)) },
])}
${contact.archived ? html`<p class="note">This contact is archived.</p>` : ""}
</div>`,
  );
}

function dealCard(deal: DealItem): Html {
  const closed = deal.status !== "open";
  return html`<li class="card">
<div class="card-head">
<h3 class="card-title">${dealLink(deal.id, deal.title, deal.untrusted_fields.includes("title"))}</h3>
${tag(deal.stageLabel)}
</div>
${pairs([
  deal.value !== null && { name: "Value", value: formatNumber(deal.value) },
  !closed && deal.nextStep !== null && { name: "Next step", value: deal.nextStep },
  !closed &&
    deal.nextAt !== null &&
    deal.nextAtLocal !== null && {
      name: "Next date",
      value: html`${when(deal.nextAt, deal.nextAtLocal)}${deal.overdue ? html` ${tag("Overdue", true)}` : ""}`,
    },
  // A closed stage's label usually says it already ("Won"); the status is shown when the owner renamed the stage.
  closed && STATUS[deal.status] !== deal.stageLabel && { name: "Status", value: STATUS[deal.status] },
])}
</li>`;
}

function dealsSection(detail: ContactDetail): Html {
  return section(
    "deals-heading",
    "Deals",
    detail.deals.length === 0
      ? empty("No deals yet.", "Ask your AI app to add one for this contact.")
      : html`<ul class="cards cards-single">${detail.deals.map(dealCard)}</ul>`,
  );
}

function tasksSection(detail: ContactDetail, now: Date, tz: string): Html {
  return section(
    "tasks-heading",
    "Open tasks",
    detail.openTasks.length === 0
      ? empty("No open tasks.")
      : html`<ul class="cards cards-single">${detail.openTasks.map((task) => taskCard(task, now, tz, true))}</ul>`,
  );
}

function timelineSection(detail: ContactDetail): Html {
  const deals = new Map(detail.deals.map((deal) => [deal.id, deal]));
  const onDeal = (dealId: string | null) => {
    const deal = dealId === null ? undefined : deals.get(dealId);
    return deal === undefined ? undefined : { id: deal.id, title: deal.title, outside: deal.untrusted_fields.includes("title") };
  };
  return section(
    "timeline-heading",
    "Timeline",
    detail.timeline.length === 0
      ? empty("Nothing logged yet.", "Calls, emails and notes you log through your AI app show up here.")
      : html`<p class="section-note">${detail.timelineMore ? `Newest first. Showing the latest ${detail.timeline.length}.` : "Newest first."}</p>
<ol class="panel rows timeline">${detail.timeline.map((item) => timelineItem(item, onDeal(item.dealId)))}</ol>`,
  );
}

function hasOutsideText(detail: ContactDetail): boolean {
  return (
    detail.contact.untrusted_fields.length > 0 ||
    detail.deals.some((deal) => deal.untrusted_fields.length > 0) ||
    detail.openTasks.some((task) => task.untrusted_fields.length > 0) ||
    detail.timeline.some((item) => item.untrusted_text !== null || item.untrusted_fields.length > 0)
  );
}

/** The contact page, or null when there is no contact with this id (the caller answers with the 404 page). */
export async function contactPage(db: Db, id: string, now: Date, look: Look): Promise<string | null> {
  const tz = await ownerTimezone(db);
  const detail = await contactDetail(db, id, tz, now);
  if (detail === null) return null;
  const defs = await listFieldDefs(db, { includeArchived: true });
  const labels = new Map(defs.filter((def) => def.entity === "contact").map((def) => [def.key, def.label]));
  const { contact } = detail;
  const outside = new Set(contact.untrusted_fields);
  // The <title> and meta description can't show the label, so outside text never goes there.
  const name = outside.has("name") ? `Contact ${contact.id}` : contact.name;
  const company =
    contact.business === null || contact.business.trim() === ""
      ? ""
      : html`<p class="lede">${labelled(contact.business, outside.has("business"))}</p>`;
  return renderPage({
    title: name,
    description: `Details, deals, open tasks and timeline for ${name}.`,
    current: `/contacts/${contact.id}`,
    look,
    body: html`<p class="back"><a href="/contacts">Back to contacts</a></p>
<h1>${labelled(contact.name, outside.has("name"))}</h1>
${company}
${hasOutsideText(detail) ? outsideNote() : ""}
<div class="detail-columns">
<div>
${detailsSection(detail, labels, tz)}
${dealsSection(detail)}
</div>
<div>
${tasksSection(detail, now, tz)}
${timelineSection(detail)}
</div>
</div>`,
  });
}
