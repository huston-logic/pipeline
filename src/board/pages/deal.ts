import type { ActivityType, Actor, Db, DealStatus } from "../../db/db.ts";
import { getDeal, listFieldDefs } from "../../db/queries.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { type DealBrief, getDealBrief, type TaskItem, type TimelineItem } from "../../services/read.ts";
import { formatLocal } from "../../time.ts";
import { type Html, html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { empty, fact, formatNumber, labelled, meta, OUTSIDE_LABEL, outsideLabel, when } from "../parts.ts";

const STATUS: Record<DealStatus, string> = { open: "Open", won: "Won", lost: "Lost", not_now: "Not now" };

const ACTIVITY: Record<ActivityType, string> = {
  form: "Form",
  email: "Email",
  call: "Call",
  meeting: "Meeting",
  note: "Note",
  stage_change: "Stage change",
  system: "System",
};

const ACTOR: Record<Actor, string> = { owner: "you", ai: "your AI app", system: "the system" };

type Row = { name: string; value: Html | string };

function facts(rows: Row[]): Html {
  return html`<dl class="facts">${rows.map((row) => html`<div><dt>${row.name}</dt><dd>${row.value}</dd></div>`)}</dl>`;
}

function fieldValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Custom field values with their labels; a value is outside text when its key is listed in `outside`. */
function customRows(fields: Record<string, unknown>, labels: Map<string, string>, outside: Set<string>): Row[] {
  return Object.entries(fields).map(([key, value]) => ({
    name: labels.get(key) ?? key,
    value: labelled(fieldValue(value), outside.has(key) || outside.has(`fields.${key}`)),
  }));
}

function contactSection(brief: DealBrief, labels: Map<string, string>): Html {
  const { contact } = brief;
  const outside = new Set(contact.untrusted_fields);
  const text = (name: string, key: string, value: string | null): Row[] =>
    value === null || value === "" ? [] : [{ name, value: labelled(value, outside.has(key)) }];
  const rows = [
    ...text("Name", "name", contact.name),
    ...text("Email", "email", contact.email),
    ...text("Phone", "phone", contact.phone),
    ...text("Business", "business", contact.business),
    ...text("Source", "source", contact.source),
    ...text("Notes", "notes", contact.notes),
    ...customRows(contact.fields, labels, outside),
  ];
  return html`<section aria-labelledby="contact-heading">
<h2 id="contact-heading">Contact</h2>
${facts(rows)}
${contact.archived ? html`<p class="note">This contact is archived.</p>` : ""}
</section>`;
}

function dealSection(brief: DealBrief, labels: Map<string, string>, tz: string): Html {
  const { deal, stage } = brief;
  const rows: Row[] = [
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
  ];
  return html`<section aria-labelledby="deal-heading">
<h2 id="deal-heading">Deal</h2>
${facts(rows)}
${deal.archived ? html`<p class="note">This deal is archived.</p>` : ""}
</section>`;
}

function nextSection(brief: DealBrief): Html {
  const { next, deal } = brief;
  const body =
    next.step === null && next.at === null
      ? empty("No next step set.")
      : html`<p class="item-title">${next.step ?? "No step written down"}</p>
${meta([
  next.at !== null &&
    next.atLocal !== null &&
    fact("Due", html`${when(next.at, next.atLocal)}${deal.overdue ? html` <span class="flag">Overdue</span>` : ""}`),
])}`;
  return html`<section aria-labelledby="next-heading">
<h2 id="next-heading">Next step</h2>
${body}
</section>`;
}

function taskItem(task: TaskItem, now: Date, tz: string): Html {
  const snoozed = task.snoozedUntil !== null && task.snoozedUntil > now.toISOString() ? task.snoozedUntil : null;
  return html`<li>
<p class="item-title">${labelled(task.title, task.untrusted_fields.includes("title"))}</p>
${meta([
  fact("Due", task.dueAt !== null && task.dueAtLocal !== null ? when(task.dueAt, task.dueAtLocal) : "No due date"),
  snoozed !== null && fact("Snoozed until", when(snoozed, formatLocal(snoozed, tz))),
  task.source !== "owner" && fact("Added by", `rule ${task.source}`),
])}
</li>`;
}

function tasksSection(brief: DealBrief, now: Date, tz: string): Html {
  return html`<section aria-labelledby="tasks-heading">
<h2 id="tasks-heading">Open tasks</h2>
${
  brief.openTasks.length === 0
    ? empty("No open tasks.")
    : html`<ul class="items">${brief.openTasks.map((task) => taskItem(task, now, tz))}</ul>`
}
</section>`;
}

function timelineItem(item: TimelineItem): Html {
  return html`<li>
${meta([fact("When", when(item.occurredAt, item.occurredAtLocal)), fact("Type", ACTIVITY[item.type]), fact("Logged by", ACTOR[item.actor])])}
<p class="item-title">${labelled(item.summary, item.untrusted_fields.includes("summary"))}</p>
${
  item.untrusted_text === null
    ? ""
    : html`<div class="outside-block"><p class="outside-head">${outsideLabel()} Message as received</p><p class="outside-text">${item.untrusted_text}</p></div>`
}
</li>`;
}

function timelineSection(brief: DealBrief): Html {
  return html`<section aria-labelledby="timeline-heading">
<h2 id="timeline-heading">Timeline</h2>
${
  brief.timeline.length === 0
    ? empty("Nothing logged yet.")
    : html`<p class="section-note">Newest first.</p><ol class="items timeline">${brief.timeline.map(timelineItem)}</ol>`
}
</section>`;
}

function hasOutsideText(brief: DealBrief): boolean {
  return (
    brief.deal.untrusted_fields.length > 0 ||
    brief.contact.untrusted_fields.length > 0 ||
    brief.openTasks.some((task) => task.untrusted_fields.length > 0) ||
    brief.timeline.some((item) => item.untrusted_text !== null || item.untrusted_fields.length > 0)
  );
}

/** The pre-call view, or null when there is no deal with this id (the caller answers with the 404 page). */
export async function dealPage(db: Db, id: string, now: Date): Promise<string | null> {
  if ((await getDeal(db, id)) === null) return null;
  const tz = await ownerTimezone(db);
  const brief = await getDealBrief(db, id, tz, now);
  const defs = await listFieldDefs(db, { includeArchived: true });
  const labelsFor = (entity: "contact" | "deal") =>
    new Map(defs.filter((def) => def.entity === entity).map((def) => [def.key, def.label]));

  const titleOutside = brief.deal.untrusted_fields.includes("title");
  // The <title> and meta description can't show the label, so outside text never goes there.
  const name = titleOutside ? `Deal ${brief.deal.id}` : brief.deal.title;
  const note = hasOutsideText(brief)
    ? html`<p class="note">Text marked ${OUTSIDE_LABEL} came from a website form or an import, not from you or your AI app. It is shown exactly as received.</p>`
    : "";
  return renderPage({
    title: `${name} · Pipeline`,
    description: `Before the call: contact, next step, open tasks and timeline for ${name}.`,
    body: html`<p class="back"><a href="/">Back to the board</a></p>
<h1>${labelled(brief.deal.title, titleOutside)}</h1>
<p class="lede">${brief.stage.label}, ${STATUS[brief.deal.status].toLowerCase()}.</p>
${note}
<div class="deal-columns">
<div>
${contactSection(brief, labelsFor("contact"))}
${dealSection(brief, labelsFor("deal"), tz)}
</div>
<div>
${nextSection(brief)}
${tasksSection(brief, now, tz)}
${timelineSection(brief)}
</div>
</div>`,
  });
}
