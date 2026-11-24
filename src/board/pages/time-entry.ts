// /time/new and /time/<id>/edit (decision 0051): adding time by hand (add_time_entry) and changing or archiving an entry
// (update_time_entry). Built like the other record forms (decision 0018): only the fields the owner changes are saved.
// 404 while time tracking is off, and for an entry that is not there, is archived or is the running timer.
import type { TimeEntryRow } from "../../db/db.ts";
import { getSettings } from "../../db/queries.ts";
import { isTimeEntryId } from "../../ids.ts";
import { ownerTimezone, timeEntryById } from "../../services/lookup.ts";
import { localDate } from "../../time.ts";
import type { PageContext } from "../context.ts";
import { postForm } from "../forms.ts";
import { html } from "../html.ts";
import { type Shown, editShown } from "../record-form.ts";
import { timeArchivePath, timeChoices, timeEditPath, TIME_NEW_PATH, TIME_PREFIX, timeSpecs } from "../time-form.ts";
import { mondayOf, weekHref } from "../time-week.ts";
import { periodOf } from "../../services/time-read.ts";
import { type FormState, recordFormPage } from "./record-page.ts";

/** The address of the week an entry is in (Cancel, and where a save lands). */
export const weekOfEntry = (startedAt: string, now: Date, tz: string): string =>
  weekHref(mondayOf(localDate(new Date(startedAt), tz)), periodOf("this_week", now, tz).from);

export async function timeNewPage(ctx: PageContext, state?: FormState): Promise<string | null> {
  if ((await getSettings(ctx.db)).time_tracking !== 1) return null;
  const tz = await ownerTimezone(ctx.db);
  const specs = timeSpecs(await timeChoices(ctx.db), "new");
  const shown: Map<string, Shown> = state?.shown ?? new Map([["started", { value: localDate(ctx.now, tz), outside: false }]]);
  return recordFormPage(ctx, {
    title: "Add time",
    description: "Add time you worked by hand: who it was for, the work type, when it started and when it ended or how long it took.",
    heading: "Add time",
    lede: "For work you did without the timer. Give the start, then an end or the minutes.",
    current: TIME_NEW_PATH,
    back: { href: "/time", text: "Back to time" },
    action: TIME_NEW_PATH,
    cancel: "/time",
    submit: "Save time",
    prefix: TIME_PREFIX,
    groups: [{ specs }],
    shown,
    errors: state?.errors ?? [],
  });
}

/** A finished, live entry by id, or null. */
export async function editableEntry(ctx: Pick<PageContext, "db">, id: string): Promise<TimeEntryRow | null> {
  const entry = isTimeEntryId(id) ? await timeEntryById(ctx.db, id) : null;
  return entry === null || entry.archived === 1 || entry.ended_at === null ? null : entry;
}

export async function timeEditPage(ctx: PageContext, id: string, state?: FormState): Promise<string | null> {
  if ((await getSettings(ctx.db)).time_tracking !== 1) return null;
  const entry = await editableEntry(ctx, id);
  if (entry === null) return null;
  const tz = await ownerTimezone(ctx.db);
  const specs = timeSpecs(await timeChoices(ctx.db, entry), "edit");
  const shown = state?.shown ?? (await editShown(specs, { ...entry, fields: "{}" }, tz));
  const back = weekOfEntry(entry.started_at, ctx.now, tz);
  return recordFormPage(ctx, {
    title: "Edit time entry",
    description: "Change an entry's person, deal, work type, times, billing or notes, or archive it.",
    heading: "Edit time entry",
    lede: "Change what you need and save. Moving the start keeps the end; giving minutes keeps the start. Changing the work type, person or billing works the rate out again from today's rates.",
    current: timeEditPath(entry.id),
    back: { href: back, text: "Back to the week" },
    action: timeEditPath(entry.id),
    cancel: back,
    submit: "Save changes",
    prefix: TIME_PREFIX,
    groups: [{ specs }],
    shown,
    errors: state?.errors ?? [],
    below: html`<div class="card archive-card">
<p>Archiving hides this entry from the week and the CSV. You can undo it from the banner that follows.</p>
${postForm("archive-form", timeArchivePath(entry.id), { csrf: ctx.csrf, here: back }, html`<button class="button button-quiet" type="submit">Archive this entry</button>`)}
</div>`,
  });
}
