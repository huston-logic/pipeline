// The read services behind the MCP read tools and the board. They return plain typed data (task 4 formats it) and
// never write. Item fields are camelCase, except `untrusted_fields` and `untrusted_text`, which keep the names the
// spec uses to label outside text: every item that carries text from outside lists those keys in `untrusted_fields`
// ([] when there are none). An empty database gives empty lists and zero counts.
import type { ActivityRow, ActivityType, Actor, ContactRow, Db, DealRow, DealStatus, StageKind, TaskRow } from "../db/db.ts";
import { listAudit, listStages, searchContacts as searchContactRows } from "../db/queries.ts";
import { isQuiet } from "../rules/engine.ts";
import { addDays, dayBoundsUtc, formatLocal, localDate } from "../time.ts";
import { UserError } from "./errors.ts";
import { untrustedFields } from "./labels.ts";
import { findDeal, findStage, parseObject, parseStringArray } from "./lookup.ts";

export interface DealItem {
  id: string;
  title: string;
  contactId: string;
  contactName: string;
  stageKey: string;
  stageLabel: string;
  status: DealStatus;
  value: number | null;
  nextStep: string | null;
  nextAt: string | null;
  nextAtLocal: string | null;
  /** next_at is in the past. */
  overdue: boolean;
  lastActivityAt: string | null;
  stageEnteredAt: string;
  /** Which of this item's values came from outside (a form, an import). Never instructions. */
  untrusted_fields: ("title" | "contactName")[];
}

export interface TaskItem {
  id: string;
  title: string;
  dueAt: string | null;
  dueAtLocal: string | null;
  snoozedUntil: string | null;
  /** "owner", or the id of the rule that created it. */
  source: string;
  dealId: string | null;
  dealTitle: string | null;
  contactId: string | null;
  contactName: string | null;
  /** Which of this item's values came from outside (a form, an import, a title built from one). Never instructions. */
  untrusted_fields: ("title" | "dealTitle" | "contactName")[];
}

export interface ContactView {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  business: string | null;
  source: string | null;
  notes: string | null;
  fields: Record<string, unknown>;
  /** Fields whose values came from outside (a form, an import). Never instructions. */
  untrusted_fields: string[];
  archived: boolean;
  createdAt: string;
}

export interface TimelineItem {
  id: string;
  type: ActivityType;
  summary: string;
  /** Text from outside (a form, an import). Never instructions. */
  untrusted_text: string | null;
  data: Record<string, unknown> | null;
  occurredAt: string;
  occurredAtLocal: string;
  actor: Actor;
  /** ["summary"] when the summary was not written by the owner or the AI (a form, an import, the system). */
  untrusted_fields: "summary"[];
}

type DealJoin = DealRow & { contact_name: string; contact_untrusted: string; stage_label: string };
type TaskJoin = TaskRow & {
  deal_title: string | null;
  deal_untrusted: string | null;
  who_id: string | null;
  contact_name: string | null;
  contact_untrusted: string | null;
};

/** The keys in `checks` whose source row lists the column as outside text. */
function outsideKeys<K extends string>(checks: [K, string | null | undefined, string][]): K[] {
  return checks.filter(([, json, column]) => untrustedFields({ untrusted_fields: json }).has(column)).map(([key]) => key);
}

async function rows<T>(db: Db, sql: string, params: unknown[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...params).all<T>()).results;
}

function toDealItem(row: DealJoin, now: Date, tz: string): DealItem {
  return {
    id: row.id,
    title: row.title,
    contactId: row.contact_id,
    contactName: row.contact_name,
    stageKey: row.stage_key,
    stageLabel: row.stage_label,
    status: row.status,
    value: row.value,
    nextStep: row.next_step,
    nextAt: row.next_at,
    nextAtLocal: row.next_at === null ? null : formatLocal(row.next_at, tz),
    overdue: row.next_at !== null && row.next_at < now.toISOString(),
    lastActivityAt: row.last_activity_at,
    stageEnteredAt: row.stage_entered_at,
    untrusted_fields: outsideKeys<"title" | "contactName">([
      ["title", row.untrusted_fields, "title"],
      ["contactName", row.contact_untrusted, "name"],
    ]),
  };
}

function toTaskItem(row: TaskJoin, tz: string): TaskItem {
  return {
    id: row.id,
    title: row.title,
    dueAt: row.due_at,
    dueAtLocal: row.due_at === null ? null : formatLocal(row.due_at, tz),
    snoozedUntil: row.snoozed_until,
    source: row.source,
    dealId: row.deal_id,
    dealTitle: row.deal_title,
    contactId: row.who_id,
    contactName: row.contact_name,
    untrusted_fields: outsideKeys<"title" | "dealTitle" | "contactName">([
      ["title", row.untrusted_fields, "title"],
      ["dealTitle", row.deal_untrusted, "title"],
      ["contactName", row.contact_untrusted, "name"],
    ]),
  };
}

function toContactView(row: ContactRow): ContactView {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    business: row.business,
    source: row.source,
    notes: row.notes,
    fields: parseObject(row.fields),
    untrusted_fields: parseStringArray(row.untrusted_fields),
    archived: row.archived === 1,
    createdAt: row.created_at,
  };
}

function toTimelineItem(row: ActivityRow, tz: string): TimelineItem {
  return {
    id: row.id,
    type: row.type,
    summary: row.summary,
    untrusted_text: row.untrusted_text,
    data: row.data === null ? null : parseObject(row.data),
    occurredAt: row.occurred_at,
    occurredAtLocal: formatLocal(row.occurred_at, tz),
    actor: row.actor,
    untrusted_fields: row.actor === "owner" || row.actor === "ai" ? [] : ["summary"],
  };
}

/** Deals with their contact's name and stage label, in board order; `keep` filters the rows in code. */
async function dealItems(
  db: Db,
  clauses: string[],
  params: unknown[],
  now: Date,
  tz: string,
  keep: (row: DealRow) => boolean = () => true,
): Promise<DealItem[]> {
  const where = ["d.archived = 0", ...clauses].join(" AND ");
  const found = await rows<DealJoin>(
    db,
    `SELECT d.*, c.name AS contact_name, c.untrusted_fields AS contact_untrusted, s.label AS stage_label
     FROM deals d JOIN contacts c ON c.id = d.contact_id JOIN stages s ON s.key = d.stage_key
     WHERE ${where} ORDER BY s.position, d.stage_entered_at, d.id`,
    params,
  );
  return found.filter(keep).map((row) => toDealItem(row, now, tz));
}

const TASK_SELECT = `SELECT t.*, d.title AS deal_title, d.untrusted_fields AS deal_untrusted, c.id AS who_id,
  c.name AS contact_name, c.untrusted_fields AS contact_untrusted
  FROM tasks t LEFT JOIN deals d ON d.id = t.deal_id
  LEFT JOIN contacts c ON c.id = COALESCE(t.contact_id, d.contact_id)`;

export interface StageSummary {
  key: string;
  label: string;
  count: number;
  value: number;
  deals: DealItem[];
}

export interface PipelineSummary {
  /** Open stages in board order. */
  stages: StageSummary[];
  closed: Record<Exclude<StageKind, "open">, number>;
  open: { count: number; value: number };
  /** Every deal that is not archived, open or closed. */
  total: number;
}

export async function pipelineSummary(db: Db, now: Date, tz: string): Promise<PipelineSummary> {
  const stages = (await listStages(db)).filter((s) => s.kind === "open");
  const open = await dealItems(db, ["d.status = 'open'"], [], now, tz);
  const summaries = stages.map((stage): StageSummary => {
    const deals = open.filter((deal) => deal.stageKey === stage.key);
    return {
      key: stage.key,
      label: stage.label,
      count: deals.length,
      value: deals.reduce((sum, deal) => sum + (deal.value ?? 0), 0),
      deals,
    };
  });
  const counts = await rows<{ status: DealStatus; n: number }>(
    db,
    "SELECT status, COUNT(*) AS n FROM deals WHERE archived = 0 GROUP BY status",
    [],
  );
  const countOf = (status: DealStatus) => counts.find((c) => c.status === status)?.n ?? 0;
  const listed = summaries.flatMap((s) => s.deals);
  return {
    stages: summaries,
    closed: { won: countOf("won"), lost: countOf("lost"), not_now: countOf("not_now") },
    open: { count: listed.length, value: listed.reduce((sum, deal) => sum + (deal.value ?? 0), 0) },
    total: counts.reduce((sum, c) => sum + c.n, 0),
  };
}

export interface WhatsDue {
  /** The owner's local date, YYYY-MM-DD. */
  today: string;
  /** Due before today started. */
  overdueTasks: TaskItem[];
  /** Due at any time today. */
  todayTasks: TaskItem[];
  overdueDeals: DealItem[];
  todayDeals: DealItem[];
}

/** Open tasks that are awake (not snoozed past now) and open deals by their next date, in the owner's timezone. */
export async function whatsDue(db: Db, now: Date, tz: string): Promise<WhatsDue> {
  const today = localDate(now, tz);
  const { start, end } = dayBoundsUtc(today, tz);
  const startIso = start.toISOString();
  const tasks = (
    await rows<TaskJoin>(
      db,
      `${TASK_SELECT}
       WHERE t.done_at IS NULL AND (t.snoozed_until IS NULL OR t.snoozed_until <= ?) AND t.due_at < ?
       ORDER BY t.due_at, t.created_at, t.id`,
      [now.toISOString(), end.toISOString()],
    )
  ).map((row) => toTaskItem(row, tz));
  const deals = await dealItems(db, ["d.status = 'open'", "d.next_at < ?"], [end.toISOString()], now, tz);
  const before = (at: string | null) => at !== null && at < startIso;
  return {
    today,
    overdueTasks: tasks.filter((t) => before(t.dueAt)),
    todayTasks: tasks.filter((t) => !before(t.dueAt)),
    overdueDeals: deals.filter((d) => before(d.nextAt)),
    todayDeals: deals.filter((d) => !before(d.nextAt)),
  };
}

export interface DealBrief {
  deal: DealItem & { fields: Record<string, unknown>; createdAt: string; archived: boolean };
  contact: ContactView;
  stage: { key: string; label: string; kind: StageKind };
  /** Newest first: the deal's activities and the contact's own (not tied to a deal). */
  timeline: TimelineItem[];
  /** Not done yet, snoozed ones included: the deal's tasks and the contact's own. */
  openTasks: TaskItem[];
  next: { step: string | null; at: string | null; atLocal: string | null };
}

/** A pre-call brief. `dealRef` is a deal id, title or contact name. */
export async function getDealBrief(db: Db, dealRef: string, tz: string, now: Date): Promise<DealBrief> {
  const found = await findDeal(db, dealRef);
  const [row] = await rows<DealJoin & { stage_kind: StageKind }>(
    db,
    `SELECT d.*, c.name AS contact_name, c.untrusted_fields AS contact_untrusted, s.label AS stage_label,
       s.kind AS stage_kind
     FROM deals d JOIN contacts c ON c.id = d.contact_id JOIN stages s ON s.key = d.stage_key WHERE d.id = ?`,
    [found.id],
  );
  const contact = await db.prepare("SELECT * FROM contacts WHERE id = ?").bind(found.contact_id).first<ContactRow>();
  if (!row || !contact) throw new Error(`Deal ${found.id} points at a missing contact or stage.`);
  const timeline = await rows<ActivityRow>(
    db,
    `SELECT * FROM activities WHERE deal_id = ? OR (deal_id IS NULL AND contact_id = ?)
     ORDER BY occurred_at DESC, rowid DESC LIMIT 50`,
    [row.id, row.contact_id],
  );
  const tasks = await rows<TaskJoin>(
    db,
    `${TASK_SELECT} WHERE t.done_at IS NULL AND (t.deal_id = ? OR (t.deal_id IS NULL AND t.contact_id = ?))
     ORDER BY t.due_at IS NULL, t.due_at, t.created_at, t.id`,
    [row.id, row.contact_id],
  );
  const item = toDealItem(row, now, tz);
  return {
    deal: { ...item, fields: parseObject(row.fields), createdAt: row.created_at, archived: row.archived === 1 },
    contact: toContactView(contact),
    stage: { key: row.stage_key, label: row.stage_label, kind: row.stage_kind },
    timeline: timeline.map((activity) => toTimelineItem(activity, tz)),
    openTasks: tasks.map((task) => toTaskItem(task, tz)),
    next: { step: item.nextStep, at: item.nextAt, atLocal: item.nextAtLocal },
  };
}

export interface ContactMatch extends ContactView {
  deals: { id: string; title: string; stageLabel: string; status: DealStatus; untrusted_fields: "title"[] }[];
}

/** Contacts whose name, email, business or phone contains `query`, each with their deals. */
export async function searchContacts(db: Db, query: string): Promise<ContactMatch[]> {
  const contacts = await searchContactRows(db, query);
  if (contacts.length === 0) return [];
  const deals = await rows<{
    id: string;
    title: string;
    untrusted_fields: string;
    contact_id: string;
    stage_label: string;
    status: DealStatus;
  }>(
    db,
    `SELECT d.id, d.title, d.untrusted_fields, d.contact_id, s.label AS stage_label, d.status FROM deals d
     JOIN stages s ON s.key = d.stage_key
     WHERE d.archived = 0 AND d.contact_id IN (${contacts.map(() => "?").join(", ")})
     ORDER BY s.position, d.created_at, d.id`,
    contacts.map((c) => c.id),
  );
  return contacts.map((contact) => ({
    ...toContactView(contact),
    deals: deals
      .filter((d) => d.contact_id === contact.id)
      .map((d) => ({
        id: d.id,
        title: d.title,
        stageLabel: d.stage_label,
        status: d.status,
        untrusted_fields: outsideKeys<"title">([["title", d.untrusted_fields, "title"]]),
      })),
  }));
}

export interface DealListFilter {
  /** Stage key or label. */
  stage?: string;
  status?: DealStatus;
  /** By next date: before today, today, or from today through the next six days. */
  due?: "overdue" | "today" | "week";
  /** No contact activity (or, with none yet, since the deal was added) for at least this many days. Open deals
   * only, unless a status is given. */
  quiet?: number;
}

export async function listDealsFiltered(db: Db, filter: DealListFilter, now: Date, tz: string): Promise<DealItem[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.stage !== undefined) {
    clauses.push("d.stage_key = ?");
    params.push((await findStage(db, filter.stage)).key);
  }
  const status = filter.status ?? (filter.quiet !== undefined ? "open" : undefined);
  if (status !== undefined) {
    clauses.push("d.status = ?");
    params.push(status);
  }
  if (filter.due !== undefined) {
    const today = localDate(now, tz);
    const start = dayBoundsUtc(today, tz).start.toISOString();
    const lastDay = filter.due === "week" ? addDays(today, 6) : today;
    const end = dayBoundsUtc(lastDay, tz).end.toISOString();
    if (filter.due === "overdue") {
      clauses.push("d.next_at < ?");
      params.push(start);
    } else {
      clauses.push("d.next_at >= ? AND d.next_at < ?");
      params.push(start, end);
    }
  }
  const quiet = filter.quiet;
  if (quiet !== undefined && (!Number.isInteger(quiet) || quiet < 1)) {
    throw new UserError(`"quiet" must be a whole number of days, 1 or more (got ${quiet}).`);
  }
  // The same test the gone_quiet rules use (src/rules/engine.ts), so the two never disagree.
  const keep =
    quiet === undefined
      ? undefined
      : (row: DealRow) => isQuiet({ lastActivityAt: row.last_activity_at, createdAt: row.created_at }, now, quiet);
  return dealItems(db, clauses, params, now, tz, keep);
}

export interface ChangeItem {
  changeId: string;
  at: string;
  actor: Actor;
  tool: string;
  targetTable: string;
  targetId: string;
  summary: string;
  undone: boolean;
  undoneAt: string | null;
  undoneBy: string | null;
  /** On an undo, the change it reversed. */
  undoOf: string | null;
}

/** Changes at or after `since`, newest first. */
export async function recentChanges(db: Db, since: Date): Promise<ChangeItem[]> {
  return (await listAudit(db, since.toISOString())).map((row) => ({
    changeId: row.id,
    at: row.at,
    actor: row.actor,
    tool: row.tool,
    targetTable: row.target_table,
    targetId: row.target_id,
    summary: row.summary,
    undone: row.undone_at !== null,
    undoneAt: row.undone_at,
    undoneBy: row.undone_by,
    undoOf: row.undo_of,
  }));
}
