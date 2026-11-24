// /timer/done?entry=<te id> (decision 0050): what stopping the timer saved, with links to the note and the next step task
// it made, and Ask Claude to turn the notes into updates. 404 while time tracking is off, or for an entry that is not
// a finished one.
import type { TimeEntryRow } from "../../db/db.ts";
import { getSettings } from "../../db/queries.ts";
import { isTimeEntryId } from "../../ids.ts";
import { contactById, dealById, ownerTimezone, timeEntryById, workTypeById } from "../../services/lookup.ts";
import { amountOf, formatDuration, formatMoney } from "../../services/time-format.ts";
import { formatLocal } from "../../time.ts";
import type { PageContext } from "../context.ts";
import { timerAskSection } from "../ask-claude.ts";
import { type Html, html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { contactHref, contactLink, dealHref, dealLink, pairs, section, when } from "../parts.ts";
import { timerState } from "../timer-bar.ts";

export const TIMER_DONE_PATH = "/timer/done";

type Subject = { href: string; link: Html } | null;

async function subjectOf(ctx: PageContext, entry: TimeEntryRow): Promise<Subject> {
  const { db } = ctx;
  const deal = entry.deal_id === null ? null : await dealById(db, entry.deal_id);
  if (deal !== null) return { href: dealHref(deal.id), link: dealLink(deal.id, deal.title, deal.untrusted_fields.includes("title")) };
  const contact = entry.contact_id === null ? null : await contactById(db, entry.contact_id);
  if (contact === null) return null;
  return { href: contactHref(contact.id), link: contactLink(contact.id, contact.name, contact.untrusted_fields.includes("name")) };
}

/** The "Next step" task this entry's stop added: made in the same moment, on the same person or deal. */
async function nextStepTaskId(ctx: PageContext, entry: TimeEntryRow): Promise<string | null> {
  const found = await ctx.db
    .prepare("SELECT id FROM tasks WHERE created_at = ? AND title LIKE 'Next step%' AND source = 'owner' AND IFNULL(deal_id, '') = ? AND IFNULL(contact_id, '') = ? LIMIT 1")
    .bind(entry.updated_at, entry.deal_id ?? "", entry.contact_id ?? "")
    .first<string>("id");
  return found;
}

export async function timerDonePage(ctx: PageContext): Promise<string | null> {
  const { db, now } = ctx;
  const settings = await getSettings(db);
  const id = ctx.query.get("entry") ?? "";
  if (settings.time_tracking !== 1 || !isTimeEntryId(id)) return null;
  const entry = await timeEntryById(db, id);
  if (entry === null || entry.minutes === null || entry.ended_at === null) return null;
  const tz = await ownerTimezone(db);
  const workType = entry.work_type_id === null ? null : await workTypeById(db, entry.work_type_id);
  const subject = await subjectOf(ctx, entry);
  const taskId = await nextStepTaskId(ctx, entry);
  const billable = entry.billable === 1;
  const { timer } = await timerState(db, now, settings);
  const base = subject?.href ?? "/";
  return renderPage({
    title: "Time saved",
    description: "The time you just saved, and what it made.",
    frame: { ...ctx, timer },
    body: html`<h1>Time saved</h1>
${section(
  "saved-heading",
  "This entry",
  html`<div class="card">
${pairs([
  { name: "Time", value: formatDuration(entry.minutes) },
  { name: "Work type", value: workType === null ? "None" : workType.name },
  { name: "Billable", value: billable ? "Yes" : "No" },
  billable && { name: "Rate", value: entry.rate === null ? "No rate" : `${formatMoney(entry.rate)}/h` },
  billable && entry.rate !== null && { name: "Amount", value: formatMoney(amountOf(entry.rate, entry.minutes)) },
  { name: "For", value: subject === null ? "No one" : subject.link },
  { name: "Started", value: when(entry.started_at, formatLocal(entry.started_at, tz)) },
  entry.notes !== null && { name: "Notes", value: entry.notes },
  entry.activity_id !== null && { name: "Note", value: html`<a href="${base}">On the timeline</a>` },
  taskId !== null && { name: "Task", value: html`<a href="${base}">Next step task</a>` },
])}
</div>`,
)}
${entry.notes === null ? "" : timerAskSection(entry.id, entry.activity_id)}
<p class="back-link"><a href="/">Back to Today</a></p>`,
  });
}
