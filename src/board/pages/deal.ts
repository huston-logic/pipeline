import type { StageRow } from "../../db/db.ts";
import { getDeal, listFieldDefs, listStages } from "../../db/queries.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { type DealBrief, getDealBrief } from "../../services/read.ts";
import { formatLocal } from "../../time.ts";
import { type Html, html } from "../html.ts";
import type { PageContext } from "../context.ts";
import type { FormContext } from "../forms.ts";
import { renderPage } from "../layout.ts";
import { moveForm, safeDealName } from "../move.ts";
import { contactHref, empty, formatNumber, labelled, type Pair, pairs, projectLink, section, tag, when } from "../parts.ts";
import { newProjectOfDealPath } from "../project-form.ts";
import { logForm } from "../log-form.ts";
import { askSection } from "../ask-claude.ts";
import { backToLeadsForm, offersBackToLeads } from "../lead-forms.ts";
import { reachActions } from "../reach.ts";
import { customRows, outsideNote, STATUS, taskCard, timelineItem } from "../records.ts";
import { addTaskForm, type Subject } from "../task-forms.ts";
import { startTimerForm } from "../timer-start.ts";
import { dealEditPath } from "./deal-edit.ts";

function contactSection(brief: DealBrief, labels: Map<string, string>, form: FormContext, subject: Subject): Html {
  const { contact } = brief;
  const outside = new Set(contact.untrusted_fields);
  const text = (name: string, key: string, value: string | null): Pair | null =>
    value === null || value === "" ? null : { name, value: labelled(value, outside.has(key)) };
  return section(
    "contact-heading",
    "Contact",
    html`<div class="card">
${pairs([
  text("Name", "name", contact.name),
  text("Email", "email", contact.email),
  text("Phone", "phone", contact.phone),
  text("Business", "business", contact.business),
  text("Source", "source", contact.source),
  text("Notes", "notes", contact.notes),
  ...customRows(contact.fields, labels, outside),
])}
${contact.archived ? html`<p class="note">This contact is archived.</p>` : ""}
${reachActions(contact, subject, form)}
<p class="card-actions"><a href="${contactHref(contact.id)}">Open the contact page</a></p>
</div>`,
  );
}

function dealSection(brief: DealBrief, labels: Map<string, string>, tz: string, stages: StageRow[], form: FormContext, backToLeads: boolean): Html {
  const { deal, stage } = brief;
  const name = safeDealName(deal.id, deal.title, deal.untrusted_fields.includes("title"));
  return section(
    "deal-heading",
    "Deal",
    html`<div class="card">
${pairs([
  { name: "Stage", value: stage.label },
  { name: "Status", value: STATUS[deal.status] },
  { name: "Value", value: deal.value === null ? "Not set" : formatNumber(deal.value) },
  { name: "In this stage since", value: when(deal.stageEnteredAt, formatLocal(deal.stageEnteredAt, tz)) },
  {
    name: "Last contact",
    value: deal.lastActivityAt === null ? "None logged yet" : when(deal.lastActivityAt, formatLocal(deal.lastActivityAt, tz)),
  },
  { name: "Added", value: when(deal.createdAt, formatLocal(deal.createdAt, tz)) },
  ...customRows(deal.fields, labels, new Set()),
])}
${deal.archived ? html`<p class="note">This deal is archived.</p>` : ""}
<p class="card-actions"><a href="${dealEditPath(deal.id)}">Edit deal</a></p>
${deal.archived ? "" : startTimerForm({ kind: "deal", id: deal.id }, form, name)}
${deal.archived ? "" : html`<div class="card-move">${moveForm({ id: deal.id, name, stageKey: stage.key }, stages, form)}</div>`}
${backToLeads ? html`<div class="card-return">${backToLeadsForm(deal.id, form)}</div>` : ""}
</div>`,
  );
}

/** Only a won deal that is not archived can start a project (decision 0055); the new-project page is a 404 otherwise. */
const canStartProject = (brief: DealBrief): boolean => brief.deal.status === "won" && !brief.deal.archived;

function startOffer(brief: DealBrief): Html | "" {
  if (brief.projects === undefined || brief.projects.length > 0 || !canStartProject(brief)) return "";
  return section(
    "start-project-heading",
    "Start a project?",
    html`<p>This deal is won. Start a project to track the work.</p>
<p class="section-action"><a href="${newProjectOfDealPath(brief.deal.id)}">Start a project</a></p>`,
  );
}

function projectsSection(brief: DealBrief): Html | "" {
  const { projects } = brief;
  if (projects === undefined || projects.length === 0) return "";
  return section(
    "projects-heading",
    "Projects",
    html`<ul class="cards cards-single">${projects.map(
      (project) => html`<li class="card">
<div class="card-head">
<h3 class="card-title">${projectLink(project.id, project.name, project.untrusted_fields.includes("name"))}</h3>
${tag(project.statusLabel)}
</div>
</li>`,
    )}</ul>
${canStartProject(brief) ? html`<p class="section-action"><a href="${newProjectOfDealPath(brief.deal.id)}">Start another project</a></p>` : ""}`,
  );
}

function nextSection(brief: DealBrief): Html {
  const edit = html`<p class="card-actions"><a href="${dealEditPath(brief.deal.id)}">${brief.next.step === null && brief.next.at === null ? "Set a next step" : "Change the next step"}</a></p>`;
  const { next, deal } = brief;
  const body =
    next.step === null && next.at === null
      ? html`${empty("No next step set.")}
${edit}`
      : html`<div class="card">
<p class="card-title">${next.step ?? "No step written down"}</p>
${pairs([
  next.at !== null &&
    next.atLocal !== null && {
      name: "Due",
      value: html`${when(next.at, next.atLocal)}${deal.overdue ? html` ${tag("Overdue", true)}` : ""}`,
    },
])}
${edit}
</div>`;
  return section("next-heading", "Next step", body);
}

async function tasksSection(brief: DealBrief, now: Date, tz: string, form: FormContext, subject: Subject): Promise<Html> {
  const cards = await Promise.all(brief.openTasks.map((task) => taskCard(task, now, tz, false, form)));
  return section(
    "tasks-heading",
    "Open tasks",
    html`${
      brief.openTasks.length === 0
        ? empty("No open tasks.")
        : html`<ul class="cards cards-single">${cards}</ul>`
    }
${addTaskForm(subject, form)}`,
  );
}

function timelineSection(brief: DealBrief, form: FormContext, subject: Subject): Html {
  return section(
    "timeline-heading",
    "Timeline",
    html`${logForm(subject, form)}
${
      brief.timeline.length === 0
        ? empty("Nothing logged yet.", "Calls, emails and notes you log here or through your AI app show up here.")
        : html`<p class="section-note">Newest first.</p>
<ol class="panel rows timeline">${brief.timeline.map((item) => timelineItem(item))}</ol>`
    }`,
  );
}

function hasOutsideText(brief: DealBrief): boolean {
  return (
    brief.deal.untrusted_fields.length > 0 ||
    brief.contact.untrusted_fields.length > 0 ||
    (brief.projects ?? []).some((project) => project.untrusted_fields.length > 0) ||
    brief.openTasks.some((task) => task.untrusted_fields.length > 0) ||
    brief.timeline.some((item) => item.untrusted_text !== null || item.untrusted_fields.length > 0)
  );
}

/** The pre-call view, or null when there is no deal with this id (the caller answers with the 404 page). */
export async function dealPage(ctx: PageContext, id: string): Promise<string | null> {
  const { db, now } = ctx;
  if ((await getDeal(db, id)) === null) return null;
  const tz = await ownerTimezone(db);
  const brief = await getDealBrief(db, id, tz, now);
  const defs = await listFieldDefs(db, { includeArchived: true });
  const labelsFor = (entity: "contact" | "deal") =>
    new Map(defs.filter((def) => def.entity === entity).map((def) => [def.key, def.label]));

  const titleOutside = brief.deal.untrusted_fields.includes("title");
  // The <title> and meta description can't show the label, so outside text never goes there.
  const name = titleOutside ? `Deal ${brief.deal.id}` : brief.deal.title;
  const note = hasOutsideText(brief) ? outsideNote() : "";
  const subject: Subject = { kind: "deal", id: brief.deal.id };
  return renderPage({
    title: name,
    description: `Before the call: contact, next step, open tasks and timeline for ${name}.`,
    current: `/deals/${brief.deal.id}`,
    frame: ctx,
    script: true,
    body: html`<p class="back"><a href="/pipeline">Back to the pipeline</a></p>
<h1>${labelled(brief.deal.title, titleOutside)}</h1>
<p class="lede deal-status">${tag(brief.stage.label)} <span>${STATUS[brief.deal.status]}</span></p>
${note}
<div class="deal-columns">
<div>
${contactSection(brief, labelsFor("contact"), ctx, subject)}
${dealSection(brief, labelsFor("deal"), tz, await listStages(db), ctx, await offersBackToLeads(db, brief.deal))}
${projectsSection(brief)}
</div>
<div>
${startOffer(brief)}
${nextSection(brief)}
${askSection(brief.deal.id)}
${await tasksSection(brief, now, tz, ctx, subject)}
${timelineSection(brief, ctx, subject)}
</div>
</div>`,
  });
}
