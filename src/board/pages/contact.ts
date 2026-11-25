// /contacts/<id>: one contact's details, custom fields, every deal of theirs, their open tasks and one timeline (the
// contact's own entries and their deals', newest first). Outside text is labelled exactly as on the deal page. A lead's
// page adds the Lead section (status line, status menu, Qualify) and an Ask Claude intro (decision 0028).
import type { ContactRow } from "../../db/db.ts";
import { getContact, listFieldDefs } from "../../db/queries.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { type StatusLabels, statusLabels } from "../../services/status-labels.ts";
import { type ContactDetail, contactDetail, type DealItem } from "../../services/read.ts";
import { formatLocal } from "../../time.ts";
import { type Html, html } from "../html.ts";
import type { PageContext } from "../context.ts";
import { renderPage } from "../layout.ts";
import { listProjects, type ProjectItem } from "../../services/project-read.ts";
import { dealLink, empty, formatNumber, labelled, type Pair, pairs, projectLink, section, tag, when } from "../parts.ts";
import { newProjectOfContactPath } from "../project-form.ts";
import type { FormContext } from "../forms.ts";
import { logForm } from "../log-form.ts";
import { reachActions } from "../reach.ts";
import { customRows, outsideNote, STATUS, taskCard, timelineItem } from "../records.ts";
import { addTaskForm, type Subject } from "../task-forms.ts";
import { startTimerForm } from "../timer-start.ts";
import { leadAskSection } from "../ask-claude.ts";
import { campaignEmailsSection } from "../campaign-emails.ts";
import { qualifyPath, statusLine, statusMenu } from "../lead-forms.ts";
import { contactEditPath } from "./contact-edit.ts";
import { newDealPath } from "./deal-new.ts";
import { canQualify } from "./qualify.ts";

function detailsSection(detail: ContactDetail, labels: Map<string, string>, tz: string, form: FormContext, subject: Subject): Html {
  const { contact } = detail;
  const outside = new Set(contact.untrusted_fields);
  const text = (name: string, key: string, value: string | null): Pair | null =>
    value === null || value.trim() === "" ? null : { name, value: labelled(value, outside.has(key)) };
  return section(
    "details-heading",
    "Details",
    html`<div class="card">
${pairs([
  {
    name: "Person status",
    value: contact.subStatusLabel === null ? contact.personStatusLabel : `${contact.personStatusLabel} (${contact.subStatusLabel})`,
  },
  text("Email", "email", contact.email),
  text("Phone", "phone", contact.phone),
  text("Company", "business", contact.business),
  text("Source", "source", contact.source),
  ...customRows(contact.fields, labels, outside),
  text("Notes", "notes", contact.notes),
  { name: "Added", value: when(contact.createdAt, formatLocal(contact.createdAt, tz)) },
])}
${contact.archived ? html`<p class="note">This contact is archived.</p>` : ""}
${reachActions(contact, subject, form)}
<p class="card-actions"><a href="${contactEditPath(contact.id)}">Edit details</a></p>
${contact.archived ? "" : startTimerForm({ kind: "contact", id: contact.id }, form, outside.has("name") ? `contact ${contact.id}` : contact.name)}
</div>`,
  );
}

/**
 * The Lead section, only for someone with a lead status (decision 0022, invariant 4): the status line, and for an
 * unqualified lead who is not archived the status menu and Qualify. A Qualified person keeps the line as history.
 */
async function leadSection(contact: ContactRow, tz: string, form: FormContext, labels: StatusLabels): Promise<Html | ""> {
  if (contact.lead_status === null) return "";
  const line = statusLine(contact.lead_status, contact.lead_status_at, tz, labels);
  const controls = canQualify(contact)
    ? html`${await statusMenu(contact.id, contact.lead_status, form, labels)}
<p class="lead-qualify"><a class="button" href="${qualifyPath(contact.id)}">Qualify</a></p>`
    : "";
  return section("lead-heading", "Lead", html`<div class="card lead-card">
${line}
${controls}
</div>`);
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

function projectsSection(contact: ContactDetail["contact"], projects: ProjectItem[]): Html {
  return section(
    "projects-heading",
    "Projects",
    html`${
      projects.length === 0
        ? empty("No projects yet.")
        : html`<ul class="cards cards-single">${projects.map(
            (project) => html`<li class="card">
<div class="card-head">
<h3 class="card-title">${projectLink(project.id, project.name, project.untrusted_fields.includes("name"))}</h3>
${tag(project.statusLabel)}
</div>
</li>`,
          )}</ul>`
    }
${contact.archived ? "" : html`<p class="section-action"><a href="${newProjectOfContactPath(contact.id)}">Start a project</a></p>`}`,
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
  const row = await getContact(db, id);
  if (detail === null || row === null) return null;
  const defs = await listFieldDefs(db, { includeArchived: true });
  const labels = new Map(defs.filter((def) => def.entity === "contact").map((def) => [def.key, def.label]));
  const { contact } = detail;
  const outside = new Set(contact.untrusted_fields);
  const subject: Subject = { kind: "contact", id: contact.id };
  const projects = ctx.projects === true ? (await listProjects(db, { contact: contact.id })).items : null;
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
    script: true,
    body: html`${canQualify(row) ? html`<p class="back"><a href="/leads">Back to leads</a></p>` : html`<p class="back"><a href="/contacts">Back to contacts</a></p>`}
<h1>${labelled(contact.name, outside.has("name"))}</h1>
${company}
${hasOutsideText(detail) || (projects ?? []).some((project) => project.untrusted_fields.includes("name")) ? outsideNote() : ""}
<div class="detail-columns">
<div>
${await leadSection(row, tz, ctx, await statusLabels(db))}
${detailsSection(detail, labels, tz, ctx, subject)}
${await campaignEmailsSection(ctx, row, tz)}
${dealsSection(detail)}
${projects === null ? "" : projectsSection(contact, projects)}
</div>
<div>
${canQualify(row) ? leadAskSection(row.id) : ""}
${tasksSection(detail, now, tz, ctx, subject)}
${timelineSection(detail, ctx, subject)}
</div>
</div>`,
  });
}
