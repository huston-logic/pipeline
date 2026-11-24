// The Stop bar (decision 0050): one line under the header on every board page while a timer runs, with a Stop link to the
// stop form. No JavaScript and no live clock: it says when the timer started, in words. Time tracking off draws nothing.
import type { Db, SettingsRow } from "../db/db.ts";
import { forWho, runningTimer } from "../services/time-entries.ts";
import { rowLabel } from "../services/describe.ts";
import { contactById, dealById, ownerTimezone, taskById } from "../services/lookup.ts";
import { sinceText } from "../services/timer.ts";
import { type Html, html } from "./html.ts";

/** The running timer as the bar names it: a safe label (outside text is an id there, labels.ts) and the start in words. */
export type TimerInfo = { label: string; since: string };

export const STOP_PATH = "/timer/stop";

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
  return { timer: { label, since: sinceText(running.started_at, now, await ownerTimezone(db)) }, startTimer: false };
}

/** The bar: "Timer" in words (never colour alone), who it is for, since when, and Stop. */
export function timerBar(timer: TimerInfo): Html {
  const who = timer.label === "" ? "" : html`: ${timer.label}`;
  return html`<div class="timer-bar">
<p class="timer-bar-text"><strong>Timer</strong>${who} · since ${timer.since}</p>
<a class="button button-small" href="${STOP_PATH}">Stop</a>
</div>
`;
}
