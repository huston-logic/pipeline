// Pieces the deal page and the contact page share: custom field rows, task cards, timeline entries and the note that
// explains the "From outside" label. Outside text is labelled and never a link's text (see parts.ts).
import type { ActivityType, Actor, DealStatus } from "../db/db.ts";
import type { TaskItem, TimelineItem } from "../services/read.ts";
import { formatLocal } from "../time.ts";
import type { FormContext } from "./forms.ts";
import { type Html, html } from "./html.ts";
import { descriptionLine, taskActions } from "./task-forms.ts";
import { dealLink, labelled, OUTSIDE_LABEL, outsideLabel, type Pair, pairs, projectLink, tag, when } from "./parts.ts";

export const STATUS: Record<DealStatus, string> = { open: "Open", won: "Won", lost: "Lost", not_now: "Not now" };

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
export function customRows(fields: Record<string, unknown>, labels: Map<string, string>, outside: Set<string>): Pair[] {
  return Object.entries(fields).map(([key, value]) => ({
    name: labels.get(key) ?? key,
    value: labelled(fieldValue(value), outside.has(key) || outside.has(`fields.${key}`)),
  }));
}

/**
 * A task as a card. `showDeal` adds a link to its deal, for pages that list more than one deal's tasks; `form` adds
 * Done and Snooze. A task on a project always names it, except on the project's own page (`onProjectPage`).
 */
export function taskCard(task: TaskItem, now: Date, tz: string, showDeal = false, form?: FormContext, onProjectPage = false): Html {
  const snoozed = task.snoozedUntil !== null && task.snoozedUntil > now.toISOString() ? task.snoozedUntil : null;
  const outside = task.untrusted_fields;
  return html`<li class="card">
<div class="card-head">
<h3 class="card-title">${labelled(task.title, outside.includes("title"))}</h3>
${snoozed !== null ? tag("Snoozed") : ""}
</div>
${pairs([
  { name: "Due", value: task.dueAt !== null && task.dueAtLocal !== null ? when(task.dueAt, task.dueAtLocal) : "No due date" },
  snoozed !== null && { name: "Snoozed until", value: when(snoozed, formatLocal(snoozed, tz)) },
  !onProjectPage &&
    task.projectId !== null &&
    task.projectName !== null && { name: "Project", value: projectLink(task.projectId, task.projectName, outside.includes("projectName")) },
  showDeal &&
    task.dealId !== null &&
    task.dealTitle !== null && { name: "Deal", value: dealLink(task.dealId, task.dealTitle, outside.includes("dealTitle")) },
  task.source !== "owner" && { name: "Added by", value: `rule ${task.source}` },
])}
${descriptionLine(task)}
${form === undefined ? "" : taskActions(task, form, tz)}
</li>`;
}

/** One timeline entry. `deal` adds a line linking the deal it is on, for the contact page (tagged when archived). */
export function timelineItem(
  item: TimelineItem,
  deal?: { id: string; title: string; outside: boolean; archived?: boolean },
  project?: { id: string; name: string; outside: boolean },
): Html {
  return html`<li>
<p class="row-head">${tag(ACTIVITY[item.type])} ${when(item.occurredAt, item.occurredAtLocal)} <span class="row-by">Logged by ${ACTOR[item.actor]}</span></p>
<p class="row-text">${labelled(item.summary, item.untrusted_fields.includes("summary"))}</p>
${deal === undefined ? "" : html`<p class="row-deal">On ${dealLink(deal.id, deal.title, deal.outside)}${deal.archived ? html` ${tag("Archived")}` : ""}</p>`}
${project === undefined ? "" : html`<p class="row-deal">On project ${projectLink(project.id, project.name, project.outside)}</p>`}
${
  item.untrusted_text === null
    ? ""
    : html`<div class="outside-block"><p class="outside-head">${outsideLabel()} Message as received</p><p class="outside-text">${item.untrusted_text}</p></div>`
}
</li>`;
}

/** Shown once near the top of a page that has outside text on it. */
export const outsideNote = (): Html =>
  html`<p class="note">Text marked ${OUTSIDE_LABEL} came from a website form or an import, not from you or your AI app. It is shown exactly as received.</p>`;
