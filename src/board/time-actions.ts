// The time posts: the timer's Start and stop form (decision 0050), and adding, editing and archiving an entry by hand
// (decision 0051). Each calls the service the matching MCP tool calls (start_timer, stop_timer, add_time_entry,
// update_time_entry) as the owner under that tool's name; the AI edits setting does not apply to the board. While time
// tracking is off every path here is a 404. A refused form is drawn again (422) with the values kept.
import { getSettings } from "../db/queries.ts";
import { localDate } from "../time.ts";
import { isChangeId, isContactId, isDealId, isProjectId, isTaskId, isTimeEntryId } from "../ids.ts";
import { formatDuration } from "../services/time-format.ts";
import { UserError } from "../services/errors.ts";
import { addTimeEntry, runningTimer, type TimeEntryInput, type TimeEntryPatch, updateTimeEntry } from "../services/time-entries.ts";
import { ownerTimezone, timeEntryById } from "../services/lookup.ts";
import { amendTime, cancelTimer, startTimer, type StopInput, stopTimer } from "../services/timer.ts";
import { type ActionContext, type ActionResult, asOwner, AT_PATTERN, backTo, fieldError, notFound, page, pageContext, redirect, redirectBack, refusal, refusedPage, type Route, stateOf } from "./action-kit.ts";
import { timerStopPage, stopSpecs, TIMER_STOP_PATH } from "./pages/timer-stop.ts";
import { notesBack, timerNotesPage, TIMER_NOTES_PATH } from "./pages/timer-notes.ts";
import { closeCookie } from "./corner-actions.ts";
import { hidden, postForm } from "./forms.ts";
import { html } from "./html.ts";
import { renderPage } from "./layout.ts";
import type { PageContext } from "./context.ts";
import { collectEdit, type Collected, collectNew, parseValue, postedValue, type Shown, type Spec } from "./record-form.ts";
import { editableEntry, timeEditPage, timeNewPage } from "./pages/time-entry.ts";
import { timeChoices, timeEditPath, TIME_NEW_PATH, timeSpecs } from "./time-form.ts";
import { mondayOf } from "./time-week.ts";
import { withChange } from "./return-to.ts";
import { listWorkTypes } from "../services/work-types.ts";
import { TIMER_DONE_PATH } from "./pages/timer-done.ts";

const localDateOf = (iso: string, tz: string): string => localDate(new Date(iso), tz);

const trackingOn = async (ctx: ActionContext): Promise<boolean> => (await getSettings(ctx.db)).time_tracking === 1;

type Ref = { contact?: string; deal?: string; task?: string; project?: string };

/** The one subject a Start form names, or null when its id can't be a record's. */
function subjectOf(form: URLSearchParams): Ref | null {
  const contact = form.get("contact") ?? "";
  const deal = form.get("deal") ?? "";
  const task = form.get("task") ?? "";
  const project = form.get("project") ?? "";
  if (project !== "") return isProjectId(project) ? { project } : null;
  if (deal !== "") return isDealId(deal) ? { deal } : null;
  if (task !== "") return isTaskId(task) ? { task } : null;
  if (contact !== "") return isContactId(contact) ? { contact } : null;
  return {};
}

/** POST /timer/start: start_timer for a person, a deal or a task. One timer runs at a time. */
async function start(ctx: ActionContext): Promise<ActionResult> {
  if (!(await trackingOn(ctx))) return notFound(ctx);
  const back = backTo(ctx, "/");
  const subject = subjectOf(ctx.form);
  try {
    if (subject === null) throw new UserError("Start the timer from a person, a deal or a task.");
    const result = await startTimer(asOwner(ctx, "start_timer"), subject);
    return redirectBack(ctx, withChange(back, result.changeId));
  } catch (error) {
    return page(422, refusedPage(ctx, "The timer wasn't started", refusal(error, "timer"), back, ""));
  }
}

/** The stop form's start and end, kept as posted with their fingerprints; a date with no time is not a moment. */
function keepTimes(collected: Collected, specs: Spec[], form: URLSearchParams): void {
  for (const name of ["started", "ended"] as const) {
    const spec = specs.find((item) => item.name === name);
    const posted = spec === undefined ? null : postedValue(form, spec);
    const item: Shown | undefined = collected.shown.get(name);
    if (item !== undefined) item.was = form.get(`was.${name}`) ?? undefined;
    if (posted !== null && posted !== "" && !posted.includes("T") && !collected.errors.some((error) => error.name === name)) {
      fieldError(collected, name, "Give the time too.");
    }
  }
}

const noTimer = (ctx: ActionContext, title: string, back: string): ActionResult => page(422, refusedPage(ctx, title, "No timer is running.", back, ""));

/** POST /timer/stop/now: stop_timer with nothing changed (the timer's own start, work type and billing), one tap. */
async function stopNow(ctx: ActionContext): Promise<ActionResult> {
  if (!(await trackingOn(ctx))) return notFound(ctx);
  const back = backTo(ctx, "/");
  if ((await runningTimer(ctx.db)) === null) return noTimer(ctx, "The timer wasn't stopped", back);
  try {
    const result = await stopTimer(asOwner(ctx, "stop_timer"), {});
    return redirectBack(ctx, withChange(back, result.changeId));
  } catch (error) {
    return page(422, refusedPage(ctx, "The timer wasn't stopped", refusal(error, "timer"), back, ""));
  }
}

/** A timer that ran longer than this asks before it is discarded. */
const DISCARD_ASKS_AFTER_MS = 5 * 60_000;

function discardPage(ctx: ActionContext, minutes: number, back: string): string {
  const at = ctx.form.get("at") ?? "";
  return renderPage({
    title: "Confirm: discard the timer",
    description: "Discarding the timer logs nothing. Confirm, or keep the timer running.",
    frame: { look: ctx.look },
    body: html`<h1>Discard the timer?</h1>
<p class="lede">It has run ${formatDuration(minutes)}. Nothing will be logged.</p>
${postForm(
  "confirm",
  "/timer/cancel",
  { csrf: ctx.csrf, here: back },
  html`${hidden("confirm", "yes")}${AT_PATTERN.test(at) ? hidden("at", at) : ""}
<div class="confirm-actions">
<button class="button" type="submit">Discard timer</button>
<a class="confirm-cancel" href="${back}">Keep it</a>
</div>`,
)}`,
  });
}

/** POST /timer/cancel: cancel_timer. A timer older than five minutes asks first (confirm=yes answers). */
async function cancel(ctx: ActionContext): Promise<ActionResult> {
  if (!(await trackingOn(ctx))) return notFound(ctx);
  const back = backTo(ctx, "/");
  const running = await runningTimer(ctx.db);
  if (running === null) return noTimer(ctx, "The timer wasn't discarded", back);
  const age = ctx.now.getTime() - Date.parse(running.started_at);
  if (age > DISCARD_ASKS_AFTER_MS && ctx.form.get("confirm") !== "yes") return page(200, discardPage(ctx, Math.floor(age / 60_000), back));
  try {
    const result = await cancelTimer(asOwner(ctx, "cancel_timer"));
    return redirectBack(ctx, withChange(back, result.changeId));
  } catch (error) {
    return page(422, refusedPage(ctx, "The timer wasn't discarded", refusal(error, "timer"), back, ""));
  }
}

/** The change that stopped this entry, for the status corner's Close. */
const stopChangeOf = (ctx: ActionContext, entryId: string): Promise<string | null> =>
  ctx.db
    .prepare("SELECT id FROM audit_log WHERE tool = 'stop_timer' AND target_table = 'time_entries' AND target_id = ? ORDER BY at DESC, id DESC LIMIT 1")
    .bind(entryId)
    .first<string>("id");

/** POST /timer/notes: log_time with only what changed on a saved entry's form. Then back, with the stop's corner closed. */
async function notes(ctx: ActionContext): Promise<ActionResult> {
  if (!(await trackingOn(ctx))) return notFound(ctx);
  const id = ctx.form.get("entry") ?? "";
  const entry = isTimeEntryId(id) ? await timeEntryById(ctx.db, id) : null;
  if (entry === null || entry.ended_at === null || entry.archived === 1) return notFound(ctx);
  const back = notesBack(ctx.form.get("back"), id);
  const types = (await listWorkTypes(ctx.db)).map(({ id: typeId, name }) => ({ id: typeId, name }));
  const specs = stopSpecs(types);
  const collected = collectNew(specs, ctx.form);
  keepTimes(collected, specs, ctx.form);
  for (const [name, item] of collected.shown) item.was = ctx.form.get(`was.${name}`) ?? undefined;
  const billable = ctx.form.get("billable") === "yes";
  const wasBillable = ctx.form.get("was.billable");
  const refused = async (extra: string[] = []) => {
    const state = { shown: collected.shown, billable, wasBillable: wasBillable ?? (billable ? "1" : "0"), errors: [...collected.errors, ...extra.map((message) => ({ message }))] };
    const context = { ...pageContext(ctx, TIMER_NOTES_PATH), query: new URLSearchParams({ entry: id, back }) };
    return page(422, (await timerNotesPage(context, state)) ?? "");
  };
  if (collected.errors.length > 0) return refused();

  // A field is sent only when it differs from how the form drew it (its was.), read the way the service takes it.
  const changed = (name: string): boolean => {
    const spec = specs.find((item) => item.name === name);
    if (spec === undefined) return false;
    const now = parseValue(spec, postedValue(ctx.form, spec) ?? "");
    const was = parseValue(spec, ctx.form.get(`was.${name}`) ?? "");
    return !(now.ok && was.ok && now.value === was.value);
  };
  const input = collected.input as { notes?: string; workType?: string; nextStepDate?: string; startedAt?: string; endedAt?: string };
  const patch: StopInput = {};
  if (changed("notes") && input.notes !== undefined) patch.notes = input.notes;
  if (changed("work_type")) patch.workType = input.workType ?? null;
  if (changed("next_step") && input.nextStepDate !== undefined) patch.nextStepDate = input.nextStepDate;
  if (changed("started") && input.startedAt !== undefined) patch.startedAt = input.startedAt;
  if (changed("ended") && input.endedAt !== undefined) patch.endedAt = input.endedAt;
  if (wasBillable !== null && wasBillable !== (billable ? "1" : "0")) patch.billable = billable;
  if (Object.keys(patch).length === 0) return refused([NOTHING_TO_SAVE]);
  try {
    const result = await amendTime(asOwner(ctx, "log_time"), id, patch);
    const stopChange = await stopChangeOf(ctx, id);
    const location = withChange(back, result.changeId);
    if (stopChange === null || !isChangeId(stopChange)) return redirect(location);
    return { kind: "redirect", location, headers: { "Set-Cookie": closeCookie(stopChange, ctx.origin.startsWith("https:")) } };
  } catch (error) {
    return refused([refusal(error, "time entry")]);
  }
}

/** POST /timer/stop: stop_timer with the notes, work type, billable, next step date and, when changed, start and end. */
async function stop(ctx: ActionContext): Promise<ActionResult> {
  if (!(await trackingOn(ctx))) return notFound(ctx);
  const here = TIMER_STOP_PATH;
  const types = (await listWorkTypes(ctx.db)).map(({ id, name }) => ({ id, name }));
  const specs = stopSpecs(types);
  const collected = collectNew(specs, ctx.form);
  const billable = ctx.form.get("billable") === "yes";
  keepTimes(collected, specs, ctx.form);
  const refused = async (extra: string[] = []) =>
    page(
      422,
      (await timerStopPage(pageContext(ctx, here), { shown: collected.shown, billable, wasBillable: ctx.form.get("was.billable") ?? (billable ? "1" : "0"), errors: [...collected.errors, ...extra.map((message) => ({ message }))] })) ?? "",
    );
  if ((await runningTimer(ctx.db)) === null) return refused(["No timer is running."]);
  if (collected.errors.length > 0) return refused();
  const input = collected.input as { notes?: string; workType?: string; nextStepDate?: string; startedAt?: string; endedAt?: string };
  const stopInput: StopInput = {};
  if (input.notes !== undefined) stopInput.notes = input.notes;
  // None clears a work type the timer has; a type chosen again is not resent, so the timer's own billable stands.
  const running = await runningTimer(ctx.db);
  const own = running?.work_type_id ?? null;
  if (input.workType === undefined) {
    if (own !== null) stopInput.workType = null;
  } else if (input.workType !== own) {
    stopInput.workType = input.workType;
  }
  // Billable is sent only when the box differs from how the form drew it; otherwise the work type's default decides.
  const was = ctx.form.get("was.billable");
  if (was === null || was !== (billable ? "1" : "0")) stopInput.billable = billable;
  if (input.nextStepDate !== undefined) stopInput.nextStepDate = input.nextStepDate;
  // A start or end left as the form drew it is not sent: the timer keeps its own start, and "now" is the moment of saving.
  if (input.startedAt !== undefined && input.startedAt !== ctx.form.get("was.started")) stopInput.startedAt = input.startedAt;
  if (input.endedAt !== undefined && input.endedAt !== ctx.form.get("was.ended")) stopInput.endedAt = input.endedAt;
  try {
    const result = await stopTimer(asOwner(ctx, "stop_timer"), stopInput);
    return redirect(withChange(`${TIMER_DONE_PATH}?entry=${encodeURIComponent(result.entryId)}${result.taskId === null ? "" : `&task=${encodeURIComponent(result.taskId)}`}`, result.changeId));
  } catch (error) {
    return refused([refusal(error, "time entry")]);
  }
}

const NOTHING_TO_SAVE = "Nothing to save: every field is as it was. Change a value, or cancel to go back.";

/** The week a saved entry is in, and the way back to it: the page that shows the change. */
const weekAddress = (date: string): string => `/time?week=${mondayOf(date.slice(0, 10))}`;

/** A time form's page context: time tracking is on (the paths 404 otherwise), so More lists Time on a refused form too. */
const timeContext = (ctx: ActionContext, here: string): PageContext => ({ ...pageContext(ctx, here), timeTracking: true });

/** A start or end with a date and no time is not a moment (it would be midnight): ask for the time, as the stop form does. */
function needTimes(collected: Collected): void {
  for (const [name, prop] of [["started", "startedAt"], ["ended", "endedAt"]] as const) {
    const value = collected.input[prop];
    if (typeof value === "string" && !value.includes("T")) fieldError(collected, name, "Give the time too.");
  }
}

/** An end and minutes together: the board says so in its own words. */
function eitherEndOrMinutes(collected: Collected, ended: boolean, minutes: boolean): void {
  if (ended && minutes) fieldError(collected, "minutes", "Give an end or the minutes, not both.");
}

/** What the form's choices say about billing: "1" billable, "0" not, and nothing (left to the work type) when blank. */
const billableOf = (value: unknown): boolean | undefined => (value === "1" ? true : value === "0" ? false : undefined);

/** POST /time/new: add_time_entry from the form. Then the week the entry is in, with the Undo banner. */
async function addEntry(ctx: ActionContext): Promise<ActionResult> {
  if (!(await trackingOn(ctx))) return notFound(ctx);
  const collected = collectNew(timeSpecs(await timeChoices(ctx.db), "new"), ctx.form);
  const input = collected.input as { contact?: string; deal?: string; workType?: string; startedAt?: string; endedAt?: string; minutes?: number; billable?: string; notes?: string };
  if (collected.errors.length === 0) needTimes(collected);
  if (collected.errors.length === 0) {
    eitherEndOrMinutes(collected, input.endedAt !== undefined, input.minutes !== undefined);
    if (collected.errors.length === 0 && input.endedAt === undefined && input.minutes === undefined) {
      fieldError(collected, "ended", "A time entry needs an end or a length in minutes.");
    }
  }
  const refused = async (extra: string[] = []) => page(422, (await timeNewPage(timeContext(ctx, TIME_NEW_PATH), stateOf(collected, extra))) ?? "");
  if (collected.errors.length > 0 || input.startedAt === undefined) return refused();
  const entry: TimeEntryInput = { startedAt: input.startedAt };
  if (input.contact !== undefined) entry.contact = input.contact;
  if (input.deal !== undefined) entry.deal = input.deal;
  if (input.workType !== undefined) entry.workType = input.workType;
  if (input.endedAt !== undefined) entry.endedAt = input.endedAt;
  if (input.minutes !== undefined) entry.minutes = input.minutes;
  const billable = billableOf(input.billable);
  if (billable !== undefined) entry.billable = billable;
  if (input.notes !== undefined) entry.notes = input.notes;
  try {
    const result = await addTimeEntry(asOwner(ctx, "add_time_entry"), entry);
    return redirect(withChange(weekAddress(input.startedAt), result.changeId));
  } catch (error) {
    return refused([refusal(error, "time entry")]);
  }
}

/** POST /time/<id>/edit: update_time_entry with only the fields the owner changed. */
async function editEntry(ctx: ActionContext, id: string): Promise<ActionResult> {
  if (!(await trackingOn(ctx))) return notFound(ctx);
  const entry = await editableEntry(ctx, id);
  if (entry === null) return notFound(ctx);
  const tz = await ownerTimezone(ctx.db);
  const specs = timeSpecs(await timeChoices(ctx.db, entry), "edit");
  const collected = await collectEdit(specs, ctx.form, { ...entry, fields: "{}" }, tz);
  const input = collected.input as { contact?: string | null; deal?: string | null; workType?: string | null; startedAt?: string; endedAt?: string; minutes?: number; billable?: string; notes?: string | null };
  if (collected.errors.length === 0) needTimes(collected);
  if (collected.errors.length === 0) eitherEndOrMinutes(collected, input.endedAt !== undefined, input.minutes !== undefined);
  const refused = async (extra: string[] = []) => page(422, (await timeEditPage(timeContext(ctx, timeEditPath(id)), id, stateOf(collected, extra))) ?? "");
  if (collected.errors.length > 0) return refused();
  if (Object.keys(input).length === 0) return refused([NOTHING_TO_SAVE]);
  const patch: TimeEntryPatch = {};
  if (input.contact !== undefined) patch.contact = input.contact;
  if (input.deal !== undefined) patch.deal = input.deal;
  if (input.workType !== undefined) patch.workType = input.workType;
  if (input.startedAt !== undefined) patch.startedAt = input.startedAt;
  if (input.endedAt !== undefined) patch.endedAt = input.endedAt;
  if (input.minutes !== undefined) patch.minutes = input.minutes;
  const billable = billableOf(input.billable);
  if (billable !== undefined) patch.billable = billable;
  if (input.notes !== undefined) patch.notes = input.notes;
  try {
    const result = await updateTimeEntry(asOwner(ctx, "update_time_entry"), entry.id, patch);
    const saved = await editableEntry(ctx, entry.id);
    return redirect(withChange(weekAddress(localDateOf(saved?.started_at ?? entry.started_at, tz)), result.changeId));
  } catch (error) {
    return refused([refusal(error, "time entry")]);
  }
}

/** POST /time/<id>/archive: update_time_entry with archived on. Then the week it was in; Undo brings it back. */
async function archiveEntry(ctx: ActionContext, id: string): Promise<ActionResult> {
  if (!(await trackingOn(ctx))) return notFound(ctx);
  const entry = await editableEntry(ctx, id);
  if (entry === null) return notFound(ctx);
  const tz = await ownerTimezone(ctx.db);
  try {
    const result = await updateTimeEntry(asOwner(ctx, "update_time_entry"), entry.id, { archived: true });
    return redirect(withChange(weekAddress(localDateOf(entry.started_at, tz)), result.changeId));
  } catch (error) {
    return page(422, refusedPage(ctx, "The entry wasn't archived", refusal(error, "time entry"), weekAddress(localDateOf(entry.started_at, tz)), ""));
  }
}

export const TIME_ROUTES: Route[] = [
  { path: /^\/timer\/(start)$/, handle: (ctx) => start(ctx) },
  { path: /^\/timer\/(stop)$/, handle: (ctx) => stop(ctx), big: true },
  { path: /^\/timer\/stop\/(now)$/, handle: (ctx) => stopNow(ctx) },
  { path: /^\/timer\/(cancel)$/, handle: (ctx) => cancel(ctx) },
  { path: /^\/timer\/(notes)$/, handle: (ctx) => notes(ctx), big: true },
  { path: /^\/time\/(new)$/, handle: (ctx) => addEntry(ctx), big: true },
  { path: /^\/time\/([^/]+)\/edit$/, handle: editEntry, big: true },
  { path: /^\/time\/([^/]+)\/archive$/, handle: archiveEntry },
];
