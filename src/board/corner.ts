// The status corner (docs/STYLE-GUIDE.md §7.25, run 12): one sticky place at the top of every signed-in page for the
// running timer (a chip with Stop and Undo) and the latest change (its notice, or the Time logged note). Only the
// notice is a live region; the chip's clock is outside it so a screen reader is not told the time again and again.
import type { ChangeItem } from "../services/read.ts";
import { canUndo, undoForm } from "./banner.ts";
import { type FormContext, formBasics, hidden, postForm } from "./forms.ts";
import { type Html, html } from "./html.ts";
import type { TimerInfo } from "./timer-bar.ts";

/** A change the corner announces, with the safe name of the one task or time entry it touches, when it names one. */
export type Notice = { change: ChangeItem; name: string | null };

/** The time just logged: the stop's change, its entry, the two times as the owner reads them, and when the note goes (an ISO time). */
export type Logged = { changeId: string; entryId: string; from: string; to: string; expiresAt: string };

export type CornerState = { timer: TimerInfo | null; notice: Notice | null; logged: Logged | null; startTimer: boolean };

export const TIMER_NOTES_LINK = "/timer/notes";
const LABEL_MAX = 32;

const VERBS: Record<string, string> = {
  complete_task: "Done",
  snooze_task: "Snoozed",
  add_task: "Added",
  update_task: "Saved",
  move_task: "Moved",
  start_timer: "Timer started",
  stop_timer: "Time logged",
  cancel_timer: "Timer discarded",
  log_time: "Saved",
};

/** The notice's one line: "Done: Send the plan", "Done." with no name, or the stored summary for any other tool. */
export function noticeText(change: ChangeItem, name: string | null): string {
  const verb = change.undoOf !== null ? "Undone" : VERBS[change.tool];
  if (verb === undefined) return change.summary;
  return name === null ? `${verb}.` : `${verb}: ${name}`;
}

/** The verb a change has a name for: its record is looked up only then. */
export const hasVerb = (change: ChangeItem): boolean => change.undoOf !== null || change.tool in VERBS;

const cut = (label: string): string => {
  const letters = [...label];
  return letters.length <= LABEL_MAX ? label : `${letters.slice(0, LABEL_MAX).join("")}…`;
};

function chip(timer: TimerInfo, form: FormContext): Html {
  const named = html`<span class="visually-hidden">: timer${timer.label === "" ? "" : ` for ${timer.label}`}</span>`;
  const what = timer.label === "" ? "" : html`<span class="corner-what">${cut(timer.label)}</span>\n`;
  return html`<div class="corner-chip" role="region" aria-label="Running timer">
<time class="corner-clock" datetime="${timer.startedAt}" data-since="${timer.startedAt}">since ${timer.since}</time>
${what}${postForm("corner-form", "/timer/stop/now", form, html`<button class="button corner-button" type="submit">Stop${named}</button>`, { live: {} })}
<form class="corner-form" data-started="${timer.startedAt}" data-live method="post" action="/timer/cancel">${formBasics(form)}<button class="button corner-button" type="submit">Undo<span class="visually-hidden"> the timer</span></button></form>
</div>
`;
}

function loggedNote(logged: Logged, form: FormContext): Html {
  const notes = `${TIMER_NOTES_LINK}?entry=${encodeURIComponent(logged.entryId)}&back=${encodeURIComponent(form.here)}`;
  return html`<div class="corner-logged" data-expires="${logged.expiresAt}">
<p class="corner-text">Time logged: ${logged.from} to ${logged.to}</p>
<div class="corner-actions">
<a class="corner-link" href="${notes}">Edit or add notes</a>
${undoForm(logged.changeId, form, "corner-form", true)}
${postForm("corner-form", "/corner/close", form, html`${hidden("change", logged.changeId)}<button class="button corner-button" type="submit">Close</button>`, { live: {} })}
</div>
</div>`;
}

function changeNotice({ change, name }: Notice, form: FormContext): Html {
  if (change.undone) return html`<p class="corner-text">${name === null ? "Undone." : `Undone: ${name}`}</p>`;
  // In place only for changes the corner has a verb for (tasks and timers); any other page may now be stale, so it reloads.
  const after = canUndo(change) ? undoForm(change.changeId, form, "corner-form", change.tool in VERBS) : "";
  return html`<p class="corner-text">${noticeText(change, name)}</p>
${after}`;
}

/** The corner: the timer chip (outside the live region), then the live region with the Time logged note or the change notice. */
export function corner(state: CornerState, form: FormContext): Html {
  const inside = state.logged !== null ? loggedNote(state.logged, form) : state.notice !== null ? changeNotice(state.notice, form) : "";
  return html`<div class="corner" data-region="corner">
${state.timer === null ? "" : chip(state.timer, form)}<div class="corner-notice" role="status" tabindex="-1">${inside === "" ? "" : html`\n${inside}\n`}</div>
</div>
`;
}
