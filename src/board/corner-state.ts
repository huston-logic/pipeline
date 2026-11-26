// What the status corner shows for one request (run 12): the running timer, the change named in the address, and the
// Time logged note for a timer stopped in the last two minutes. Reads only; nothing here writes.
import type { Db, SettingsRow } from "../db/db.ts";
import { isChangeId } from "../ids.ts";
import { ownerTimezone, taskById, timeEntryById } from "../services/lookup.ts";
import { type ChangeItem, getChange, latestTimerChange } from "../services/read.ts";
import { whoOf } from "../services/time-entries.ts";
import { sinceText } from "../services/timer.ts";
import type { PageContext } from "./context.ts";
import { type CornerState, hasVerb, type Logged, type Notice } from "./corner.ts";
import { taskName } from "./task-forms.ts";
import { timerState } from "./timer-bar.ts";

/** A stop counts as "just logged" for this long. */
export const LOGGED_FOR_MS = 2 * 60_000;

export type CornerInput = { changeId: string | null; closed: string | null };

/** The safe name of the one task or time entry a change touches, or null (outside text is an id, never the text). */
async function nameOf(db: Db, change: ChangeItem): Promise<string | null> {
  if (change.targetTable === "tasks") {
    const task = await taskById(db, change.targetId);
    return task === null ? null : taskName(task);
  }
  if (change.targetTable === "time_entries") {
    const entry = await timeEntryById(db, change.targetId);
    return entry === null ? null : whoOf(db, entry);
  }
  return null;
}

async function noticeFor(db: Db, changeId: string | null): Promise<Notice | null> {
  if (changeId === null || !isChangeId(changeId)) return null;
  const change = await getChange(db, changeId);
  if (change === null) return null;
  return { change, name: hasVerb(change) ? await nameOf(db, change) : null };
}

/** The stop that just happened, while no timer runs: the latest timer change is a live stop made within two minutes. */
async function loggedFor(db: Db, now: Date, closed: string | null): Promise<Logged | null> {
  const latest = await latestTimerChange(db);
  if (latest === null || latest.tool !== "stop_timer" || latest.undone || latest.changeId === closed) return null;
  if (now.getTime() - Date.parse(latest.at) > LOGGED_FOR_MS) return null;
  const entry = await timeEntryById(db, latest.targetId);
  if (entry === null || entry.ended_at === null) return null;
  const tz = await ownerTimezone(db);
  const expiresAt = new Date(Date.parse(latest.at) + LOGGED_FOR_MS).toISOString();
  return { changeId: latest.changeId, entryId: entry.id, from: sinceText(entry.started_at, now, tz), to: sinceText(entry.ended_at, now, tz), expiresAt };
}

export async function buildCorner(db: Db, now: Date, settings: Pick<SettingsRow, "time_tracking">, input: CornerInput): Promise<CornerState> {
  const { timer, startTimer } = await timerState(db, now, settings);
  const logged = settings.time_tracking === 1 && timer === null ? await loggedFor(db, now, input.closed) : null;
  const notice = logged === null ? await noticeFor(db, input.changeId) : null;
  return { timer, startTimer, logged, notice };
}

/** The page's corner: the one the router built, or (a refused post's page has none) a fresh one with just the timer. */
export async function cornerOf(ctx: Pick<PageContext, "db" | "now" | "corner">, settings: Pick<SettingsRow, "time_tracking">): Promise<CornerState> {
  return ctx.corner ?? (await buildCorner(ctx.db, ctx.now, settings, { changeId: null, closed: null }));
}
