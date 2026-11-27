// Pieces the deal page and the contact page share: custom field rows, task cards, timeline entries and the note that
// explains the "From outside" label. Outside text is labelled and never a link's text (see parts.ts).
import type { ActivityType, Actor, DealStatus } from "../db/db.ts";
import type { TaskItem, TimelineItem } from "../services/read.ts";
import type { FormContext } from "./forms.ts";
import { type Html, html } from "./html.ts";
import { type RowTask, taskRows } from "./task-row.ts";
import { dealLink, labelled, OUTSIDE_LABEL, outsideLabel, type Pair, projectLink, tag, when } from "./parts.ts";

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
 * A deal's or a person's open tasks as rows (task-row.ts). The page's own record is left out of each row: a deal page
 * shows no "belongs" and no link back, a person page names the project or deal a task is on.
 */
export function openTaskRows(tasks: TaskItem[], page: "deal" | "contact", now: Date, tz: string, form: FormContext): Promise<Html> {
  const rows: RowTask[] = tasks.map((task) => ({
    ...task,
    ...(page === "deal" ? { dealId: null, dealTitle: null, contactId: null, contactName: null } : { contactId: null, contactName: null }),
    level: 1,
    onProject: false,
  }));
  return taskRows(rows, { now, tz, showBelongs: page === "contact" }, form);
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
