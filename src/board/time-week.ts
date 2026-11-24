// Weeks and clock times for the time pages (decision 0051): a week is Monday to Sunday in the owner's timezone, picked by
// `?week=<a date>`; a date in the middle of a week shows that week, and anything that is not a real date shows this one.
import { type Period, periodOf } from "../services/time-read.ts";
import { addDays } from "../time.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 0 for Monday to 6 for Sunday. */
const weekdayOf = (date: string): number => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;

/** The Monday of the week a local date is in. */
export const mondayOf = (date: string): string => addDays(date, -weekdayOf(date));

/** The week of `?week=`, or this week when it is missing or not a real date. */
export function weekOf(value: string | null, now: Date, tz: string): Period {
  const today = periodOf("this_week", now, tz);
  if (value === null || !DATE.test(value)) return today;
  try {
    const from = mondayOf(value);
    return { from, to: addDays(from, 6) };
  } catch {
    return today;
  }
}

const dayFormat = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" });
const shortFormat = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });

const atNoon = (date: string): Date => new Date(`${date}T12:00:00Z`);

/** "Monday, Nov 23". */
export const dayHeading = (date: string): string => dayFormat.format(atNoon(date));

/** "Nov 23". */
export const shortDay = (date: string): string => shortFormat.format(atNoon(date));

/** "Nov 16 to Nov 22". */
export const weekRange = (period: Period): string => `${shortDay(period.from)} to ${shortDay(period.to)}`;

const clocks = new Map<string, Intl.DateTimeFormat>();

/** "9:00 AM" in the timezone. */
export function clock(at: string, tz: string): string {
  let format = clocks.get(tz);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true });
    clocks.set(tz, format);
  }
  return format.format(new Date(at));
}

/** The address of a week: this week is plain /time. */
export const weekHref = (monday: string, thisMonday: string): string => (monday === thisMonday ? "/time" : `/time?week=${monday}`);
