// /contacts/<id>: one contact's details, custom fields, every deal of theirs, their open tasks and one timeline (the
// contact's own entries and their deals', newest first). Outside text is labelled exactly as on the deal page.
import { listFieldDefs } from "../../db/queries.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { type ContactDetail, contactDetail, type DealItem } from "../../services/read.ts";
import { formatLocal } from "../../time.ts";
import { type Html, html } from "../html.ts";
import type { PageContext } from "../context.ts";
import { renderPage } from "../layout.ts";
import { dealLink, empty, formatNumber, labelled, type Pair, pairs, section, tag, when } from "../parts.ts";
import type { FormContext } from "../forms.ts";
import { logForm } from "../log-form.ts";
import { customRows, outsideNote, STATUS, taskCard, timelineItem } from "../records.ts";
import { addTaskForm, type Subject } from "../task-forms.ts";
import { contactEditPath } from "./contact-edit.ts";
import { newDealPath } from "./deal-new.ts";

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
<p class="card-actions"><a href="${contactEditPath(contact.id)}">Edit details</a></p>
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
    html`${
      detail.deals.length === 0
        ? empty("No deals yet.")
        : html`<ul class="cards cards-single">${detail.deals.map(dealCard)}</ul>`
    }
${detail.contact.archived ? "" : html`<p class="section-action"><a href="${newDealPath(detail.contact.id)}">Add a deal</a></p>`}`,
  );
}

function tasksSection(detail: ContactDetail, now: Date, tz: string, form: FormContext, subject: Subject): Html {
  return section(
    "tasks-heading",
    "Open tasks",
    html`${
      detail.openTasks.length === 0
        ? empty("No open tasks.")
        : html`<ul class="cards cards-single">${detail.openTasks.map((task) => taskCard(task, now, tz, true, form))}</ul>`
    }
${addTaskForm(subject, form)}`,
  );
}

function timelineSection(detail: ContactDetail, form: FormContext, subject: Subject): Html {
  return section(
    "timeline-heading",
    "Timeline",
    html`${logForm(subject, form)}
${
    detail.timeline.length === 0
      ? empty("Nothing logged yet.", "Calls, emails and notes you log here or through your AI app show up here.")
      : html`<p class="section-note">${detail.timelineMore ? `Newest first. Showing the latest ${detail.timeline.length}.` : "Newest first."}</p>
<ol class="panel rows timeline">${detail.timeline.map((item) =>
          timelineItem(
            item,
            item.deal === null
              ? undefined
              : { id: item.deal.id, title: item.deal.title, outside: item.deal.untrusted_fields.includes("title"), archived: item.deal.archived },
          ),
        )}</ol>`
}`,
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
export async function contactPage(ctx: PageContext, id: string): Promise<string | null> {
  const { db, now } = ctx;
  const tz = await ownerTimezone(db);
  const detail = await contactDetail(db, id, tz, now);
  if (detail === null) return null;
  const defs = await listFieldDefs(db, { includeArchived: true });
  const labels = new Map(defs.filter((def) => def.entity === "contact").map((def) => [def.key, def.label]));
  const { contact } = detail;
  const outside = new Set(contact.untrusted_fields);
  const subject: Subject = { kind: "contact", id: contact.id };
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
    frame: ctx,
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
${tasksSection(detail, now, tz, ctx, subject)}
${timelineSection(detail, ctx, subject)}
</div>
</div>`,
  });
}
