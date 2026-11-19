// The snooze presets on a task card (decision 0018): wall-clock times in the owner's timezone, as the
// "YYYY-MM-DDTHH:mm" the services read, so a clock change between now and then can't shift them.
import { addDays, localDate } from "../time.ts";

export const MORNING = "09:00";

export type SnoozePresets = {
  /** 9:00 tomorrow. */
  tomorrow: string;
  /** 9:00 on the next Monday (a week from today when today is Monday). */
  nextWeek: string;
};

/** 0 for Sunday … 6 for Saturday, of a "YYYY-MM-DD" calendar date. */
function weekday(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1)).getUTCDay();
}

export function snoozePresets(now: Date, tz: string): SnoozePresets {
  const today = localDate(now, tz);
  const toMonday = ((8 - weekday(today)) % 7) || 7;
  return { tomorrow: `${addDays(today, 1)}T${MORNING}`, nextWeek: `${addDays(today, toMonday)}T${MORNING}` };
}
