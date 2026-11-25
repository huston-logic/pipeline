// The list a proposal shows the owner (decision 0044), built from the rows the plan would write, never from the
// action text: so it shows exactly what a yes would change. Added people and deals are "Add", changed ones "Update",
// tasks "Tasks", logged activities "Notes" (a deal's stage move is shown on its Update line), time entries "Time".
// Keys become the owner's labels; outside text is never shown: a record named from outside is named by id
// (labels.ts), and an old value from outside reads "(text from outside)".
import type { ContactRow, Db, DealRow, ProjectRow } from "../db/db.ts";
import { formatLocal, localWhen } from "../time.ts";
import type { ChangeInput, ChangeTable, Row } from "./change.ts";
import { changedColumns, oneLine, rowKey } from "./change.ts";
import { capitalize, columnLabel, joinAnd, rowLabel, short } from "./describe.ts";
import { activityText, contactName, dealLabel, dealTitle, isTrusted, projectTitle, taskTitle, untrustedFields } from "./labels.ts";
import { parseObject, stageLabels } from "./lookup.ts";
import { fieldDefRows, memoWorkType, type Reader, readerOf } from "./memo.ts";
import { LEAD } from "./person-move.ts";
import { projectStatusLabels } from "./project-statuses.ts";
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

/**
 * The columns the list never shows, in every table: bookkeeping that changes as a side effect of the columns an action
 * set. The per-row check (shownList) skips them too; every other column a list writes must show in some item.
 */
export const NOT_SHOWN: readonly string[] = [
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
];

const BOOKKEEPING = new Set(NOT_SHOWN);

const OUTSIDE = "(text from outside)";
const NONE = "(none)";

/** The columns shown for each table, in this order; any other changed column follows by its plain label. */
const ORDER: Partial<Record<ChangeTable, string[]>> = {
  contacts: ["name", "person_status", "business", "email", "phone", "source", "notes", "fields", "archived"],
  deals: ["stage_key", "status", "title", "contact_id", "value", "next_step", "next_at", "fields", "archived"],
  tasks: ["title", "for", "due_at", "snoozed_until", "done_at"],
  projects: ["name", "status_key", "start_at", "target_at", "notes", "archived"],
};

const LABELS: Record<string, string> = {
  person_status: "person status",
  contact_id: "person",
  due_at: "due",
  done_at: "done",
  snoozed_until: "snoozed until",
  status_key: "status",
  start_at: "start",
  target_at: "target",
};

const DATE_COLUMNS = new Set(["next_at", "due_at", "done_at", "snoozed_until", "occurred_at", "started_at", "ended_at", "start_at", "target_at"]);

const STATUS_WORDS: Record<string, string> = { open: "open", won: "won", lost: "lost", not_now: "not now" };

const TYPE_WORDS: Record<string, string> = { email: "Email with", call: "Call with", meeting: "Meeting with", note: "Note on", form: "Form from" };

/** What the list needs to name keys and records: labels, and the rows the plan writes. */
interface Names {
  tz: string;
  /** The plan's "now" (ISO): a time the change stamps now reads "now", so the list doesn't depend on when it is made. */
  now: string;
  stages: Map<string, string>;
  statuses: StatusLabels;
  /** Each project status key and its label. */
  projectStatuses: Map<string, string>;
  fields: Map<string, string>;
  planned: Map<string, Row>;
  /** The rows the list names that the plan doesn't write, read up front in one batch (null: not found). */
  read: Map<string, Row | null>;
  src: Reader;
  /** The columns of each written row (by row key) that some item shows. */
  shows: Map<string, Set<string>>;
}

/** Says that an item shows these columns of the row. */
function show(names: Names, table: ChangeTable, id: string, columns: readonly string[]): void {
  const key = rowKey(table, id);
  const set = names.shows.get(key) ?? new Set<string>();
  for (const column of columns) set.add(column);
  names.shows.set(key, set);
}

async function planned<T>(names: Names, table: Named, id: string | null): Promise<T | null> {
  if (id === null) return null;
  const key = rowKey(table, id);
  const row = names.planned.get(key) ?? names.read.get(key);
  if (row !== undefined) return row as unknown as T | null;
  return readerOf(names.src).db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first<T>();
}

type Named = "contacts" | "deals" | "tasks" | "projects";

/** At most this many ids in one IN list (D1 takes 100 bound parameters a statement). */
const IDS_PER_READ = 100;

/** Every row of `ids` in one D1 batch, a statement per table and 100 ids; each id not found is null. */
async function readRows(db: Db, ids: ReadonlyMap<Named, ReadonlySet<string>>, into: Map<string, Row | null>): Promise<void> {
  const reads: { table: Named; ids: string[] }[] = [];
  for (const [table, set] of ids) {
    const list = [...set];
    for (let i = 0; i < list.length; i += IDS_PER_READ) reads.push({ table, ids: list.slice(i, i + IDS_PER_READ) });
  }
  if (reads.length === 0) return;
  const results = await db.batch<Row>(reads.map(({ table, ids: some }) => db.prepare(`SELECT * FROM ${table} WHERE id IN (${some.map(() => "?").join(", ")})`).bind(...some)));
  reads.forEach(({ table, ids: some }, i) => {
    for (const id of some) into.set(rowKey(table, id), null);
    for (const row of results[i]?.results ?? []) into.set(rowKey(table, String(row.id)), row);
  });
}

/**
 * The people, deals and tasks the list names (a note's person, a task's deal, an entry's task, a deal's person) that
 * the plan doesn't write, so each is read once, in at most two batches, instead of one read per line.
 */
async function namedRows(db: Db, input: ChangeInput, planned: ReadonlyMap<string, Row>): Promise<Map<string, Row | null>> {
  const read = new Map<string, Row | null>();
  const wanted = (rows: readonly Row[], deals: readonly Row[]): Map<Named, Set<string>> => {
    const ids = new Map<Named, Set<string>>([["contacts", new Set()], ["deals", new Set()], ["tasks", new Set()], ["projects", new Set()]]);
    const want = (table: Named, id: unknown) => {
      if (typeof id === "string" && !planned.has(rowKey(table, id)) && !read.has(rowKey(table, id))) ids.get(table)?.add(id);
    };
    for (const row of rows) {
      want("contacts", row.contact_id);
      want("deals", row.deal_id);
      want("tasks", row.task_id);
      want("projects", row.project_id);
    }
    for (const deal of deals) want("contacts", deal.contact_id);
    return ids;
  };
  const rows = input.changes.flatMap((change) => [change.before, change.after].filter((row): row is Row => row !== null));
  await readRows(db, wanted(rows, []), read);
  const deals = [...read].flatMap(([key, row]) => (key.startsWith("deals:") && row !== null ? [row] : []));
  await readRows(db, wanted([], deals), read);
  return read;
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
  if (table === "projects" && column === "status_key") return names.projectStatuses.get(String(value)) ?? String(value);
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

/** A project as the list names it: project "Retrofit", or project pj_... when its name came from outside. */
const projectWord = (project: ProjectRow) => (isTrusted(project, "name") ? `project ${projectTitle(project)}` : projectTitle(project));

/** Who a task, note or entry is for: a project and its person, a deal and its person, or "Pat Example". */
async function forWhom(names: Names, row: Row): Promise<string | null> {
  const project = await planned<ProjectRow>(names, "projects", (row.project_id as string | null | undefined) ?? null);
  if (project) {
    const owner = await planned<ContactRow>(names, "contacts", (row.contact_id as string | null) ?? project.contact_id);
    return owner ? `${projectWord(project)} (${contactName(owner)})` : projectWord(project);
  }
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

/** The columns an update changed, as fields "<label> old -> new"; each one shows (a status with its stage or person status). */
async function updatedFields(names: Names, table: ChangeTable, id: string, before: Row, after: Row): Promise<Item["fields"]> {
  let columns = changedColumns(before, after).filter((column) => !BOOKKEEPING.has(column));
  show(names, table, id, columns);
  if (columns.includes("person_status") || columns.includes("sub_status")) {
    columns = [...columns.filter((column) => column !== "sub_status" && column !== "person_status"), "person_status"];
  }
  // A move's status follows its stage.
  if (table === "deals" && columns.includes("stage_key")) columns = columns.filter((column) => column !== "status");
  if (table === "tasks" && (columns.includes("deal_id") || columns.includes("contact_id") || columns.includes("project_id"))) {
    columns = [...columns.filter((column) => column !== "deal_id" && column !== "contact_id" && column !== "project_id"), "for"];
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
function addedFields(names: Names, table: "contacts" | "deals", id: string, row: Row): Item["fields"] {
  const columns = table === "contacts" ? ["business", "email", "phone", "source", "notes"] : ["stage_key", "value", "next_step", "next_at"];
  // The record line names the person (status and name) or the deal (title and person); a new deal's status follows its
  // stage, and a new record isn't archived.
  const named = table === "contacts" ? ["name", "person_status", "sub_status"] : ["title", "contact_id", "status"];
  show(names, table, id, [...columns, ...named, "fields", ...(row.archived === 0 ? ["archived"] : [])]);
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

/** `Project "Retrofit"`, or `Project pj_...` when the name came from outside; an edit adds the person. */
async function projectRecord(names: Names, row: Row, withPerson: boolean): Promise<string> {
  const project = row as unknown as ProjectRow;
  const word = isTrusted(project, "name") ? `Project ${projectTitle(project)}` : `Project ${project.id}`;
  const owner = withPerson ? await planned<ContactRow>(names, "contacts", project.contact_id) : null;
  return owner ? `${word} (${contactName(owner)})` : word;
}

/** What an added project sets: its person, the deal it comes from, status, dates and notes. */
async function addedProjectFields(names: Names, id: string, row: Row): Promise<Item["fields"]> {
  show(names, "projects", id, ["name", "contact_id", "deal_id", "status_key", "start_at", "target_at", "notes", "archived"]);
  const owner = await planned<ContactRow>(names, "contacts", String(row.contact_id));
  const deal = await planned<DealRow>(names, "deals", (row.deal_id as string | null) ?? null);
  const out: Item["fields"] = [{ field: "person", to: owner ? contactName(owner) : String(row.contact_id) }];
  if (deal) out.push({ field: "from deal", to: dealTitle(deal) });
  out.push(
    { field: "status", to: cell(names, "projects", row, "status_key", row.status_key) },
    { field: "start", to: cell(names, "projects", row, "start_at", row.start_at) },
    { field: "target", to: cell(names, "projects", row, "target_at", row.target_at) },
  );
  if (row.notes !== null && row.notes !== "") out.push({ field: "notes", to: cell(names, "projects", row, "notes", row.notes) });
  return out;
}

async function noteItem(names: Names, id: string, row: Row): Promise<Item> {
  show(names, "activities", id, ["type", "contact_id", "deal_id", "project_id", "summary", "occurred_at", "actor"]);
  const contact = await planned<ContactRow>(names, "contacts", (row.contact_id as string | null) ?? null);
  const deal = await planned<DealRow>(names, "deals", (row.deal_id as string | null) ?? null);
  const project = await planned<ProjectRow>(names, "projects", (row.project_id as string | null | undefined) ?? null);
  const words = TYPE_WORDS[String(row.type)] ?? `${capitalize(String(row.type))} with`;
  const who = contact ? contactName(contact) : NONE;
  const fields: Item["fields"] = [{ field: "", to: short(activityText({ id, summary: String(row.summary), actor: String(row.actor) }), SHOWN_MAX) }];
  if (row.occurred_at !== row.created_at) fields.push({ field: "on", to: shown(names, "activities", "occurred_at", row.occurred_at) });
  return { record: `${words} ${who}${deal ? ` about ${dealTitle(deal)}` : project ? ` about ${projectWord(project)}` : ""}`, id, fields };
}

async function taskItem(names: Names, id: string, before: Row | null, after: Row): Promise<Item> {
  if (before !== null) return { record: `Task ${taskTitle(before as unknown as { id: string; title: string })}`, id, fields: await updatedFields(names, "tasks", id, before, after) };
  const who = await forWhom(names, after);
  // A task the owner or the AI app adds is the owner's own: its source says so and isn't worth a word.
  show(names, "tasks", id, ["title", "deal_id", "contact_id", "project_id", "due_at", ...(after.source === "owner" ? ["source"] : [])]);
  return {
    record: `New task ${taskTitle(after as unknown as { id: string; title: string })}`,
    id,
    fields: [who === null ? { field: "", to: "no person or deal" } : { field: "for", to: who }, { field: "due", to: shown(names, "tasks", "due_at", after.due_at) }],
  };
}

/** A work type's name, archived ones too (work types are configuration: a plan never writes them). */
async function workTypeName(names: Names, id: unknown): Promise<string | null> {
  if (typeof id !== "string") return null;
  const memoized = await memoWorkType(names.src, id);
  if (memoized !== undefined) return memoized?.name ?? null;
  return readerOf(names.src).db.prepare("SELECT name FROM work_types WHERE id = ?").bind(id).first<string>("name");
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

/** The columns an entry's line shows: its length (or that it runs), work type, billing and whom it is for. */
const LINE_COLUMNS = ["ended_at", "minutes", "work_type_id", "billable", "rate", "contact_id", "deal_id", "project_id"];

/** "started <when>", "notes <text>", or each as "old -> new" for an edit. */
function entryField(names: Names, before: Row | null, after: Row, column: "started_at" | "notes"): Item["fields"][number] {
  const field = column === "started_at" ? "started" : "notes";
  const to = cell(names, "time_entries", after, column, after[column]);
  return before === null ? { field, to } : { field, from: cell(names, "time_entries", before, column, before[column]), to };
}

/**
 * A time entry: added or stopped, it reads as its line with its start, task and notes when set (a stop: when changed);
 * archived or restored, it says so beside every other edit; edited, what it was, and each other change.
 */
async function timeItem(names: Names, id: string, before: Row | null, after: Row, notes: ReadonlySet<string>): Promise<Item | null> {
  const record = await entryLine(names, after);
  const running = after.ended_at === null;
  // The note a stop logged shows in Notes.
  const linked = typeof after.activity_id === "string" && notes.has(after.activity_id) && after.activity_id !== before?.activity_id;
  if (before === null || (before.ended_at === null && !running && after.archived === 0)) {
    const fields: Item["fields"] = [];
    const task = await entryTask(names, after);
    if (task !== null && (before === null || before.task_id !== after.task_id)) fields.push({ field: "task", to: task });
    // A running timer's line says when it started.
    if (!running && (before === null || before.started_at !== after.started_at)) fields.push(entryField(names, before, after, "started_at"));
    if (after.notes !== null && after.notes !== "" && after.notes !== before?.notes) fields.push(entryField(names, before?.notes ? before : null, after, "notes"));
    show(names, "time_entries", id, [...LINE_COLUMNS, "task_id", "started_at", "notes", "archived", ...(linked ? ["activity_id"] : [])]);
    return { record, id, fields };
  }
  const fields: Item["fields"] = [];
  const shown: string[] = [];
  if (before.archived !== after.archived) {
    fields.push({ field: "", to: after.archived === 1 ? "archived" : "restored" });
    shown.push("archived");
  }
  const was = await entryLine(names, before);
  if (was !== record) {
    fields.push({ field: "was", to: was.replace(/^Time /, "") });
    shown.push(...LINE_COLUMNS);
  }
  if (before.task_id !== after.task_id) {
    fields.push({ field: "task", from: (await entryTask(names, before)) ?? NONE, to: (await entryTask(names, after)) ?? NONE });
    shown.push("task_id");
  }
  for (const column of ["started_at", "notes"] as const) {
    if (before[column] === after[column]) continue;
    fields.push(entryField(names, before, after, column));
    shown.push(column);
  }
  if (linked) shown.push("activity_id");
  show(names, "time_entries", id, shown);
  return fields.length === 0 ? null : { record, id, fields };
}

/** Every column a change writes that the list must show: all but NOT_SHOWN; for an added row, those it sets. */
function writtenColumns(before: Row | null, after: Row): string[] {
  const columns = before === null ? Object.keys(after).filter((column) => after[column] !== null && after[column] !== "") : changedColumns(before, after);
  return columns.filter((column) => !BOOKKEEPING.has(column));
}

/**
 * The list from the built change's rows. `tz` is the owner's timezone and `now` the plan's time. Rows whose change
 * shows nothing the owner would see (a deal's last-contact time) are left out.
 */
export async function proposalList(src: Reader, input: ChangeInput, tz: string, now: Date): Promise<ProposalList> {
  return (await shownList(src, input, tz, now)).list;
}

/**
 * The list, and each column a written row changes that no item shows ("<table>:<id> <column>"), for propose to refuse
 * (checkListShows). A row removed shows as removed; a stage move's own activity shows on its deal's stage line.
 */
export async function shownList(src: Reader, input: ChangeInput, tz: string, now: Date): Promise<{ list: ProposalList; unshown: string[] }> {
  const fieldDefs = await fieldDefRows(src, { includeArchived: true });
  const plannedRows = new Map(input.changes.flatMap((change) => (change.after === null ? [] : [[rowKey(change.table, change.id), change.after]])));
  const names: Names = {
    tz,
    now: now.toISOString(),
    stages: await stageLabels(src),
    statuses: await statusLabels(src),
    projectStatuses: await projectStatusLabels(src),
    fields: new Map(fieldDefs.map((def) => [`${def.entity}.${def.key}`, def.label])),
    planned: plannedRows,
    read: await namedRows(readerOf(src).db, input, plannedRows),
    src,
    shows: new Map(),
  };
  const notes = new Set(input.changes.flatMap((change) => (change.table === "activities" && change.before === null && change.after !== null ? [change.id] : [])));
  const list: ProposalList = { add: [], update: [], tasks: [], notes: [], time: [] };
  for (const { table, id, before, after } of input.changes) {
    if (after === null) {
      if (before !== null) list.update.push({ record: capitalize(rowLabel(table, before)), id, fields: [{ field: "", to: "removed" }] });
      continue;
    }
    if (table === "activities" && before === null) {
      if (after.type !== "stage_change") list.notes.push(await noteItem(names, id, after));
      else if (input.changes.some((change) => change.table === "deals" && change.id === after.deal_id && change.before?.stage_key !== change.after?.stage_key)) {
        show(names, "activities", id, Object.keys(after));
      }
      continue;
    }
    if (table === "tasks") {
      list.tasks.push(await taskItem(names, id, before, after));
      continue;
    }
    if (table === "time_entries") {
      const item = await timeItem(names, id, before, after, notes);
      if (item !== null) list.time.push(item);
      continue;
    }
    if (table === "contacts" || table === "deals") {
      const record = table === "contacts" ? contactRecord(names, before ?? after) : await dealRecord(names, before ?? after);
      if (before === null) {
        list.add.push({ record, id, fields: addedFields(names, table, id, after) });
        continue;
      }
      const fields = await updatedFields(names, table, id, before, after);
      if (fields.length > 0) list.update.push({ record, id, fields });
      continue;
    }
    if (table === "projects") {
      if (before === null) {
        list.add.push({ record: await projectRecord(names, after, false), id, fields: await addedProjectFields(names, id, after) });
        continue;
      }
      const edits = await updatedFields(names, table, id, before, after);
      if (edits.length > 0) list.update.push({ record: await projectRecord(names, before, true), id, fields: edits });
      continue;
    }
    const fields = before === null ? [] : await updatedFields(names, table, id, before, after);
    if (before === null || fields.length > 0) list.update.push({ record: capitalize(rowLabel(table, before ?? after)), id, fields });
  }
  const unshown = input.changes.flatMap(({ table, id, before, after }) => {
    if (after === null) return [];
    const shows = names.shows.get(rowKey(table, id));
    return writtenColumns(before, after)
      .filter((column) => !(shows?.has(column) ?? false))
      .map((column) => `${rowKey(table, id)} ${column}`);
  });
  return { list, unshown };
}
