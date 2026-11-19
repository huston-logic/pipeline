import type { ActivityType, Actor, Db, DealStatus } from "../../db/db.ts";
import { getDeal, listFieldDefs } from "../../db/queries.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { type DealBrief, getDealBrief, type TaskItem, type TimelineItem } from "../../services/read.ts";
import { formatLocal } from "../../time.ts";
import { type Html, html } from "../html.ts";
import { type Look, renderPage } from "../layout.ts";
import { empty, formatNumber, labelled, OUTSIDE_LABEL, outsideLabel, type Pair, pairs, section, tag, when } from "../parts.ts";

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

function fieldValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Custom field values with their labels; a value is outside text when its key is listed in `outside`. */
function customRows(fields: Record<string, unknown>, labels: Map<string, string>, outside: Set<string>): Pair[] {
  return Object.entries(fields).map(([key, value]) => ({
    name: labels.get(key) ?? key,
    value: labelled(fieldValue(value), outside.has(key) || outside.has(`fields.${key}`)),
  }));
}

function contactSection(brief: DealBrief, labels: Map<string, string>): Html {
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
</div>`,
  );
}

function dealSection(brief: DealBrief, labels: Map<string, string>, tz: string): Html {
  const { deal, stage } = brief;
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
</div>`,
  );
}

function nextSection(brief: DealBrief): Html {
  const { next, deal } = brief;
  const body =
    next.step === null && next.at === null
      ? empty("No next step set.", "Ask your AI app to set one, with a date if you have one.")
      : html`<div class="card">
<p class="card-title">${next.step ?? "No step written down"}</p>
${pairs([
  next.at !== null &&
    next.atLocal !== null && {
      name: "Due",
      value: html`${when(next.at, next.atLocal)}${deal.overdue ? html` ${tag("Overdue", true)}` : ""}`,
    },
])}
</div>`;
  return section("next-heading", "Next step", body);
}

function taskCard(task: TaskItem, now: Date, tz: string): Html {
  const snoozed = task.snoozedUntil !== null && task.snoozedUntil > now.toISOString() ? task.snoozedUntil : null;
  return html`<li class="card">
<div class="card-head">
<h3 class="card-title">${labelled(task.title, task.untrusted_fields.includes("title"))}</h3>
${snoozed !== null ? tag("Snoozed") : ""}
</div>
${pairs([
  { name: "Due", value: task.dueAt !== null && task.dueAtLocal !== null ? when(task.dueAt, task.dueAtLocal) : "No due date" },
  snoozed !== null && { name: "Snoozed until", value: when(snoozed, formatLocal(snoozed, tz)) },
  task.source !== "owner" && { name: "Added by", value: `rule ${task.source}` },
])}
</li>`;
}

function tasksSection(brief: DealBrief, now: Date, tz: string): Html {
  return section(
    "tasks-heading",
    "Open tasks",
    brief.openTasks.length === 0
      ? empty("No open tasks.")
      : html`<ul class="cards cards-single">${brief.openTasks.map((task) => taskCard(task, now, tz))}</ul>`,
  );
}

function timelineItem(item: TimelineItem): Html {
  return html`<li>
<p class="row-head">${tag(ACTIVITY[item.type])} ${when(item.occurredAt, item.occurredAtLocal)} <span class="row-by">Logged by ${ACTOR[item.actor]}</span></p>
<p class="row-text">${labelled(item.summary, item.untrusted_fields.includes("summary"))}</p>
${
  item.untrusted_text === null
    ? ""
    : html`<div class="outside-block"><p class="outside-head">${outsideLabel()} Message as received</p><p class="outside-text">${item.untrusted_text}</p></div>`
}
</li>`;
}

function timelineSection(brief: DealBrief): Html {
  return section(
    "timeline-heading",
    "Timeline",
    brief.timeline.length === 0
      ? empty("Nothing logged yet.", "Calls, emails and notes you log through your AI app show up here.")
      : html`<p class="section-note">Newest first.</p>
<ol class="panel rows timeline">${brief.timeline.map(timelineItem)}</ol>`,
  );
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
export async function dealPage(db: Db, id: string, now: Date, look: Look): Promise<string | null> {
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
    title: name,
    description: `Before the call: contact, next step, open tasks and timeline for ${name}.`,
    current: `/deals/${brief.deal.id}`,
    look,
    body: html`<p class="back"><a href="/pipeline">Back to the pipeline</a></p>
<h1>${labelled(brief.deal.title, titleOutside)}</h1>
<p class="lede deal-status">${tag(brief.stage.label)} <span>${STATUS[brief.deal.status]}</span></p>
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
