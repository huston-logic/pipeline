// add_task, complete_task and snooze_task.
import type { ContactRow, DealRow, TaskRow } from "../db/db.ts";
import { newId } from "../ids.ts";
import { formatLocal, parseWhen } from "../time.ts";
import { type ChangeResult, commitChange, type Ctx, type Row, updatedRow } from "./change.ts";
import { capitalize, rowLabel } from "./describe.ts";
import { UserError } from "./errors.ts";
import { clean, whenOrNull } from "./input.ts";
import { contactName, dealLabel } from "./labels.ts";
import { contactById, dealById, findSubject, ownerTimezone, type Source, taskById } from "./lookup.ts";

export interface TaskInput {
  /** Deal id, title or contact name. */
  dealId?: string;
  /** Contact id or name. */
  contactId?: string;
  title: string;
  dueAt?: string;
}

/** Who a task is for, as summaries name them: a deal and its person, a person, or null for a task of no one's. */
function forWhomOf(deal: DealRow | null, contact: ContactRow | null): string | null {
  if (deal && contact) return dealLabel(deal, contact);
  return contact ? contactName(contact) : null;
}

const forText = (who: string | null) => (who === null ? "" : ` for ${who}`);

/** Adds a task on a deal, a contact, or neither (a standalone task, decision 0046). */
export async function addTask(ctx: Ctx, input: TaskInput): Promise<ChangeResult & { taskId: string }> {
  const { db } = ctx;
  const title = clean(input.title);
  if (title === null) throw new UserError("A task needs a title. Say in a few words what to do.");
  const tz = await ownerTimezone(db);
  const dueAt = whenOrNull(input.dueAt ?? null, tz);
  const { deal, contact } = await findSubject(ctx, input, { optional: true });
  const now = ctx.now.toISOString();

  const task: TaskRow = {
    id: newId("tk"),
    deal_id: deal?.id ?? null,
    contact_id: contact?.id ?? null,
    title,
    due_at: dueAt,
    done_at: null,
    snoozed_until: null,
    source: "owner",
    untrusted_fields: "[]",
    version: 1,
    created_at: now,
    updated_at: now,
  };
  const due = dueAt === null ? "" : `, due ${formatLocal(dueAt, tz)}`;
  const result = await commitChange(ctx, {
    target: { table: "tasks", id: task.id },
    summary: `Added task "${title}"${forText(forWhomOf(deal, contact))}${due}`,
    changes: [{ table: "tasks", id: task.id, before: null, after: task }],
  });
  return { ...result, taskId: task.id };
}

/** task "Call back", or task tk_… when the title came from outside. */
const taskName = (task: TaskRow) => rowLabel("tasks", task as Row);

async function findTask(src: Source, ref: string): Promise<TaskRow> {
  const id = ref.trim();
  if (id === "") throw new UserError("Say which task: give its id (tk_...) from whats_due or get_deal.");
  const found = await taskById(src, id);
  if (!found) throw new UserError(`No task "${id}". Use whats_due or get_deal to find the task's id.`);
  return found;
}

/**
 * "task \"Call back\" for \"Website refresh\" (Pat Example)", each part safe on its own; a standalone task is its name
 * alone.
 */
async function describeTask(src: Source, task: TaskRow): Promise<string> {
  const deal = task.deal_id === null ? null : await dealById(src, task.deal_id);
  const contactId = task.contact_id ?? deal?.contact_id ?? null;
  const contact = contactId === null ? null : await contactById(src, contactId);
  return `${taskName(task)}${forText(forWhomOf(deal, contact))}`;
}

export async function completeTask(ctx: Ctx, ref: string): Promise<ChangeResult & { taskId: string }> {
  const { db } = ctx;
  const before = await findTask(ctx, ref);
  if (before.done_at !== null) {
    const tz = await ownerTimezone(db);
    throw new UserError(`${capitalize(taskName(before))} is already done (${formatLocal(before.done_at, tz)}). Nothing to do.`);
  }
  const after = updatedRow(before, { done_at: ctx.now.toISOString() }, ctx.now);
  const result = await commitChange(ctx, {
    target: { table: "tasks", id: before.id },
    summary: `Completed ${await describeTask(ctx, before)}`,
    changes: [{ table: "tasks", id: before.id, before, after }],
  });
  return { ...result, taskId: before.id };
}

export async function snoozeTask(ctx: Ctx, ref: string, until: string): Promise<ChangeResult & { taskId: string }> {
  const { db } = ctx;
  const tz = await ownerTimezone(db);
  const before = await findTask(ctx, ref);
  if (before.done_at !== null) {
    throw new UserError(`${capitalize(taskName(before))} is already done, so there is nothing to snooze.`);
  }
  const wake = parseWhen(until, tz);
  if (wake.getTime() <= ctx.now.getTime()) {
    throw new UserError(
      `A task can only be snoozed to a time in the future; ${formatLocal(wake, tz)} has already passed. Give a later time.`,
    );
  }
  const snoozedUntil = wake.toISOString();
  if (before.snoozed_until === snoozedUntil) {
    throw new UserError(`${capitalize(taskName(before))} is already snoozed until ${formatLocal(wake, tz)}. Nothing to change.`);
  }
  const after = updatedRow(before, { snoozed_until: snoozedUntil }, ctx.now);
  const result = await commitChange(ctx, {
    target: { table: "tasks", id: before.id },
    summary: `Snoozed ${await describeTask(ctx, before)} until ${formatLocal(wake, tz)}`,
    changes: [{ table: "tasks", id: before.id, before, after }],
  });
  return { ...result, taskId: before.id };
}
