// add_task, complete_task and snooze_task.
import type { ContactRow, DealRow, ProjectRow, TaskRow } from "../db/db.ts";
import { newId } from "../ids.ts";
import { formatLocal, parseWhen } from "../time.ts";
import { type ChangeResult, commitChange, type Ctx, type Row, updatedRow } from "./change.ts";
import { capitalize, rowLabel } from "./describe.ts";
import { UserError } from "./errors.ts";
import { clean, whenOrNull } from "./input.ts";
import { contactName, dealLabel, projectLabel } from "./labels.ts";
import { findSubject, nextPosition, ownerTimezone, projectById, type Source, taskWithLinks } from "./lookup.ts";
import { settingsRow } from "./memo.ts";
import { projectSubject } from "./project-links.ts";
import { descendants, parentLinks } from "./subtasks.ts";

export interface TaskInput {
  /** Deal id, title or contact name. */
  dealId?: string;
  /** Contact id or name. */
  contactId?: string;
  /** Project id or exact name: the task is the project's and its person's, with no deal. */
  project?: string;
  /** A task id: the new task goes under it (sub-task); the parent must be an open task on a live project. */
  parent?: string;
  title: string;
  dueAt?: string;
}

/** Who a task is for, as summaries name them: a project and its person, a deal and its person, a person, or null for a task of no one's. */
function forWhomOf(deal: DealRow | null, contact: ContactRow | null, project: ProjectRow | null = null): string | null {
  if (project) return projectLabel(project, contact);
  if (deal && contact) return dealLabel(deal, contact);
  return contact ? contactName(contact) : null;
}

const forText = (who: string | null) => (who === null ? "" : ` for ${who}`);

/** Adds a task on a deal, a contact, or neither (a standalone task, decision 0046). */
export async function addTask(ctx: Ctx, input: TaskInput): Promise<ChangeResult & { taskId: string }> {
  const title = clean(input.title);
  if (title === null) throw new UserError("A task needs a title. Say in a few words what to do.");
  const tz = await ownerTimezone(ctx);
  const dueAt = whenOrNull(input.dueAt ?? null, tz);
  let parent: TaskRow | null = null;
  let where: { deal: DealRow | null; contact: ContactRow | null; project: ProjectRow | null };
  if (input.parent !== undefined) {
    const found = await parentLinks(ctx, input.parent, { project: input.project, dealId: input.dealId, contactId: input.contactId });
    parent = found.parent;
    where = { deal: null, ...found.links };
  } else if (input.project === undefined) {
    where = { ...(await findSubject(ctx, input, { optional: true })), project: null };
  } else {
    where = { deal: null, ...(await projectSubject(ctx, input.project, input)) };
  }
  const { deal, contact, project } = where;
  const now = ctx.now.toISOString();

  const task: TaskRow = {
    id: newId("tk"),
    deal_id: deal?.id ?? null,
    contact_id: contact?.id ?? null,
    project_id: project?.id ?? null,
    parent_id: parent?.id ?? null,
    position: project === null ? null : await nextPosition(ctx, project.id, parent?.id ?? null),
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
    summary: `Added task "${title}"${forText(forWhomOf(deal, contact, project))}${due}`,
    changes: [{ table: "tasks", id: task.id, before: null, after: task }],
  });
  return { ...result, taskId: task.id };
}

/** task "Call back", or task tk_… when the title came from outside. */
const taskName = (task: TaskRow) => rowLabel("tasks", task as Row);

/**
 * The task with what describes it: "task \"Call back\" for \"Website refresh\" (Pat Example)", each part safe on its
 * own; a standalone task is its name alone.
 */
async function findTask(src: Source, ref: string): Promise<{ task: TaskRow; described: string }> {
  const id = ref.trim();
  if (id === "") throw new UserError("Say which task: give its id (tk_...) from whats_due or get_deal.");
  const found = await taskWithLinks(src, id);
  if (!found) throw new UserError(`No task "${id}". Use whats_due or get_deal to find the task's id.`);
  const project = found.task.project_id ? await projectById(src, found.task.project_id) : null;
  return { task: found.task, described: `${taskName(found.task)}${forText(forWhomOf(found.deal, found.contact, project))}` };
}

const subTaskCount = (n: number) => `${n} sub-task${n === 1 ? "" : "s"}`;

/** Marks a task done. With open sub-tasks the caller must say `subTasks`: "complete" finishes them in the same change. */
export async function completeTask(
  ctx: Ctx,
  ref: string,
  options: { subTasks?: "complete" | "leave" | undefined } = {},
): Promise<ChangeResult & { taskId: string }> {
  const { task: before, described } = await findTask(ctx, ref);
  if (before.done_at !== null) {
    const tz = await ownerTimezone(ctx);
    throw new UserError(`${capitalize(taskName(before))} is already done (${formatLocal(before.done_at, tz)}). Nothing to do.`);
  }
  // Sub-tasks belong to projects: while they are off a task has none to ask about.
  const kids = (await settingsRow(ctx)).projects === 1 ? await descendants(ctx, before.id) : [];
  const open = kids.filter((kid) => kid.done_at === null);
  if (open.length > 0 && options.subTasks === undefined) {
    throw new UserError(
      `${capitalize(described)} has ${open.length} open ${open.length === 1 ? "sub-task" : "sub-tasks"}. Send subTasks "complete" to finish them too, or "leave" to keep them open.`,
    );
  }
  const finishing = options.subTasks === "complete" ? open : [];
  const doneAt = ctx.now.toISOString();
  const withKids = finishing.length === 0 ? "" : ` and ${subTaskCount(finishing.length)}`;
  const result = await commitChange(ctx, {
    target: { table: "tasks", id: before.id },
    summary: `Completed ${described}${withKids}`,
    changes: [before, ...finishing].map((row) => ({ table: "tasks" as const, id: row.id, before: row, after: updatedRow(row, { done_at: doneAt }, ctx.now) })),
  });
  return { ...result, taskId: before.id };
}

export async function snoozeTask(ctx: Ctx, ref: string, until: string): Promise<ChangeResult & { taskId: string }> {
  const tz = await ownerTimezone(ctx);
  const { task: before, described } = await findTask(ctx, ref);
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
    summary: `Snoozed ${described} until ${formatLocal(wake, tz)}`,
    changes: [{ table: "tasks", id: before.id, before, after }],
  });
  return { ...result, taskId: before.id };
}
