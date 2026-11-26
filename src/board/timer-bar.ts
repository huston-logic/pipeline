// The running timer for the status corner (decision 0050, run 12): who it is for, when it started, and whether Start
// timer buttons are offered. Time tracking off reads nothing and draws nothing.
import type { Db, SettingsRow } from "../db/db.ts";
import { forWho, runningTimer } from "../services/time-entries.ts";
import { rowLabel } from "../services/describe.ts";
import { contactById, dealById, ownerTimezone, taskById } from "../services/lookup.ts";
import { sinceText } from "../services/timer.ts";

/** The running timer as the corner names it: a safe label (outside text is an id there, labels.ts), the start in words and as a stamp. */
export type TimerInfo = { label: string; since: string; startedAt: string };

/** What every signed-in page needs about time: the running timer, and whether Start timer buttons are offered. */
export type TimerState = { timer: TimerInfo | null; startTimer: boolean };

/** Nothing is read while time tracking is off. A timer left running when it was turned off is not shown. */
export async function timerState(db: Db, now: Date, settings: Pick<SettingsRow, "time_tracking">): Promise<TimerState> {
  if (settings.time_tracking !== 1) return { timer: null, startTimer: false };
  const running = await runningTimer(db);
  if (running === null) return { timer: null, startTimer: true };
  const deal = running.deal_id === null ? null : await dealById(db, running.deal_id);
  const contact = running.contact_id === null ? null : await contactById(db, running.contact_id);
  const task = running.task_id === null ? null : await taskById(db, running.task_id);
  const label = forWho(deal, contact) ?? (task === null ? "" : rowLabel("tasks", task));
  return { timer: { label, since: sinceText(running.started_at, now, await ownerTimezone(db)), startedAt: running.started_at }, startTimer: false };
}
