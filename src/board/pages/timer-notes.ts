// /timer/notes?entry=<te id>&back=<path> (run 12): "Edit or add notes" for time already logged. It is the stop form for a
// saved entry, prefilled; POST /timer/notes (time-actions.ts) calls log_time (amendTime). 404 while time tracking is off,
// and for an entry that is unknown, still running or archived.
import { getSettings } from "../../db/queries.ts";
import { isTimeEntryId } from "../../ids.ts";
import { ownerTimezone, timeEntryById } from "../../services/lookup.ts";
import { sinceText } from "../../services/timer.ts";
import { listWorkTypes } from "../../services/work-types.ts";
import { localWhen } from "../../time.ts";
import { timerAskSection } from "../ask-claude.ts";
import type { PageContext } from "../context.ts";
import { hidden, postForm } from "../forms.ts";
import { html } from "../html.ts";
import { checkbox } from "../inputs.ts";
import { renderPage } from "../layout.ts";
import { formErrorSummary, specField } from "../record-fields.ts";
import type { FormError, Shown } from "../record-form.ts";
import { boardReturnPath } from "../return-to.ts";
import { timerState } from "../timer-bar.ts";
import { TIMER_DONE_PATH } from "./timer-done.ts";
import { stopSpecs } from "./timer-stop.ts";

export const TIMER_NOTES_PATH = "/timer/notes";
const PREFIX = "notes";

/** A refused post's form as it was posted, with what went wrong. */
export type NotesState = { shown: Map<string, Shown>; billable: boolean; wasBillable: string; errors: FormError[] };

/** The way back a notes address names: a board page, else the entry's done page. */
export const notesBack = (back: string | null, entryId: string): string => boardReturnPath(back) ?? `${TIMER_DONE_PATH}?entry=${encodeURIComponent(entryId)}`;

export async function timerNotesPage(ctx: PageContext, state?: NotesState): Promise<string | null> {
  const { db, now } = ctx;
  const settings = await getSettings(db);
  const id = ctx.query.get("entry") ?? "";
  if (settings.time_tracking !== 1 || !isTimeEntryId(id)) return null;
  const entry = await timeEntryById(db, id);
  if (entry === null || entry.ended_at === null || entry.archived === 1) return null;
  const tz = await ownerTimezone(db);
  const back = notesBack(ctx.query.get("back"), id);
  const types = (await listWorkTypes(db)).map(({ id: typeId, name }) => ({ id: typeId, name }));
  const specs = stopSpecs(types);
  const shown =
    state?.shown ??
    new Map<string, Shown>([
      ["notes", { value: entry.notes ?? "", was: entry.notes ?? "", outside: false }],
      ["work_type", { value: entry.work_type_id ?? "", was: entry.work_type_id ?? "", outside: false }],
      ["next_step", { value: "", outside: false }],
      ["started", { value: localWhen(entry.started_at, tz), was: localWhen(entry.started_at, tz), outside: false }],
      ["ended", { value: localWhen(entry.ended_at, tz), was: localWhen(entry.ended_at, tz), outside: false }],
    ]);
  const billable = state?.billable ?? entry.billable === 1;
  const wasBillable = state?.wasBillable ?? (billable ? "1" : "0");
  const field = (name: string) => {
    const spec = specs.find((item) => item.name === name);
    return spec === undefined ? "" : specField(spec, shown.get(name), PREFIX);
  };
  const errors = state?.errors ?? [];
  const { timer } = await timerState(db, now, settings);
  return renderPage({
    title: state === undefined ? "Edit or add notes" : "Error: Edit or add notes",
    description: "Add notes to time you already logged, or fix its details.",
    frame: { ...ctx, timer },
    script: true,
    body: html`<h1>Edit or add notes</h1>
<p class="lede">Time logged: ${sinceText(entry.started_at, now, tz)} to ${sinceText(entry.ended_at, now, tz)}</p>
${errors.length === 0 ? "" : formErrorSummary(errors, specs, PREFIX)}
${postForm(
  "notes-form",
  TIMER_NOTES_PATH,
  { csrf: ctx.csrf, here: back },
  html`${hidden("entry", id)}${hidden("back", back)}
${field("notes")}
${field("work_type")}
${checkbox({ id: "notes-billable", name: "billable", label: "Billable", value: "yes", checked: billable })}
${hidden("was.billable", wasBillable)}
${field("next_step")}
${field("started")}
${field("ended")}
<div class="confirm-actions">
<button class="button" type="submit">Save</button>
<a class="confirm-cancel" href="${back}">Cancel</a>
</div>`,
  { novalidate: true },
)}
${entry.notes === null ? "" : timerAskSection(entry.id, entry.activity_id)}`,
  });
}
