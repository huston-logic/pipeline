// /time (decision 0051): one week of time, Monday to Sunday in the owner's timezone, `?week=` picking another. The
// entries by day with an Edit link each, then the week's totals and its time by person and by deal; Add time; and the
// month's CSV. 404 while time tracking is off. Outside names are labelled or shown by id, like everywhere on the board.
import type { ContactRow, Db, DealRow } from "../../db/db.ts";
import { getSettings } from "../../db/queries.ts";
import { TIME_CSV_PATH } from "../../http/time-csv.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { formatDuration, formatMoney } from "../../services/time-format.ts";
import { listTime, periodOf, type TimeEntryView, type Total } from "../../services/time-read.ts";
import { addDays, localDate } from "../../time.ts";
import type { PageContext } from "../context.ts";
import { type Html, html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { contactHref, contactLink, dealHref, dealLink, empty, pairs, section } from "../parts.ts";
import { dataTable } from "../table.ts";
import { clock, dayHeading, weekHref, weekOf, weekRange } from "../time-week.ts";

export const TIME_PATH = "/time";

/** Rows of a table by id, one read (ids go through json_each). */
async function rowsByIds<T extends { id: string }>(db: Db, table: "contacts" | "deals", ids: (string | null)[]): Promise<Map<string, T>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const found = await db.prepare(`SELECT * FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(wanted)).all<T>();
  return new Map(found.results.map((row) => [row.id, row]));
}

const outsideIn = (row: { untrusted_fields: string }, field: string): boolean => row.untrusted_fields.includes(`"${field}"`);

type Links = { contacts: Map<string, ContactRow>; deals: Map<string, DealRow> };

/** Who an entry is for: its deal, else its person, else no one. Names from outside show by id with the From outside label. */
function forCell(entry: TimeEntryView, { contacts, deals }: Links): Html {
  const deal = entry.dealId === null ? undefined : deals.get(entry.dealId);
  if (deal !== undefined) return dealLink(deal.id, deal.title, outsideIn(deal, "title"));
  const contact = entry.contactId === null ? undefined : contacts.get(entry.contactId);
  if (contact !== undefined) return contactLink(contact.id, contact.name, outsideIn(contact, "name"));
  return html`No one`;
}

const amountText = (entry: TimeEntryView): string => {
  if (!entry.billable) return "Not billed";
  return entry.rate === null ? "No rate" : formatMoney(entry.amount);
};

function dayTable(date: string, entries: TimeEntryView[], links: Links, tz: string): Html {
  const minutes = entries.reduce((sum, entry) => sum + (entry.minutes ?? 0), 0);
  const heading = dayHeading(date);
  const table = dataTable({
    label: `Time on ${heading}`,
    caption: `Time entries on ${heading}`,
    rows: entries,
    columns: [
      { key: "time", header: "Time", cell: (entry) => `${clock(entry.startedAt, tz)} to ${entry.endedAt === null ? "now" : clock(entry.endedAt, tz)}` },
      { key: "duration", header: "Duration", cell: (entry) => formatDuration(entry.minutes ?? 0) },
      { key: "for", header: "For", cell: (entry) => forCell(entry, links) },
      { key: "type", header: "Work type", cell: (entry) => entry.workType ?? "None" },
      { key: "billable", header: "Billable", cell: (entry) => (entry.billable ? "Yes" : "No") },
      { key: "amount", header: "Amount", cell: amountText },
      {
        key: "edit",
        header: "Edit",
        cell: (entry) =>
          html`<a href="/time/${entry.id}/edit">Edit<span class="visually-hidden"> the time entry at ${clock(entry.startedAt, tz)} on ${heading}</span></a>`,
      },
    ],
  });
  return section(`day-${date}`, heading, html`<p class="section-note">${formatDuration(minutes)} in ${entries.length === 1 ? "1 entry" : `${entries.length} entries`}.</p>\n${table}`, "time-day");
}

function totalsTable(label: string, first: string, totals: Total[], href: (total: Total) => string | null): Html {
  return dataTable({
    label,
    caption: label,
    rows: totals,
    columns: [
      {
        key: "who",
        header: first,
        cell: (total) => {
          const to = href(total);
          return to === null ? total.label : html`<a href="${to}">${total.label}</a>`;
        },
      },
      { key: "time", header: "Time", cell: (total) => formatDuration(total.minutes) },
      { key: "billable", header: "Billable", cell: (total) => formatDuration(total.billableMinutes) },
      { key: "amount", header: "Amount", cell: (total) => formatMoney(total.amount) },
    ],
  });
}

export async function timePage(ctx: PageContext): Promise<string | null> {
  const { db, now } = ctx;
  if ((await getSettings(db)).time_tracking !== 1) return null;
  const tz = await ownerTimezone(db);
  const period = weekOf(ctx.query.get("week"), now, tz);
  const thisWeek = periodOf("this_week", now, tz);
  const isThis = period.from === thisWeek.from;
  const summary = await listTime(db, { period }, tz);
  const links: Links = {
    contacts: await rowsByIds<ContactRow>(db, "contacts", summary.entries.map((entry) => entry.contactId)),
    deals: await rowsByIds<DealRow>(db, "deals", summary.entries.map((entry) => entry.dealId)),
  };
  const days = new Map<string, TimeEntryView[]>();
  for (const entry of summary.entries) {
    const date = localDate(new Date(entry.startedAt), tz);
    days.set(date, [...(days.get(date) ?? []), entry]);
  }
  const range = weekRange(period);
  const month = localDate(now, tz).slice(0, 7);
  const label = isThis ? `this week, ${range}` : range;
  const nav = html`<nav class="week-nav" aria-label="Choose a week">
<a class="button button-quiet" href="${weekHref(addDays(period.from, -7), thisWeek.from)}">Previous week</a>
${isThis ? "" : html`<a class="button button-quiet" href="/time">This week</a>\n`}<a class="button button-quiet" href="${weekHref(addDays(period.from, 7), thisWeek.from)}">Next week</a>
</nav>`;
  const body = summary.entries.length === 0
    ? empty(`No time logged ${isThis ? "this week" : "that week"}.`, "Add time by hand, or start a timer from a person or a deal.")
    : html`${section(
        "totals-heading",
        "Totals",
        html`<div class="card">
${pairs([
  { name: "Total", value: formatDuration(summary.totalMinutes) },
  { name: "Billable", value: formatDuration(summary.billableMinutes) },
  { name: "Not billable", value: formatDuration(summary.totalMinutes - summary.billableMinutes) },
  { name: "Billable amount", value: formatMoney(summary.billableAmount) },
])}
</div>`,
      )}
${[...days.entries()].map(([date, entries]) => dayTable(date, entries, links, tz))}
${section("by-person", "By person", totalsTable("Time by person", "Person", summary.byPerson, (total) => (total.id === null ? null : contactHref(total.id))))}
${summary.byDeal.length === 0 ? "" : section("by-deal", "By deal", totalsTable("Time by deal", "Deal", summary.byDeal, (total) => (total.id === null ? null : dealHref(total.id))))}`;
  return renderPage({
    region: true,
    title: `Time, ${label}`,
    description: `Time entries and totals for ${isThis ? "this week" : "the week of"} ${range}, with Add time and the month's CSV.`,
    current: TIME_PATH,
    frame: ctx,
    body: html`<h1>Time</h1>
<p class="lede">${isThis ? "This week" : "Week"}: ${dayHeading(period.from)} to ${dayHeading(period.to)}.</p>
${nav}
<p class="page-action"><a class="button" href="/time/new">Add time</a><a class="button button-quiet" href="${TIME_CSV_PATH}?month=${month}">Download CSV for this month</a></p>
${body}
${section(
  "csv-heading",
  "Month CSV",
  html`<form class="month-form" method="get" action="${TIME_CSV_PATH}">
<div class="field">
<label for="time-month">Month</label>
<p class="field-hint" id="time-month-hint">A month like 2026-11.</p>
<input id="time-month" name="month" type="month" value="${month}" aria-describedby="time-month-hint">
</div>
<button class="button button-quiet" type="submit">Download CSV</button>
</form>`,
)}`,
  });
}

