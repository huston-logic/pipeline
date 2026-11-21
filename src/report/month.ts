// Calendar months for the "What it caught" report (decision 0032). A month is "YYYY-MM" and always means the owner's
// calendar: it starts and ends at the owner's midnight, so a late-evening call on the last day stays in its month.
import { localDate, zonedToUtc } from "../time.ts";

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** How many finished months the report page reaches back, counting from last month. */
export const MONTHS_BACK = 12;

/** "2026-11" shifted by n months (negative for earlier). */
export function addMonths(month: string, n: number): string {
  const match = MONTH.exec(month);
  if (!match) throw new RangeError(`"${month}" is not a YYYY-MM month.`);
  const index = Number(match[1]) * 12 + (Number(match[2]) - 1) + n;
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
}

export const thisMonth = (now: Date, tz: string): string => localDate(now, tz).slice(0, 7);

export const lastMonth = (now: Date, tz: string): string => addMonths(thisMonth(now, tz), -1);

/** The UTC instants where the month starts and where the next one starts, by the owner's midnights. */
export function monthBounds(month: string, tz: string): { start: Date; end: Date } {
  return { start: zonedToUtc(`${month}-01T00:00`, tz), end: zonedToUtc(`${addMonths(month, 1)}-01T00:00`, tz) };
}

const labels = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" });

/** "October 2026". */
export function monthLabel(month: string): string {
  const match = MONTH.exec(month);
  if (!match) throw new RangeError(`"${month}" is not a YYYY-MM month.`);
  return labels.format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)));
}

/**
 * The month a request asks for: last month unless `value` is exactly a finished month within MONTHS_BACK. Anything
 * else, a typo or something hostile, falls back to last month, and the value is never echoed.
 */
export function reportMonth(value: string | null, now: Date, tz: string): string {
  const latest = lastMonth(now, tz);
  if (value === null || !MONTH.test(value)) return latest;
  return value <= latest && value >= addMonths(latest, 1 - MONTHS_BACK) ? value : latest;
}

/** Whether a "YYYY-MM-DD" date is the 1st of its month. */
export const isFirstOfMonth = (date: string): boolean => date.endsWith("-01");
