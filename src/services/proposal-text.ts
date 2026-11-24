// The list a proposal shows the owner (decision 0044), built from the rows the plan would write, never from the
// action text: so it shows exactly what a yes would change. Added people and deals are "Add", changed ones "Update",
// tasks "Tasks", logged activities "Notes" (a deal's stage move is shown on its Update line), time entries "Time".
// Keys become the owner's labels; outside text is never shown: a record named from outside is named by id
// (labels.ts), and an old value from outside reads "(text from outside)".
import type { ContactRow, Db, DealRow } from "../db/db.ts";
import { listFieldDefs } from "../db/queries.ts";
import { formatLocal, localWhen } from "../time.ts";
import type { ChangeInput, ChangeTable, Row } from "./change.ts";
import { changedColumns, oneLine, rowKey } from "./change.ts";
import { capitalize, columnLabel, joinAnd, rowLabel, short } from "./describe.ts";
import { activityText, contactName, dealLabel, dealTitle, isTrusted, taskTitle, untrustedFields } from "./labels.ts";
import { parseObject, stageLabels } from "./lookup.ts";
import { LEAD } from "./person-move.ts";
import { type StatusLabels, statusLabels } from "./status-labels.ts";
import { timeLine, timerLine } from "./time-format.ts";

export interface Item {
  record: string;
  id: string;
  fields: { field: string; from?: string; to: string }[];
}

export interface ProposalList {
  add: Item[];
  update: Item[];
  tasks: Item[];
  notes: Item[];
  time: Item[];
}

const GROUPS: [keyof ProposalList, string][] = [
  ["add", "Add"],
  ["update", "Update"],
  ["tasks", "Tasks"],
  ["notes", "Notes"],
  ["time", "Time"],
];

const fieldText = ({ field, from, to }: Item["fields"][number]) =>
  field === "" ? to : from === undefined ? `${field} ${to}` : `${field} ${from} -> ${to}`;

const itemLine = (item: Item) => `- ${item.record}${item.fields.length > 0 ? `: ${item.fields.map(fieldText).join("; ")}` : ""}`;

export function renderProposal(list: ProposalList, meta: { id: string; expiresLocal: string }): string {
  const lines = [`Proposal ${meta.id} (expires ${meta.expiresLocal}). Nothing has changed yet.`, ""];
  for (const [key, heading] of GROUPS) {
    if (list[key].length === 0) continue;
    lines.push(heading, ...list[key].map(itemLine));
  }
  lines.push(
    "",
    `Show this list to the owner as it is. Their answer: "Yes" (call apply_changes with ${meta.id}), "Yes with changes: ..." ` +
      `(send a revised list with replaces ${meta.id}), or "No" (apply nothing).`,
  );
  return lines.join("\n");
}

/** Columns that change as a side effect of the ones an action set; the list doesn't show them. */
const BOOKKEEPING = new Set([
  "id",
  "version",
  "created_at",
  "updated_at",
  "untrusted_fields",
  "last_activity_at",
  "stage_entered_at",
  "lead_status_at",
  // A person's lead status moves with their person status (decision 0040), which the list shows.
  "lead_status",
]);

const OUTSIDE = "(text from outside)";
const NONE = "(none)";

/** The columns shown for each table, in this order; any other changed column follows by its plain label. */
const ORDER: Partial<Record<ChangeTable, string[]>> = {
  contacts: ["name", "person_status", "business", "email", "phone", "source", "notes", "fields", "archived"],
  deals: ["stage_key", "status", "title", "contact_id", "value", "next_step", "next_at", "fields", "archived"],
  tasks: ["title", "for", "due_at", "snoozed_until", "done_at"],
};

const LABELS: Record<string, string> = { person_status: "person status", contact_id: "person", due_at: "due", done_at: "done", snoozed_until: "snoozed until" };

const DATE_COLUMNS = new Set(["next_at", "due_at", "done_at", "snoozed_until", "occurred_at", "started_at", "ended_at"]);

const STATUS_WORDS: Record<string, string> = { open: "open", won: "won", lost: "lost", not_now: "not now" };

const TYPE_WORDS: Record<string, string> = { email: "Email with", call: "Call with", meeting: "Meeting with", note: "Note on", form: "Form from" };

/** What the list needs to name keys and records: labels, and the rows the plan writes. */
interface Names {
  tz: string;
  /** The plan's "now" (ISO): a time the change stamps now reads "now", so the list doesn't depend on when it is made. */
  now: string;
  stages: Map<string, string>;
  statuses: StatusLabels;
  fields: Map<string, string>;
  planned: Map<string, Row>;
  db: Db;
}

async function planned<T>(names: Names, table: "contacts" | "deals" | "tasks", id: string | null): Promise<T | null> {
  if (id === null) return null;
  const row = names.planned.get(rowKey(table, id));
  if (row !== undefined) return row as unknown as T;
  return names.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first<T>();
}

/** The most characters one value shows; the list is for reading, the record keeps the whole text. */
const SHOWN_MAX = 300;

/** One value as the owner reads it. */
function shown(names: Names, table: ChangeTable, column: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return NONE;
  if (DATE_COLUMNS.has(column) && value === names.now) return "now";
  if (DATE_COLUMNS.has(column) && typeof value === "string") {
    // A date given without a time (midnight) reads as the date alone: "Fri Nov 20".
    const text = formatLocal(value, names.tz);
    return localWhen(value, names.tz).includes("T") ? text : (text.split(",")[0] ?? text);
  }
  if (column === "stage_key") return names.stages.get(String(value)) ?? String(value);
  if (column === "archived") return value === 1 ? "yes" : "no";
  if (table === "deals" && column === "status") return STATUS_WORDS[String(value)] ?? String(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  return short(String(value), SHOWN_MAX);
}

/** A value, or OUTSIDE when the row marks the column (or the custom field) as outside text. */
function cell(names: Names, table: ChangeTable, row: Row, column: string, value: unknown, fieldKey?: string): string {
  const outside = untrustedFields(row);
  if (outside.has(column) || (fieldKey !== undefined && (outside.has(fieldKey) || outside.has(`fields.${fieldKey}`)))) return OUTSIDE;
  return shown(names, table, column, value);
}

const statusText = (names: Names, row: Row) => names.statuses.both(String(row.person_status), (row.sub_status as string | null) ?? null);

/** Who a task, note or deal is for: "Pat Example", or a deal and its person. */
async function forWhom(names: Names, row: Row): Promise<string | null> {
  const deal = await planned<DealRow>(names, "deals", (row.deal_id as string | null) ?? null);
  const contact = await planned<ContactRow>(names, "contacts", (row.contact_id as string | null) ?? deal?.contact_id ?? null);
  if (deal && contact) return dealLabel(deal, contact);
  return contact ? contactName(contact) : null;
}

/** A custom field change per key: "Budget 100 -> 200". */
function fieldChanges(names: Names, table: ChangeTable, before: Row | null, after: Row): Item["fields"] {
  const entity = table === "contacts" ? "contact" : "deal";
  const old = before === null ? {} : parseObject(String(before.fields ?? "{}"));
  const now = parseObject(String(after.fields ?? "{}"));
  const keys = [...new Set([...Object.keys(old), ...Object.keys(now)])].filter((key) => JSON.stringify(old[key]) !== JSON.stringify(now[key]));
  return keys.map((key) => {
    const field = names.fields.get(`${entity}.${key}`) ?? key;
    const to = cell(names, table, after, "fields", now[key], key);
    return before === null ? { field, to } : { field, from: cell(names, table, before, "fields", old[key], key), to };
  });
}

/** The columns an update changed, as fields "<label> old -> new". */
async function updatedFields(names: Names, table: ChangeTable, before: Row, after: Row): Promise<Item["fields"]> {
  let columns = changedColumns(before, after).filter((column) => !BOOKKEEPING.has(column));
  if (columns.includes("person_status") || columns.includes("sub_status")) {
    columns = [...columns.filter((column) => column !== "sub_status" && column !== "person_status"), "person_status"];
  }
  // A move's status follows its stage.
  if (table === "deals" && columns.includes("stage_key")) columns = columns.filter((column) => column !== "status");
  if (table === "tasks" && (columns.includes("deal_id") || columns.includes("contact_id"))) {
    columns = [...columns.filter((column) => column !== "deal_id" && column !== "contact_id"), "for"];
  }
  const order = ORDER[table] ?? [];
  columns.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  const out: Item["fields"] = [];
  for (const column of columns) {
    if (column === "fields") {
      out.push(...fieldChanges(names, table, before, after));
    } else if (column === "person_status") {
      out.push({ field: LABELS[column] ?? column, from: statusText(names, before), to: statusText(names, after) });
    } else if (column === "for") {
      out.push({ field: "for", from: (await forWhom(names, before)) ?? NONE, to: (await forWhom(names, after)) ?? NONE });
    } else {
      const field = LABELS[column] ?? columnLabel(column);
      out.push({ field, from: cell(names, table, before, column, before[column]), to: cell(names, table, after, column, after[column]) });
    }
  }
  // Values the owner confirms as their own (no longer outside text) without changing them.
  const confirmed = [...untrustedFields(before)].filter((column) => !untrustedFields(after).has(column) && !columns.includes(column));
  if (confirmed.length > 0) out.push({ field: "confirmed", to: joinAnd(confirmed.map(columnLabel)) });
  return out;
}

/** "Lead Dana Example", or "Contact ct_…" when the name came from outside. */
function contactRecord(names: Names, row: Row): string {
  return `${names.statuses.status(String(row.person_status))} ${isTrusted(row, "name") ? oneLine(String(row.name)) : String(row.id)}`;
}

async function dealRecord(names: Names, row: Row): Promise<string> {
  const contact = await planned<ContactRow>(names, "contacts", String(row.contact_id));
  const deal = row as unknown as DealRow;
  return contact ? `Deal ${dealLabel(deal, contact)}` : `Deal ${dealTitle(deal)}`;
}

/** The fields an added contact or deal sets, in the order the owner reads them. */
function addedFields(names: Names, table: "contacts" | "deals", row: Row): Item["fields"] {
  const columns = table === "contacts" ? ["business", "email", "phone", "source", "notes"] : ["stage_key", "value", "next_step", "next_at"];
  const out: Item["fields"] = [];
  for (const column of columns) {
    if (row[column] === null || row[column] === undefined || row[column] === "") continue;
    out.push({ field: LABELS[column] ?? columnLabel(column), to: cell(names, table, row, column, row[column]) });
  }
  out.push(...fieldChanges(names, table, null, row));
  if (table === "contacts") {
    const sub = (row.sub_status as string | null) ?? null;
    // A new lead starts New: only another sub-status is worth saying.
    if (sub !== null && !(row.person_status === LEAD && sub === "new")) {
      out.push({ field: columnLabel("sub_status"), to: names.statuses.sub(String(row.person_status), sub) ?? sub });
    }
  }
  return out;
}

async function noteItem(names: Names, id: string, row: Row): Promise<Item> {
  const contact = await planned<ContactRow>(names, "contacts", (row.contact_id as string | null) ?? null);
  const deal = await planned<DealRow>(names, "deals", (row.deal_id as string | null) ?? null);
  const words = TYPE_WORDS[String(row.type)] ?? `${capitalize(String(row.type))} with`;
  const who = contact ? contactName(contact) : NONE;
  const fields: Item["fields"] = [{ field: "", to: short(activityText({ id, summary: String(row.summary), actor: String(row.actor) }), SHOWN_MAX) }];
  if (row.occurred_at !== row.created_at) fields.push({ field: "on", to: shown(names, "activities", "occurred_at", row.occurred_at) });
  return { record: `${words} ${who}${deal ? ` about ${dealTitle(deal)}` : ""}`, id, fields };
}

async function taskItem(names: Names, id: string, before: Row | null, after: Row): Promise<Item> {
  if (before !== null) return { record: `Task ${taskTitle(before as unknown as { id: string; title: string })}`, id, fields: await updatedFields(names, "tasks", before, after) };
  const who = await forWhom(names, after);
  return {
    record: `New task ${taskTitle(after as unknown as { id: string; title: string })}`,
    id,
    fields: [who === null ? { field: "", to: "no person or deal" } : { field: "for", to: who }, { field: "due", to: shown(names, "tasks", "due_at", after.due_at) }],
  };
}

/** A work type's name, archived ones too (work types are configuration: a plan never writes them). */
async function workTypeName(names: Names, id: unknown): Promise<string | null> {
  if (typeof id !== "string") return null;
  return names.db.prepare("SELECT name FROM work_types WHERE id = ?").bind(id).first<string>("name");
}

/** "Time 1 h 30 min, Design, billable at $95.00/h ($142.50), for Pat Example", or "Timer started now, ..." for a running one. */
async function entryLine(names: Names, row: Row): Promise<string> {
  const workType = await workTypeName(names, row.work_type_id);
  const who = await forWhom(names, row);
  if (row.ended_at === null || typeof row.minutes !== "number") {
    const rest = timerLine(workType, who);
    return `Timer started ${shown(names, "time_entries", "started_at", row.started_at)}${rest === "" ? "" : `, ${rest}`}`;
  }
  const rate = typeof row.rate === "number" ? row.rate : null;
  return `Time ${timeLine({ minutes: row.minutes, workType, billable: row.billable === 1, rate, who })}`;
}

/** The task an entry is for, by taskTitle (its id when the title came from outside); null for none. */
async function entryTask(names: Names, row: Row): Promise<string | null> {
  const task = await planned<{ id: string; title: string; untrusted_fields: string }>(names, "tasks", (row.task_id as string | null) ?? null);
  return task === null ? (typeof row.task_id === "string" ? `task ${row.task_id}` : null) : taskTitle(task);
}

/**
 * A time entry: added or stopped, it reads as its line (and its task, when it has one); archived or restored, it says
 * so; edited, what it was and the task it moved to.
 */
async function timeItem(names: Names, id: string, before: Row | null, after: Row): Promise<Item | null> {
  if (before === null || (before.ended_at === null && after.ended_at !== null && after.archived === 0)) {
    const task = await entryTask(names, after);
    return { record: await entryLine(names, after), id, fields: task === null ? [] : [{ field: "task", to: task }] };
  }
  if (before.archived !== after.archived) {
    const archived = after.archived === 1;
    return { record: await entryLine(names, archived ? before : after), id, fields: [{ field: "", to: archived ? "archived" : "restored" }] };
  }
  const was = await entryLine(names, before);
  const now = await entryLine(names, after);
  const fields: Item["fields"] = [];
  if (was !== now) fields.push({ field: "was", to: was.replace(/^Time /, "") });
  if (before.task_id !== after.task_id) fields.push({ field: "task", from: (await entryTask(names, before)) ?? NONE, to: (await entryTask(names, after)) ?? NONE });
  for (const [column, field] of [["started_at", "started"], ["notes", "notes"]] as const) {
    if (before[column] === after[column]) continue;
    fields.push({ field, from: cell(names, "time_entries", before, column, before[column]), to: cell(names, "time_entries", after, column, after[column]) });
  }
  return fields.length === 0 ? null : { record: now, id, fields };
}

/**
 * The list from the built change's rows. `tz` is the owner's timezone and `now` the plan's time. Rows whose change
 * shows nothing the owner would see (a deal's last-contact time) are left out.
 */
export async function proposalList(db: Db, input: ChangeInput, tz: string, now: Date): Promise<ProposalList> {
  const fieldDefs = await listFieldDefs(db, { includeArchived: true });
  const names: Names = {
    tz,
    now: now.toISOString(),
    stages: await stageLabels(db),
    statuses: await statusLabels(db),
    fields: new Map(fieldDefs.map((def) => [`${def.entity}.${def.key}`, def.label])),
    planned: new Map(input.changes.flatMap((change) => (change.after === null ? [] : [[rowKey(change.table, change.id), change.after]]))),
    db,
  };
  const list: ProposalList = { add: [], update: [], tasks: [], notes: [], time: [] };
  for (const { table, id, before, after } of input.changes) {
    if (after === null) {
      if (before !== null) list.update.push({ record: capitalize(rowLabel(table, before)), id, fields: [{ field: "", to: "removed" }] });
      continue;
    }
    if (table === "activities" && before === null) {
      if (after.type !== "stage_change") list.notes.push(await noteItem(names, id, after));
      continue;
    }
    if (table === "tasks") {
      list.tasks.push(await taskItem(names, id, before, after));
      continue;
    }
    if (table === "time_entries") {
      const item = await timeItem(names, id, before, after);
      if (item !== null) list.time.push(item);
      continue;
    }
    if (table === "contacts" || table === "deals") {
      const record = table === "contacts" ? contactRecord(names, before ?? after) : await dealRecord(names, before ?? after);
      if (before === null) {
        list.add.push({ record, id, fields: addedFields(names, table, after) });
        continue;
      }
      const fields = await updatedFields(names, table, before, after);
      if (fields.length > 0) list.update.push({ record, id, fields });
      continue;
    }
    const fields = before === null ? [] : await updatedFields(names, table, before, after);
    if (before === null || fields.length > 0) list.update.push({ record: capitalize(rowLabel(table, before ?? after)), id, fields });
  }
  return list;
}
