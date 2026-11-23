// The Tasks import module (decision 0037): each row is a new task on a deal (by deal_id) or else on a person (by
// contact_id, email or name), unless its `id` names a task on file, which it fills in (an empty due date only). A task
// never adds a person or a deal: a row that matches neither is skipped. A done_at makes the task one already done.
// Every value from the file is outside text: the change lists it in the task's untrusted_fields.
import type { ContactRow, DealRow, TaskRow } from "../../db/db.ts";
import { isContactId, isDealId, isTaskId, newId } from "../../ids.ts";
import { type ChangeInput, type RowChange, updatedRow } from "../../services/change.ts";
import type { ColumnDef, ImportModule, MappedRow, PlanBase } from "../engine.ts";
import { EMAIL, emailKey, idList, nameKey, readWhen } from "./values.ts";

const TASK_COLUMNS: readonly ColumnDef[] = [
  { key: "id", label: "Task id", aliases: [], multiline: false },
  { key: "title", label: "Title", aliases: [], limit: 500, multiline: false, required: true },
  { key: "due_at", label: "Due", aliases: ["due"], multiline: false },
  { key: "deal_id", label: "Deal id", aliases: [], multiline: false },
  { key: "contact_id", label: "Contact id", aliases: [], multiline: false },
  { key: "email", label: "Email", aliases: [], multiline: false },
  { key: "name", label: "Name", aliases: [], multiline: false },
  { key: "done_at", label: "Done", aliases: ["done"], multiline: false },
];

/** The board export's tasks columns that are bookkeeping: recognised and never imported. */
const TASK_IGNORED = ["snoozed_until", "source", "untrusted_fields", "version", "created_at", "updated_at"];

/** What a tasks plan reads: every contact, the deals and tasks the file's ids name, and the owner's timezone. */
export interface TasksCtx {
  contacts: readonly ContactRow[];
  /** Only the deals whose id is in the file's deal_id column. */
  deals: readonly DealRow[];
  /** Only the tasks whose id is in the file's id column. */
  tasks: readonly TaskRow[];
  tz: string;
}

export interface TaskCreate {
  line: number;
  /** A well-formed task id from the file that matches no task, kept; null for a new id. */
  id: string | null;
  dealId: string | null;
  contactId: string;
  title: string;
  dueAt: string | null;
  doneAt: string | null;
}

export interface TaskMerge {
  id: string;
  line: number;
  changes: Partial<{ due_at: string }>;
}

export interface TasksPlan extends PlanBase {
  create: TaskCreate[];
  merge: TaskMerge[];
  unchanged: { line: number; id: string }[];
}

type Subject = { deal: DealRow | null; contact: ContactRow } | { reason: string };

/** Rows over a column's limit never reach the plan: planRows (src/import/engine.ts) skips them first. */
export function planTasks(rows: readonly MappedRow[], ctx: TasksCtx): TasksPlan {
  const tasksById = new Map(ctx.tasks.map((task) => [task.id, task]));
  const dealsById = new Map(ctx.deals.map((deal) => [deal.id, deal]));
  const byId = new Map(ctx.contacts.map((contact) => [contact.id, contact]));
  const byEmail = new Map<string, ContactRow>();
  const byName = new Map<string, ContactRow[]>();
  for (const contact of ctx.contacts) {
    if (contact.email) byEmail.set(emailKey(contact.email), contact);
    if (contact.archived === 0) byName.set(nameKey(contact.name), [...(byName.get(nameKey(contact.name)) ?? []), contact]);
  }
  const seenIds = new Map<string, number>();
  const plan: TasksPlan = { create: [], merge: [], unchanged: [], skipped: [] };

  const person = (contact: ContactRow): Subject =>
    contact.archived === 1 ? { reason: `contact ${contact.id} is archived` } : { deal: null, contact };

  const subjectOf = (values: MappedRow["values"]): Subject => {
    const dealText = values.deal_id ?? null;
    const deal = dealText !== null && isDealId(dealText) ? dealsById.get(dealText) : undefined;
    if (deal) {
      if (deal.archived === 1) return { reason: `deal ${deal.id} is archived` };
      const owner = byId.get(deal.contact_id);
      if (!owner) throw new Error(`Deal ${deal.id} points at a contact that wasn't read.`);
      return { deal, contact: owner };
    }
    const contactText = values.contact_id ?? null;
    const byContactId = contactText !== null && isContactId(contactText) ? byId.get(contactText) : undefined;
    if (byContactId) return person(byContactId);
    const email = values.email ?? null;
    const byMail = email !== null && EMAIL.test(email) ? byEmail.get(emailKey(email)) : undefined;
    if (byMail) return person(byMail);
    const name = values.name ?? null;
    const named = name === null ? [] : (byName.get(nameKey(name)) ?? []);
    const [only, ...others] = named;
    if (only && others.length > 0) return { reason: `more than one person on file has this name (${idList("contact", named.map((c) => c.id))})` };
    if (only) return person(only);
    return { reason: "no person or deal matches" };
  };

  for (const row of rows) {
    const { line, values } = row;
    const skip = (reason: string) => plan.skipped.push({ line, reason });
    const title = values.title ?? null;
    if (title === null) {
      skip("no title");
      continue;
    }
    const idText = values.id ?? null;
    const id = idText !== null && isTaskId(idText) ? idText : null;
    if (id !== null) {
      const earlier = seenIds.get(id);
      if (earlier !== undefined) {
        skip(`the same id as line ${earlier}`);
        continue;
      }
      seenIds.set(id, line);
    }
    const dueText = values.due_at ?? null;
    const dueAt = dueText === null ? null : readWhen(dueText, ctx.tz);
    if (dueText !== null && dueAt === null) {
      skip("due_at isn't a date like 2026-11-19");
      continue;
    }
    const doneText = values.done_at ?? null;
    const doneAt = doneText === null ? null : readWhen(doneText, ctx.tz);
    if (doneText !== null && doneAt === null) {
      skip("done_at isn't a date like 2026-11-19");
      continue;
    }
    const match = id === null ? undefined : tasksById.get(id);
    if (match) {
      // A merge fills an empty due date only: it never completes, moves or renames a task.
      const changes: TaskMerge["changes"] = {};
      if (dueAt !== null && match.due_at === null) changes.due_at = dueAt;
      if (Object.keys(changes).length > 0) plan.merge.push({ id: match.id, line, changes });
      else plan.unchanged.push({ line, id: match.id });
      continue;
    }
    const subject = subjectOf(values);
    if ("reason" in subject) {
      skip(subject.reason);
      continue;
    }
    plan.create.push({ line, id, dealId: subject.deal?.id ?? null, contactId: subject.contact.id, title, dueAt, doneAt });
  }
  return plan;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Counts only: an import's summary never quotes what the file held. */
export const tasksSummary = (created: number, filled: number): string =>
  `Imported ${plural(created, "task", "tasks")} and filled details on ${filled}`;

/** The change for a plan, or null when it would write nothing. */
export function tasksChange(plan: TasksPlan, ctx: TasksCtx, now: Date): ChangeInput | null {
  const stamp = now.toISOString();
  const changes: RowChange[] = [];
  for (const row of plan.create) {
    const outside = ["title", ...(row.dueAt === null ? [] : ["due_at"]), ...(row.doneAt === null ? [] : ["done_at"])];
    const task: TaskRow = {
      id: row.id ?? newId("tk"),
      deal_id: row.dealId,
      contact_id: row.contactId,
      title: row.title,
      due_at: row.dueAt,
      done_at: row.doneAt,
      snoozed_until: null,
      source: "owner",
      untrusted_fields: JSON.stringify(outside),
      version: 1,
      created_at: stamp,
      updated_at: stamp,
    };
    changes.push({ table: "tasks", id: task.id, before: null, after: task });
  }
  const tasks = new Map(ctx.tasks.map((task) => [task.id, task]));
  for (const { id, changes: filled } of plan.merge) {
    const before = tasks.get(id);
    if (!before) throw new Error(`The import plan names task ${id}, which wasn't read.`);
    const untrusted = new Set(JSON.parse(before.untrusted_fields) as string[]);
    for (const column of Object.keys(filled)) untrusted.add(column);
    changes.push({ table: "tasks", id, before, after: updatedRow(before, { ...filled, untrusted_fields: JSON.stringify([...untrusted]) }, now) });
  }
  const first = changes[0];
  if (!first) return null;
  return {
    target: { table: "tasks", id: first.id },
    summary: tasksSummary(plan.create.length, plan.merge.length),
    changes,
    // One change at any size (decision 0035).
    bulk: true,
  };
}

/** Tasks on a deal or a person already on file; matched to a task on file only by id. */
export const tasksModule: ImportModule<TasksCtx, TasksPlan> = {
  key: "tasks",
  noun: { one: "task", many: "tasks" },
  entity: null,
  notes: false,
  columns: TASK_COLUMNS,
  ignored: TASK_IGNORED,
  plan: planTasks,
  change: tasksChange,
};
