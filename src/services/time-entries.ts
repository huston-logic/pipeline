// add_time_entry and update_time_entry (decision 0049). An entry is time worked: a start, an end and its minutes (1 to
// 960, 16 hours), for a person, a deal (and so its person), a task, or nothing. When billable it keeps the hourly rate
// used at the moment it is saved (rateFor: the person's own rate for the work type, else the work type's), so a later
// rate change never rewrites it; editing its work type, person or billable works the rate out again from today's rates.
// Entries are archived, never deleted. Every read by id goes through lookup.ts, so a proposal's later actions see what
// the earlier ones planned (decision 0044).
import type { ContactRow, DealRow, ProjectRow, TaskRow, TimeEntryRow, WorkTypeRow } from "../db/db.ts";
import { isTimeEntryId, newId } from "../ids.ts";
import { formatLocal, parseWhen } from "../time.ts";
import {
  type ChangeResult,
  changedColumns,
  commitChange,
  type Ctx,
  isRunningTimerFailure,
  type Row,
  updatedRow,
} from "./change.ts";
import { capitalize, rowLabel, short } from "./describe.ts";
import { UserError } from "./errors.ts";
import { clean } from "./input.ts";
import { contactName, dealLabel, projectLabel, projectTitle } from "./labels.ts";
import {
  contactById,
  dealById,
  findSubject,
  ownerTimezone,
  projectById,
  type Source,
  sourceOf,
  taskById,
  timeEntryById,
  withPlanned,
  workTypeById,
} from "./lookup.ts";
import { checkGiven, projectSubject } from "./project-links.ts";
import { requireProjects, requireTimeTracking } from "./settings.ts";
import { formatDuration, timeLine, timerLine } from "./time-format.ts";
import { findWorkType } from "./work-types.ts";

/** The longest entry: 16 hours. */
export const ENTRY_MAX_MINUTES = 960;
const MINUTE_MS = 60_000;

export interface TimeEntryInput {
  /** Contact id or exact name. */
  contact?: string;
  /** Deal id, exact title, or its contact's exact name. */
  deal?: string;
  /** Task id. */
  task?: string;
  /** Project id or exact name: its person is the entry's person, with no deal. */
  project?: string;
  startedAt: string;
  endedAt?: string;
  minutes?: number;
  /** Work type name or id. */
  workType?: string;
  billable?: boolean;
  notes?: string;
}

/** An edit: only what changes. null clears a link, the work type or the notes. */
export interface TimeEntryPatch {
  contact?: string | null;
  deal?: string | null;
  task?: string | null;
  /** null leaves the project and keeps the person. */
  project?: string | null;
  startedAt?: string;
  endedAt?: string;
  minutes?: number;
  workType?: string | null;
  billable?: boolean;
  notes?: string | null;
  archived?: boolean;
}

/** What an entry is for. */
export interface TimeLinks {
  contact: ContactRow | null;
  deal: DealRow | null;
  task: TaskRow | null;
  project: ProjectRow | null;
}

/** Who an entry is for, as summaries name them: a project and its person, a deal and its person, a person, or null for no one. */
export function forWho(deal: DealRow | null, contact: ContactRow | null, project: ProjectRow | null = null): string | null {
  if (project && contact) return projectLabel(project, contact);
  if (deal && contact) return dealLabel(deal, contact);
  return contact ? contactName(contact) : null;
}

async function findTask(src: Source, ref: string): Promise<TaskRow> {
  const id = ref.trim();
  const found = id === "" ? null : await taskById(src, id);
  if (!found) throw new UserError(`No task "${short(id, 40)}". Use list_tasks to find the task's id.`);
  return found;
}

/**
 * The links of an entry, checked like a task's: a deal's person is the entry's person, and a task's deal and person
 * are used when neither is given. A task given with a deal or person must be theirs.
 */
export async function resolveLinks(
  src: Source,
  refs: { contact?: string | null; deal?: string | null; task?: string | null; project?: string | null },
): Promise<TimeLinks> {
  const task = refs.task === undefined || refs.task === null ? null : await findTask(src, refs.task);
  const taskProject = task?.project_id ?? null;
  const named = { dealId: refs.deal, contactId: refs.contact };
  if (typeof refs.project === "string") {
    // A project gives the entry its person and no deal; a task given with it must be the project's own.
    const { project, contact } = await projectSubject(src, refs.project, named);
    if (task !== null && taskProject !== project.id) {
      const where = taskProject === null ? "is not on a project" : "is on another project";
      throw new UserError(`${capitalize(rowLabel("tasks", task))} ${where}. Give a task of ${projectTitle(project)}, or leave the task out.`);
    }
    return { contact, deal: null, task, project };
  }
  if (task !== null && taskProject !== null) {
    if (refs.project === null) {
      throw new UserError(`${capitalize(rowLabel("tasks", task))} is on a project. Clear the task too, or keep the project.`);
    }
    // A task of a project, given alone, puts the entry on that project.
    const project = await projectById(src, taskProject);
    const owner = project === null ? null : await contactById(src, project.contact_id);
    if (project === null || owner === null) throw new Error(`Task ${task.id} points at a missing project.`);
    await checkGiven(src, { project, contact: owner }, named);
    return { contact: owner, deal: null, task, project };
  }
  const given = (refs.deal ?? null) !== null || (refs.contact ?? null) !== null;
  const subject =
    task !== null && !given
      ? task.deal_id !== null
        ? { dealId: task.deal_id }
        : { contactId: task.contact_id ?? undefined }
      : { dealId: refs.deal ?? undefined, contactId: refs.contact ?? undefined };
  const { deal, contact } = await findSubject(src, subject, { optional: true });
  if (task !== null && given) {
    const taskDeal = task.deal_id === null ? null : await dealById(src, task.deal_id);
    const taskContactId = task.contact_id ?? taskDeal?.contact_id ?? null;
    const otherDeal = task.deal_id !== null && deal !== null && deal.id !== task.deal_id;
    const otherPerson = taskContactId !== null && contact !== null && contact.id !== taskContactId;
    if (otherDeal || otherPerson) {
      const taskContact = taskContactId === null ? null : await contactById(src, taskContactId);
      const who = forWho(taskDeal, taskContact) ?? "no one";
      throw new UserError(`${capitalize(rowLabel("tasks", task))} is for ${who}. Give just the task, or its own deal or person.`);
    }
  }
  return { contact, deal, task, project: null };
}

/** The hourly rate an entry uses: the person's own rate for the work type beats the work type's; null with neither. */
export async function rateFor(src: Source, workTypeId: string | null, contactId: string | null): Promise<number | null> {
  if (workTypeId === null) return null;
  if (contactId !== null) {
    const own = await sourceOf(src)
      .db
      .prepare("SELECT hourly_rate FROM client_rates WHERE work_type_id = ? AND contact_id = ? AND archived = 0")
      .bind(workTypeId, contactId)
      .first<number>("hourly_rate");
    if (own !== null) return own;
  }
  return (await workTypeById(src, workTypeId))?.hourly_rate ?? null;
}

/** The long-entry refusal, shared with the timer's stop. */
export const tooLong = (minutes: number) =>
  `A time entry can be at most 16 hours; this one is ${formatDuration(minutes)}. Edit the start or end.`;

/** Minutes between two instants, rounded up to the whole minute, at least 1. */
export const minutesBetween = (start: Date, end: Date) => Math.max(1, Math.ceil((end.getTime() - start.getTime()) / MINUTE_MS));

/**
 * A finished entry's span from its start and either an end or minutes (the other is worked out): 1 to 960 minutes,
 * the end after the start and not in the future.
 */
function finishedSpan(start: Date, end: Date | null, minutes: number | null, now: Date): { end: Date; minutes: number } {
  let span: { end: Date; minutes: number };
  if (minutes !== null) {
    if (!Number.isInteger(minutes) || minutes < 1) throw new UserError(`Minutes must be a whole number from 1 to ${ENTRY_MAX_MINUTES} (16 hours).`);
    span = { end: new Date(start.getTime() + minutes * MINUTE_MS), minutes };
  } else if (end !== null) {
    if (end.getTime() <= start.getTime()) throw new UserError("The end must be after the start. Edit the start or end.");
    span = { end, minutes: minutesBetween(start, end) };
  } else {
    throw new UserError("A time entry needs an end (endedAt) or a length in minutes.");
  }
  if (span.minutes > ENTRY_MAX_MINUTES) throw new UserError(tooLong(span.minutes));
  if (span.end.getTime() > now.getTime()) throw new UserError("A time entry can't end in the future. Add it once the work is done, or start a timer.");
  return span;
}

/** Who an entry is for, read by id: its project and person, its deal and person, a person, or null. */
export async function whoOf(src: Source, row: TimeEntryRow): Promise<string | null> {
  const deal = row.deal_id === null ? null : await dealById(src, row.deal_id);
  const contact = row.contact_id === null ? null : await contactById(src, row.contact_id);
  const project = row.project_id == null ? null : await projectById(src, row.project_id);
  return forWho(deal, contact, project);
}

/** How an entry reads: "1 h 30 min, Design, billable at $95.00/h ($142.50), for Pat Example"; a running one "Design, for ...". */
export async function entryLine(src: Source, row: TimeEntryRow): Promise<string> {
  const workType = row.work_type_id === null ? null : ((await workTypeById(src, row.work_type_id))?.name ?? null);
  const who = await whoOf(src, row);
  if (row.minutes === null) return timerLine(workType, who);
  return timeLine({ minutes: row.minutes, workType, billable: row.billable === 1, rate: row.rate, who });
}

const linkColumns = (links: TimeLinks) => ({
  contact_id: links.contact?.id ?? null,
  deal_id: links.deal?.id ?? null,
  task_id: links.task?.id ?? null,
  project_id: links.project?.id ?? null,
});

const billableOf = (input: boolean | undefined, workType: WorkTypeRow | null) => input ?? workType?.billable_default === 1;

export async function addTimeEntry(ctx: Ctx, input: TimeEntryInput): Promise<ChangeResult & { entryId: string }> {
  await requireTimeTracking(ctx);
  const tz = await ownerTimezone(ctx);
  const start = parseWhen(input.startedAt, tz);
  if (input.endedAt !== undefined && input.minutes !== undefined) throw new UserError("Give endedAt or minutes, not both.");
  const end = input.endedAt === undefined ? null : parseWhen(input.endedAt, tz);
  const span = finishedSpan(start, end, input.minutes ?? null, ctx.now);
  const links = await resolveLinks(ctx, input);
  const workType = input.workType === undefined ? null : await findWorkType(ctx, input.workType);
  const billable = billableOf(input.billable, workType);
  const now = ctx.now.toISOString();
  const row: TimeEntryRow = {
    id: newId("te"),
    ...linkColumns(links),
    started_at: start.toISOString(),
    ended_at: span.end.toISOString(),
    minutes: span.minutes,
    work_type_id: workType?.id ?? null,
    billable: billable ? 1 : 0,
    rate: billable ? await rateFor(ctx, workType?.id ?? null, links.contact?.id ?? null) : null,
    notes: clean(input.notes ?? null),
    activity_id: null,
    archived: 0,
    untrusted_fields: "[]",
    version: 1,
    created_at: now,
    updated_at: now,
  };
  const result = await commitChange(ctx, {
    target: { table: "time_entries", id: row.id },
    summary: `Added time ${await entryLine(ctx, row)}, started ${formatLocal(start, tz)}`,
    changes: [{ table: "time_entries", id: row.id, before: null, after: row }],
  });
  return { ...result, entryId: row.id };
}

async function findEntry(src: Source, ref: string): Promise<TimeEntryRow> {
  const id = ref.trim();
  const found = isTimeEntryId(id) ? await timeEntryById(src, id) : null;
  if (!found) throw new UserError(`No time entry "${short(id, 40)}". Use list_time to find the entry's id.`);
  return found;
}

const isRunning = (row: Row) => row.ended_at === null && row.archived === 0;

/** The running timer (the live entry with no end), as the plan (if any) leaves it; null when none runs. */
export async function runningTimer(src: Source): Promise<TimeEntryRow | null> {
  const { db } = sourceOf(src);
  const found = await db.prepare("SELECT * FROM time_entries WHERE ended_at IS NULL AND archived = 0").all<TimeEntryRow>();
  return withPlanned(src, "time_entries", found.results, isRunning)[0] ?? null;
}

/** The running timer other than `id`. */
async function otherRunning(src: Source, id: string): Promise<TimeEntryRow | null> {
  const running = await runningTimer(src);
  return running !== null && running.id !== id ? running : null;
}

const ANOTHER_RUNNING = "Another timer is running. Stop it first, or leave this one archived.";

export async function updateTimeEntry(ctx: Ctx, ref: string, patch: TimeEntryPatch): Promise<ChangeResult & { entryId: string }> {
  await requireTimeTracking(ctx);
  const tz = await ownerTimezone(ctx);
  const before = await findEntry(ctx, ref);
  const label = rowLabel("time_entries", before);
  const edits = Object.entries(patch).some(([key, value]) => key !== "archived" && value !== undefined);
  if (before.archived === 1 && patch.archived !== false && edits) {
    throw new UserError(`${capitalize(label)} is archived. Restore it first (archived false).`);
  }
  const running = before.ended_at === null;
  if (running && (patch.endedAt !== undefined || patch.minutes !== undefined)) {
    throw new UserError(`${capitalize(label)} is the running timer. Stop it with stop_timer to give its end.`);
  }
  if (patch.endedAt !== undefined && patch.minutes !== undefined) throw new UserError("Give endedAt or minutes, not both.");

  const set: Partial<TimeEntryRow> = {};
  const start = patch.startedAt === undefined ? new Date(before.started_at) : parseWhen(patch.startedAt, tz);
  if (running) {
    if (start.getTime() > ctx.now.getTime()) throw new UserError("A timer can't start in the future. Give a start that has passed.");
    set.started_at = start.toISOString();
  } else if (patch.startedAt !== undefined || patch.endedAt !== undefined || patch.minutes !== undefined) {
    // Moving the start keeps the end; giving minutes keeps the start.
    const end = patch.minutes !== undefined ? null : patch.endedAt === undefined ? new Date(String(before.ended_at)) : parseWhen(patch.endedAt, tz);
    const span = finishedSpan(start, end, patch.minutes ?? null, ctx.now);
    Object.assign(set, { started_at: start.toISOString(), ended_at: span.end.toISOString(), minutes: span.minutes });
  }

  const linked = patch.contact !== undefined || patch.deal !== undefined || patch.task !== undefined || patch.project !== undefined;
  let contactId = before.contact_id;
  if (linked) {
    if (patch.project === null) await requireProjects(ctx);
    const fromTask = typeof patch.task === "string" && patch.contact === undefined && patch.deal === undefined && patch.project === undefined;
    // The entry stays on its project unless the edit clears it or gives a deal; a new project brings its own person.
    const project = patch.project !== undefined ? patch.project : typeof patch.deal === "string" ? undefined : (before.project_id ?? undefined);
    const onProject = typeof project === "string";
    const links = await resolveLinks(
      ctx,
      fromTask
        ? { task: patch.task }
        : {
            task: patch.task !== undefined ? patch.task : before.task_id,
            deal: patch.deal !== undefined ? patch.deal : onProject && patch.project !== undefined ? undefined : before.deal_id,
            // A new deal brings its own person; otherwise the person stays unless given.
            contact:
              patch.contact !== undefined ? patch.contact : typeof patch.deal === "string" || (onProject && patch.project !== undefined) ? null : before.contact_id,
            project,
          },
    );
    Object.assign(set, linkColumns(links));
    contactId = links.contact?.id ?? null;
  }
  let workTypeId = before.work_type_id;
  if (patch.workType !== undefined) {
    workTypeId = patch.workType === null ? null : (await findWorkType(ctx, patch.workType)).id;
    set.work_type_id = workTypeId;
  }
  const billable = patch.billable ?? before.billable === 1;
  set.billable = billable ? 1 : 0;
  const reprice = patch.workType !== undefined || patch.billable !== undefined || contactId !== before.contact_id;
  if (running || !billable) set.rate = null;
  else if (reprice) set.rate = await rateFor(ctx, workTypeId, contactId);
  if (patch.notes !== undefined) set.notes = clean(patch.notes);
  if (patch.archived !== undefined) set.archived = patch.archived ? 1 : 0;

  const after = updatedRow(before, set, ctx.now);
  const changed = changedColumns(before, after).filter((column) => column !== "version" && column !== "updated_at");
  if (changed.length === 0) throw new UserError(`Nothing to change on ${label}: every value you gave is already set.`);
  if (after.ended_at === null && after.archived === 0 && before.archived === 1 && (await otherRunning(ctx, before.id)) !== null) {
    throw new UserError(ANOTHER_RUNNING);
  }

  const line = await entryLine(ctx, after);
  let summary: string;
  if (changed.includes("archived")) {
    summary = `${after.archived === 1 ? "Archived" : "Restored"} ${label} (${await entryLine(ctx, after.archived === 1 ? before : after)})`;
  } else {
    summary = running ? `Updated the running timer ${before.id}: now ${line || "for no one"}, since ${formatLocal(after.started_at, tz)}` : `Updated ${label}: now ${line}`;
  }
  try {
    const result = await commitChange(ctx, {
      target: { table: "time_entries", id: before.id },
      summary,
      changes: [{ table: "time_entries", id: before.id, before, after }],
    });
    return { ...result, entryId: before.id };
  } catch (error) {
    if (isRunningTimerFailure(error)) throw new UserError(ANOTHER_RUNNING, { cause: error });
    throw error;
  }
}
