// Timezone helpers built on Intl only. Times are stored as UTC ISO strings; the owner's timezone (a setting) decides
// what "today", a date-only input and a wall-clock time mean.
import { UserError } from "./services/errors.ts";

export const DEFAULT_TZ = "America/Los_Angeles";

const DAY_MS = 86_400_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const ISO_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

type Wall = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const wallFormats = new Map<string, Intl.DateTimeFormat>();

function wallFormat(tz: string): Intl.DateTimeFormat {
  let format = wallFormats.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    wallFormats.set(tz, format);
  }
  return format;
}

function wallTime(at: Date, tz: string): Wall {
  const parts: Record<string, number> = {};
  for (const part of wallFormat(tz).formatToParts(at)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

const wallAsUtcMs = (w: Wall) => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);

/** How far the zone's wall clock is ahead of UTC at this instant, in ms. */
function offsetMs(atMs: number, tz: string): number {
  const whole = atMs - (((atMs % 1000) + 1000) % 1000);
  return wallAsUtcMs(wallTime(new Date(whole), tz)) - whole;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function parseWall(local: string): Wall | null {
  const date = DATE.exec(local);
  const dateTime = date ? null : LOCAL_DATE_TIME.exec(local);
  const m = date ?? dateTime;
  if (!m) return null;
  const wall: Wall = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4] ?? 0),
    minute: Number(m[5] ?? 0),
    second: Number(m[6] ?? 0),
  };
  const check = new Date(wallAsUtcMs(wall));
  const valid =
    wall.hour < 24 &&
    wall.minute < 60 &&
    wall.second < 60 &&
    check.getUTCFullYear() === wall.year &&
    check.getUTCMonth() === wall.month - 1 &&
    check.getUTCDate() === wall.day;
  return valid ? wall : null;
}

/** "YYYY-MM-DD" of this instant in the timezone. */
export function localDate(at: Date, tz: string): string {
  const w = wallTime(at, tz);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

/** Hour 0-23 of this instant in the timezone. */
export function localHour(at: Date, tz: string): number {
  return wallTime(at, tz).hour;
}

/**
 * The instant at which the timezone's clock shows `local` ("YYYY-MM-DD", "YYYY-MM-DDTHH:mm" or "...:ss").
 * A time that happens twice (clocks going back) is the first one; a time skipped by clocks going forward moves
 * forward by the skipped amount (02:30 becomes 03:30). This matches Temporal's "compatible" rule.
 */
export function zonedToUtc(local: string, tz: string): Date {
  const wall = parseWall(local);
  if (!wall) throw new RangeError(`"${local}" is not a valid local date or date-time.`);
  const guess = wallAsUtcMs(wall);
  // The offsets a day either side cover any single clock change near this wall time.
  const before = guess - offsetMs(guess - DAY_MS, tz);
  const after = guess - offsetMs(guess + DAY_MS, tz);
  const showsWall = (ms: number) => wallAsUtcMs(wallTime(new Date(ms), tz)) === guess;
  return new Date(!showsWall(before) && showsWall(after) ? after : before);
}

/** The UTC instants where the local day starts and where the next one starts (23, 24 or 25 hours apart). */
export function dayBoundsUtc(date: string, tz: string): { start: Date; end: Date } {
  return { start: zonedToUtc(`${date}T00:00`, tz), end: zonedToUtc(`${addDays(date, 1)}T00:00`, tz) };
}

/** Calendar arithmetic on "YYYY-MM-DD". */
export function addDays(date: string, n: number): string {
  const wall = parseWall(date);
  if (!wall || !DATE.test(date)) throw new RangeError(`"${date}" is not a valid YYYY-MM-DD date.`);
  const d = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + n));
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * Reads a date from a request. Accepts "YYYY-MM-DD" (midnight, owner's time), "YYYY-MM-DDTHH:mm[:ss]" (owner's
 * wall time) or a full ISO time with "Z" or an offset.
 */
export function parseWhen(input: string, tz: string): Date {
  const text = input.trim();
  if (parseWall(text)) return zonedToUtc(text, tz);
  if (ISO_WITH_OFFSET.test(text)) {
    const at = new Date(text);
    if (!Number.isNaN(at.getTime()) && parseWall(text.slice(0, 10))) return at;
  }
  throw new UserError(
    `"${input}" isn't a date I can read. Use YYYY-MM-DD (2026-11-19), YYYY-MM-DDTHH:mm in the owner's local time ` +
      `(2026-11-19T14:00), or a full ISO time with an offset (2026-11-19T22:00:00Z).`,
  );
}

const displayFormats = new Map<string, Intl.DateTimeFormat>();

/** For people: "Thu Nov 19, 2:00 PM" in the timezone. */
export function formatLocal(at: Date | string, tz: string): string {
  let format = displayFormats.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    displayFormats.set(tz, format);
  }
  const parts: Record<string, string> = {};
  for (const part of format.formatToParts(typeof at === "string" ? new Date(at) : at)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return `${parts.weekday} ${parts.month} ${parts.day}, ${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
}
