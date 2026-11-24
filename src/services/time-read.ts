// Reading time (decision 0049): the entries of a period in the owner's timezone with their totals, by person and by
// deal, billable and not, and one row per client for a month. Amounts are worked out here (rate x minutes / 60, in
// cents) and never stored. A running timer is not an entry yet and archived entries never count. Outside names are
// shown by id (labels.ts).
import type { ContactRow, Db, DealRow, TimeEntryRow, WorkTypeRow } from "../db/db.ts";
import { addDays, dayBoundsUtc, localDate } from "../time.ts";
import { short } from "./describe.ts";
import { UserError } from "./errors.ts";
import { contactName, dealTitle } from "./labels.ts";
import { findContact, findDeal, parseStringArray } from "./lookup.ts";
import { requireTimeTracking } from "./settings.ts";
import { amountOf, toCents } from "./time-format.ts";

/** Local dates, both included. */
export type Period = { from: string; to: string };

export const PERIOD_NAMES = ["this_week", "last_week", "this_month", "last_month"] as const;
export type PeriodName = (typeof PERIOD_NAMES)[number];

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 0 for Monday to 6 for Sunday. */
const weekdayOf = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;

const monthStart = (date: string) => `${date.slice(0, 7)}-01`;

function nextMonthStart(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
}

const monthOf = (start: string): Period => ({ from: start, to: addDays(nextMonthStart(start), -1) });

/** A named period around `now` in the timezone. Weeks start on Monday. */
export function periodOf(name: PeriodName, now: Date, tz: string): Period {
  const today = localDate(now, tz);
  const monday = addDays(today, -weekdayOf(today));
  switch (name) {
    case "this_week":
      return { from: monday, to: addDays(monday, 6) };
    case "last_week":
      return { from: addDays(monday, -7), to: addDays(monday, -1) };
    case "this_month":
      return monthOf(monthStart(today));
    case "last_month":
      return monthOf(monthStart(addDays(monthStart(today), -1)));
  }
}

/** The period checked: two real dates, from not after to. */
export function checkPeriod(period: Period): Period {
  for (const date of [period.from, period.to]) {
    let valid = DATE.test(date);
    if (valid) {
      try {
        addDays(date, 0);
      } catch {
        valid = false;
      }
    }
    if (!valid) throw new UserError(`"${short(date, 20)}" isn't a date I can read. Use YYYY-MM-DD, for example 2026-11-16.`);
  }
  if (period.from > period.to) throw new UserError("The period's from date is after its to date. Give from first.");
  return period;
}

export interface TimeEntryView {
  id: string;
  startedAt: string;
  /** Null for the running timer. */
  endedAt: string | null;
  minutes: number | null;
  workTypeId: string | null;
  workType: string | null;
  billable: boolean;
  rate: number | null;
  /** rate x minutes / 60 in cents; 0 when not billable or with no rate. */
  amount: number;
  contactId: string | null;
  contact: string | null;
  dealId: string | null;
  deal: string | null;
  taskId: string | null;
  notes: string | null;
  untrusted_fields: string[];
}

export interface Total {
  /** The person's or deal's id; null for time of no one's. */
  id: string | null;
  label: string;
  minutes: number;
  billableMinutes: number;
  amount: number;
}

export interface TimeSummary {
  entries: TimeEntryView[];
  totalMinutes: number;
  billableMinutes: number;
  billableAmount: number;
  byPerson: Total[];
  byDeal: Total[];
}

export interface ClientMonthRow {
  contactId: string | null;
  contact: string;
  entries: number;
  minutes: number;
  billableMinutes: number;
  amount: number;
}

const NO_PERSON = "No person";

/** Rows of a table by id, one read (ids go through json_each). */
async function byIds<T extends { id: string }>(db: Db, table: "contacts" | "deals" | "work_types", ids: (string | null)[]): Promise<Map<string, T>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const found = await db.prepare(`SELECT * FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(wanted)).all<T>();
  return new Map(found.results.map((row) => [row.id, row]));
}

/** The entries as read items, with their labels. */
export async function entryViews(db: Db, rows: readonly TimeEntryRow[]): Promise<TimeEntryView[]> {
  const contacts = await byIds<ContactRow>(db, "contacts", rows.map((row) => row.contact_id));
  const deals = await byIds<DealRow>(db, "deals", rows.map((row) => row.deal_id));
  const types = await byIds<WorkTypeRow>(db, "work_types", rows.map((row) => row.work_type_id));
  return rows.map((row) => {
    const contact = row.contact_id === null ? undefined : contacts.get(row.contact_id);
    const deal = row.deal_id === null ? undefined : deals.get(row.deal_id);
    const billable = row.billable === 1;
    return {
      id: row.id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      minutes: row.minutes,
      workTypeId: row.work_type_id,
      workType: row.work_type_id === null ? null : (types.get(row.work_type_id)?.name ?? null),
      billable,
      rate: row.rate,
      amount: billable && row.minutes !== null ? amountOf(row.rate, row.minutes) : 0,
      contactId: row.contact_id,
      contact: contact === undefined ? null : contactName(contact),
      dealId: row.deal_id,
      deal: deal === undefined ? null : dealTitle(deal),
      taskId: row.task_id,
      notes: row.notes,
      untrusted_fields: parseStringArray(row.untrusted_fields),
    };
  });
}

/** Totals grouped by a key, most minutes first; the group of no one's (null) last. */
function totals(entries: readonly TimeEntryView[], key: (e: TimeEntryView) => { id: string | null; label: string } | null): Total[] {
  const groups = new Map<string | null, Total>();
  for (const entry of entries) {
    const group = key(entry);
    if (group === null) continue;
    const total = groups.get(group.id) ?? { id: group.id, label: group.label, minutes: 0, billableMinutes: 0, amount: 0 };
    total.minutes += entry.minutes ?? 0;
    if (entry.billable) total.billableMinutes += entry.minutes ?? 0;
    total.amount = toCents(total.amount + entry.amount);
    groups.set(group.id, total);
  }
  return [...groups.values()].sort(
    (a, b) => Number(a.id === null) - Number(b.id === null) || b.minutes - a.minutes || a.label.localeCompare(b.label),
  );
}

const person = (entry: TimeEntryView) => ({ id: entry.contactId, label: entry.contact ?? NO_PERSON });

async function finishedEntries(db: Db, period: Period, tz: string, where: { contactId?: string; dealId?: string } = {}): Promise<TimeEntryRow[]> {
  const start = dayBoundsUtc(period.from, tz).start.toISOString();
  const end = dayBoundsUtc(period.to, tz).end.toISOString();
  const found = await db
    .prepare(
      `SELECT * FROM time_entries WHERE archived = 0 AND ended_at IS NOT NULL AND started_at >= ? AND started_at < ?
       AND (? IS NULL OR contact_id = ?) AND (? IS NULL OR deal_id = ?) ORDER BY started_at, id`,
    )
    .bind(start, end, where.contactId ?? null, where.contactId ?? null, where.dealId ?? null, where.dealId ?? null)
    .all<TimeEntryRow>();
  return found.results;
}

/** The finished entries that started in the period (the owner's local dates), oldest first, with their totals. */
export async function listTime(db: Db, filter: { period: Period; contact?: string; deal?: string }, tz: string): Promise<TimeSummary> {
  await requireTimeTracking(db);
  const period = checkPeriod(filter.period);
  const contactId = filter.contact === undefined ? undefined : (await findContact(db, filter.contact)).id;
  const dealId = filter.deal === undefined ? undefined : (await findDeal(db, filter.deal)).id;
  const entries = await entryViews(db, await finishedEntries(db, period, tz, { contactId, dealId }));
  const minutes = (list: TimeEntryView[]) => list.reduce((sum, entry) => sum + (entry.minutes ?? 0), 0);
  const billable = entries.filter((entry) => entry.billable);
  return {
    entries,
    totalMinutes: minutes(entries),
    billableMinutes: minutes(billable),
    billableAmount: toCents(billable.reduce((sum, entry) => sum + entry.amount, 0)),
    byPerson: totals(entries, person),
    byDeal: totals(entries, (entry) => (entry.dealId === null ? null : { id: entry.dealId, label: entry.deal ?? `deal ${entry.dealId}` })),
  };
}

/** One row per client (the entry's person) for a month, "YYYY-MM": most minutes first, time of no one's last. */
export async function timeByClientMonth(db: Db, month: string, tz: string): Promise<ClientMonthRow[]> {
  await requireTimeTracking(db);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new UserError(`"${short(month, 20)}" isn't a month I can read. Use YYYY-MM, for example 2026-11.`);
  }
  const entries = await entryViews(db, await finishedEntries(db, monthOf(`${month}-01`), tz));
  const counts = new Map<string | null, number>();
  for (const entry of entries) counts.set(entry.contactId, (counts.get(entry.contactId) ?? 0) + 1);
  return totals(entries, person).map((total) => ({
    contactId: total.id,
    contact: total.label,
    entries: counts.get(total.id) ?? 0,
    minutes: total.minutes,
    billableMinutes: total.billableMinutes,
    amount: total.amount,
  }));
}
