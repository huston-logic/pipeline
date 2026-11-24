// start_timer and stop_timer (decision 0049). The running timer is a time entry with no end; at most one runs (the
// one-running index, migration 0018). Stopping fixes its end, minutes and rate in one change that also logs the notes
// as a note on its person or deal and adds a "Next step" task when asked. A timer left running longer than 16 hours
// can't be stopped without its real start or end.
import type { ActivityRow, TaskRow, TimeEntryRow } from "../db/db.ts";
import { newId } from "../ids.ts";
import { formatLocal, localDate, localWhen, parseWhen } from "../time.ts";
import { activityEffects } from "./activities.ts";
import { type ChangeResult, commitChange, type Ctx, isRunningTimerFailure, rowKey, type RowChange, updatedRow } from "./change.ts";
import { rowLabel } from "./describe.ts";
import { UserError } from "./errors.ts";
import { clean, whenOrNull } from "./input.ts";
import { isTrusted } from "./labels.ts";
import { contactById, dealById, ownerTimezone, type Source, sourceOf, workTypeById } from "./lookup.ts";
import { requireTimeTracking } from "./settings.ts";
import {
  ENTRY_MAX_MINUTES,
  entryLine,
  forWho,
  minutesBetween,
  rateFor,
  resolveLinks,
  runningTimer,
  tooLong,
} from "./time-entries.ts";
import { formatDuration } from "./time-format.ts";
import { findWorkType } from "./work-types.ts";

export { runningTimer };

export interface TimerSubject {
  contact?: string;
  deal?: string;
  task?: string;
  workType?: string;
}

export interface StopInput {
  /** What was done: kept on the entry, and logged as a note on its person or deal. Owner text. */
  notes?: string;
  workType?: string;
  billable?: boolean;
  /** Adds the task "Next step" (or "Next step: <deal title>") due then, on the same person or deal. */
  nextStepDate?: string;
  /** The real start, for a timer started late or left running. */
  startedAt?: string;
  /** The real end; the default is now. */
  endedAt?: string;
}

/** "10:00 AM", or "Wed Nov 18, 9:10 AM" when it wasn't today. */
function sinceText(at: string, now: Date, tz: string): string {
  const full = formatLocal(at, tz);
  return localDate(new Date(at), tz) === localDate(now, tz) ? (full.split(", ").at(-1) ?? full) : full;
}

/** "A timer is already running for <label> since 9:10 AM. Stop it first." for the timer running now, or null. */
export async function runningTimerRefusal(src: Source, now: Date): Promise<string | null> {
  const running = await runningTimer(src);
  return running === null ? null : alreadyRunning(src, running, now, await ownerTimezone(sourceOf(src).db));
}

async function alreadyRunning(src: Source, running: TimeEntryRow, now: Date, tz: string): Promise<string> {
  const deal = running.deal_id === null ? null : await dealById(src, running.deal_id);
  const contact = running.contact_id === null ? null : await contactById(src, running.contact_id);
  const who = forWho(deal, contact);
  return `A timer is already running${who === null ? "" : ` for ${who}`} since ${sinceText(running.started_at, now, tz)}. Stop it first.`;
}

export async function startTimer(ctx: Ctx, subject: TimerSubject): Promise<ChangeResult & { entryId: string }> {
  const { db } = ctx;
  await requireTimeTracking(db);
  const tz = await ownerTimezone(db);
  const running = await runningTimer(ctx);
  if (running) throw new UserError(await alreadyRunning(ctx, running, ctx.now, tz));
  const links = await resolveLinks(ctx, subject);
  const workType = subject.workType === undefined ? null : await findWorkType(ctx, subject.workType);
  const now = ctx.now.toISOString();
  const row: TimeEntryRow = {
    id: newId("te"),
    contact_id: links.contact?.id ?? null,
    deal_id: links.deal?.id ?? null,
    task_id: links.task?.id ?? null,
    started_at: now,
    ended_at: null,
    minutes: null,
    work_type_id: workType?.id ?? null,
    billable: workType?.billable_default === 1 ? 1 : 0,
    // Fixed when the timer stops.
    rate: null,
    notes: null,
    activity_id: null,
    archived: 0,
    untrusted_fields: "[]",
    version: 1,
    created_at: now,
    updated_at: now,
  };
  const line = await entryLine(ctx, row);
  try {
    const result = await commitChange(ctx, {
      target: { table: "time_entries", id: row.id },
      summary: `Started a timer at ${sinceText(now, ctx.now, tz)}${line === "" ? "" : `: ${line}`}`,
      changes: [{ table: "time_entries", id: row.id, before: null, after: row }],
    });
    return { ...result, entryId: row.id };
  } catch (error) {
    // Another start won the race: answer as if it had been there first.
    const other = isRunningTimerFailure(error) ? await runningTimer(db) : null;
    if (other) throw new UserError(await alreadyRunning(db, other, ctx.now, tz), { cause: error });
    throw error;
  }
}

/** "Fri Nov 20", or "Fri Nov 20, 9:00 AM" when a time was given. */
function dueText(at: string, tz: string): string {
  const full = formatLocal(at, tz);
  return localWhen(at, tz).includes("T") ? full : (full.split(",")[0] ?? full);
}

export async function stopTimer(
  ctx: Ctx,
  input: StopInput,
): Promise<ChangeResult & { entryId: string; activityId: string | null; taskId: string | null }> {
  const { db } = ctx;
  await requireTimeTracking(db);
  const tz = await ownerTimezone(db);
  const running = await runningTimer(ctx);
  if (!running) throw new UserError("No timer is running. Start one with start_timer, or add the time with add_time_entry.");
  if (ctx.plan?.reads()[rowKey("time_entries", running.id)] === null) {
    throw new UserError("A timer started in this list can't be stopped in the same list. Use add_time_entry with the start and end instead.");
  }

  const start = input.startedAt === undefined ? new Date(running.started_at) : parseWhen(input.startedAt, tz);
  const end = input.endedAt === undefined ? ctx.now : parseWhen(input.endedAt, tz);
  if (end.getTime() < start.getTime()) throw new UserError("The end must be after the start. Edit the start or end.");
  if (end.getTime() > ctx.now.getTime()) throw new UserError("A time entry can't end in the future. Give an end that has passed.");
  const minutes = minutesBetween(start, end);
  if (minutes > ENTRY_MAX_MINUTES) {
    if (input.startedAt !== undefined || input.endedAt !== undefined) throw new UserError(tooLong(minutes));
    throw new UserError(
      `The timer has been running since ${formatLocal(start, tz)} (${formatDuration(minutes)}), and an entry can be at most ` +
        "16 hours. Edit the start or end: stop it with startedAt or endedAt.",
    );
  }

  const deal = running.deal_id === null ? null : await dealById(ctx, running.deal_id);
  const contact = running.contact_id === null ? null : await contactById(ctx, running.contact_id);
  const workType =
    input.workType !== undefined ? await findWorkType(ctx, input.workType) : running.work_type_id === null ? null : await workTypeById(ctx, running.work_type_id);
  const billable = input.billable ?? (input.workType !== undefined ? workType?.billable_default === 1 : running.billable === 1);
  const notes = clean(input.notes ?? null);
  const stamp = ctx.now.toISOString();
  const changes: RowChange[] = [];
  const parts: string[] = [];

  let activityId: string | null = null;
  if (notes !== null && contact !== null) {
    // Logged now, as log_activity logs a note: the moment the owner wrote it.
    const activity: ActivityRow = {
      id: newId("ac"),
      deal_id: deal?.id ?? null,
      contact_id: contact.id,
      type: "note",
      summary: notes,
      untrusted_text: null,
      data: null,
      occurred_at: stamp,
      actor: ctx.actor,
      version: 1,
      created_at: stamp,
    };
    const effects = await activityEffects(ctx, activity, deal, contact, ctx.now);
    changes.push({ table: "activities", id: activity.id, before: null, after: activity }, ...effects.changes);
    activityId = activity.id;
    parts.push("logged a note");
  }

  let taskId: string | null = null;
  if (input.nextStepDate !== undefined) {
    const task: TaskRow = {
      id: newId("tk"),
      deal_id: deal?.id ?? null,
      contact_id: contact?.id ?? null,
      title: deal !== null && isTrusted(deal, "title") ? `Next step: ${deal.title}` : "Next step",
      due_at: whenOrNull(input.nextStepDate, tz),
      done_at: null,
      snoozed_until: null,
      source: "owner",
      untrusted_fields: "[]",
      version: 1,
      created_at: stamp,
      updated_at: stamp,
    };
    changes.push({ table: "tasks", id: task.id, before: null, after: task });
    taskId = task.id;
    parts.push(`added ${rowLabel("tasks", task)}${task.due_at === null ? "" : ` due ${dueText(task.due_at, tz)}`}`);
  }

  // Last, so the note it points at is written first and an undo clears the link before removing the note.
  const after = updatedRow(
    running,
    {
      started_at: start.toISOString(),
      ended_at: end.toISOString(),
      minutes,
      work_type_id: workType?.id ?? null,
      billable: billable ? 1 : 0,
      rate: billable ? await rateFor(db, workType?.id ?? null, contact?.id ?? null) : null,
      notes: notes ?? running.notes,
      activity_id: activityId ?? running.activity_id,
    },
    ctx.now,
  );
  changes.push({ table: "time_entries", id: running.id, before: running, after });
  const result = await commitChange(ctx, {
    target: { table: "time_entries", id: running.id },
    summary: [`Stopped the timer: ${await entryLine(ctx, after)}`, ...parts].join("; "),
    changes,
  });
  return { ...result, entryId: running.id, activityId, taskId };
}
