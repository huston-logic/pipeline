// add_task. Completing and snoozing tasks arrive in task 5.
import type { TaskRow } from "../db/db.ts";
import { newId } from "../ids.ts";
import { formatLocal } from "../time.ts";
import { type ChangeResult, commitChange, type Ctx } from "./change.ts";
import { UserError } from "./errors.ts";
import { clean, whenOrNull } from "./input.ts";
import { findSubject, ownerTimezone } from "./lookup.ts";

export interface TaskInput {
  /** Deal id, title or contact name. */
  dealId?: string;
  /** Contact id or name. */
  contactId?: string;
  title: string;
  dueAt?: string;
}

export async function addTask(ctx: Ctx, input: TaskInput): Promise<ChangeResult & { taskId: string }> {
  const { db } = ctx;
  const title = clean(input.title);
  if (title === null) throw new UserError("A task needs a title. Say in a few words what to do.");
  const tz = await ownerTimezone(db);
  const dueAt = whenOrNull(input.dueAt ?? null, tz);
  const { deal, contact } = await findSubject(db, input);
  const now = ctx.now.toISOString();

  const task: TaskRow = {
    id: newId("tk"),
    deal_id: deal?.id ?? null,
    contact_id: contact.id,
    title,
    due_at: dueAt,
    done_at: null,
    snoozed_until: null,
    source: "owner",
    version: 1,
    created_at: now,
    updated_at: now,
  };
  const forWhom = deal ? `"${deal.title}" (${contact.name})` : contact.name;
  const due = dueAt === null ? "" : `, due ${formatLocal(dueAt, tz)}`;
  const result = await commitChange(ctx, {
    target: { table: "tasks", id: task.id },
    summary: `Added task "${title}" for ${forWhom}${due}`,
    changes: [{ table: "tasks", id: task.id, before: null, after: task }],
  });
  return { ...result, taskId: task.id };
}
