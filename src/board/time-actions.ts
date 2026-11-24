// The timer's board posts (decision 0050): Start timer and the stop form. Each calls the service the matching MCP tool
// calls (start_timer, stop_timer) as the owner under that tool's name; the AI edits setting does not apply to the board.
// While time tracking is off every path here is a 404. A refused stop draws the form again (422) with the values kept.
import { getSettings } from "../db/queries.ts";
import { isContactId, isDealId, isTaskId } from "../ids.ts";
import { UserError } from "../services/errors.ts";
import { runningTimer } from "../services/time-entries.ts";
import { startTimer, type StopInput, stopTimer } from "../services/timer.ts";
import { type ActionContext, type ActionResult, asOwner, backTo, fieldError, notFound, page, pageContext, redirect, refusal, refusedPage, type Route } from "./action-kit.ts";
import { timerStopPage, stopSpecs, TIMER_STOP_PATH } from "./pages/timer-stop.ts";
import { collectNew, postedValue, type Shown } from "./record-form.ts";
import { withChange } from "./return-to.ts";
import { listWorkTypes } from "../services/work-types.ts";
import { TIMER_DONE_PATH } from "./pages/timer-done.ts";

const trackingOn = async (ctx: ActionContext): Promise<boolean> => (await getSettings(ctx.db)).time_tracking === 1;

type Ref = { contact?: string; deal?: string; task?: string };

/** The one subject a Start form names, or null when its id can't be a record's. */
function subjectOf(form: URLSearchParams): Ref | null {
  const contact = form.get("contact") ?? "";
  const deal = form.get("deal") ?? "";
  const task = form.get("task") ?? "";
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
    return redirect(withChange(back, result.changeId));
  } catch (error) {
    return page(422, refusedPage(ctx, "The timer wasn't started", refusal(error, "timer"), back, ""));
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
  for (const name of ["started", "ended"] as const) {
    const spec = specs.find((item) => item.name === name);
    const posted = spec === undefined ? null : postedValue(ctx.form, spec);
    const item: Shown | undefined = collected.shown.get(name);
    if (item !== undefined) item.was = ctx.form.get(`was.${name}`) ?? undefined;
    if (posted !== null && posted !== "" && !posted.includes("T") && !collected.errors.some((error) => error.name === name)) {
      fieldError(collected, name, "Give the time too.");
    }
  }
  const refused = async (extra: string[] = []) =>
    page(
      422,
      (await timerStopPage(pageContext(ctx, here), { shown: collected.shown, billable, errors: [...collected.errors, ...extra.map((message) => ({ message }))] })) ?? "",
    );
  if ((await runningTimer(ctx.db)) === null) return refused(["No timer is running."]);
  if (collected.errors.length > 0) return refused();
  const input = collected.input as { notes?: string; workType?: string; nextStepDate?: string; startedAt?: string; endedAt?: string };
  const stopInput: StopInput = { billable };
  if (input.notes !== undefined) stopInput.notes = input.notes;
  if (input.workType !== undefined) stopInput.workType = input.workType;
  if (input.nextStepDate !== undefined) stopInput.nextStepDate = input.nextStepDate;
  // A start or end left as the form drew it is not sent: the timer keeps its own start, and "now" is the moment of saving.
  if (input.startedAt !== undefined && input.startedAt !== ctx.form.get("was.started")) stopInput.startedAt = input.startedAt;
  if (input.endedAt !== undefined && input.endedAt !== ctx.form.get("was.ended")) stopInput.endedAt = input.endedAt;
  try {
    const result = await stopTimer(asOwner(ctx, "stop_timer"), stopInput);
    return redirect(withChange(`${TIMER_DONE_PATH}?entry=${encodeURIComponent(result.entryId)}`, result.changeId));
  } catch (error) {
    return refused([refusal(error, "time entry")]);
  }
}

export const TIME_ROUTES: Route[] = [
  { path: /^\/timer\/(start)$/, handle: (ctx) => start(ctx) },
  { path: /^\/timer\/(stop)$/, handle: (ctx) => stop(ctx), big: true },
];
