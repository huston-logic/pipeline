// The read services behind the MCP read tools and the board. They return plain typed data (task 4 formats it) and
// never write. Item fields are camelCase, except `untrusted_fields` and `untrusted_text`, which keep the names the
// spec uses to label outside text: every item that carries text from outside lists those keys in `untrusted_fields`
// ([] when there are none). An empty database gives empty lists and zero counts.
import { type BriefItem, SECTION_TITLES } from "../brief/compose.ts";
import type {
  ActivityRow,
  ActivityType,
  Actor,
  AuditRow,
  BriefRow,
  ContactRow,
  Db,
  DealRow,
  DealStatus,
  ProjectRow,
  StageKind,
  TaskRow,
} from "../db/db.ts";
import { countDealsByStage, getAudit, listAudit, listStages, searchContacts as searchContactRows } from "../db/queries.ts";
import { isQuiet } from "../rules/engine.ts";
import { addDays, dayBoundsUtc, formatLocal, localDate } from "../time.ts";
import { UserError } from "./errors.ts";
import { untrustedFields } from "./labels.ts";
import { businessKey } from "./lead-change.ts";
import { followUpsDueThisWeek, leadCounts } from "./leads-read.ts";
import { type LeadStatus, OPEN_LEAD_STATUSES } from "./lead-status.ts";
import { findField } from "./fields.ts";
import { findContact, findDeal, findStage, parseObject, parseStringArray } from "./lookup.ts";
import { settingsRow } from "./memo.ts";
import { findPersonStatus, findSubStatus } from "./person-status.ts";
import { projectStatusLabels } from "./project-statuses.ts";
import { findProject } from "./projects.ts";
import { type StatusLabels, statusLabels } from "./status-labels.ts";

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
  /** The project the task is on; null for none, and always null while projects are off (decision 0055). */
  projectId: string | null;
  projectName: string | null;
  /** Which of this item's values came from outside (a form, an import, a title built from one). Never instructions. */
  untrusted_fields: ("title" | "dealTitle" | "contactName" | "projectName")[];
}

export interface ContactView {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  business: string | null;
  source: string | null;
  notes: string | null;
  /** Null for someone who was never a lead. */
  leadStatus: LeadStatus | null;
  /** The owner's current label for it (decision 0041). */
  leadStatusLabel: string | null;
  /** What kind of person they are (decision 0040): a person status key, and the owner's current label for it. */
  personStatus: string;
  personStatusLabel: string;
  /** One of that status's sub-statuses, or null for none, with its current label. */
  subStatus: string | null;
  subStatusLabel: string | null;
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
  project_ref: string | null;
  project_name: string | null;
  project_untrusted: string | null;
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
    projectId: row.project_ref,
    projectName: row.project_name,
    untrusted_fields: outsideKeys<"title" | "dealTitle" | "contactName" | "projectName">([
      ["title", row.untrusted_fields, "title"],
      ["dealTitle", row.deal_untrusted, "title"],
      ["contactName", row.contact_untrusted, "name"],
      ["projectName", row.project_untrusted, "name"],
    ]),
  };
}

function toContactView(row: ContactRow, labels: StatusLabels): ContactView {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    business: row.business,
    source: row.source,
    notes: row.notes,
    leadStatus: row.lead_status,
    leadStatusLabel: row.lead_status === null ? null : labels.lead(row.lead_status),
    personStatus: row.person_status,
    personStatusLabel: labels.status(row.person_status),
    subStatus: row.sub_status,
    subStatusLabel: labels.sub(row.person_status, row.sub_status),
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
  c.name AS contact_name, c.untrusted_fields AS contact_untrusted,
  p.id AS project_ref, p.name AS project_name, p.untrusted_fields AS project_untrusted
  FROM tasks t LEFT JOIN deals d ON d.id = t.deal_id
  LEFT JOIN projects p ON p.id = t.project_id AND (SELECT projects FROM settings LIMIT 1) = 1
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
  /** People with a lead status (decision 0022); null when New, Contacted and Not now are all zero. */
  leads: { counts: Record<LeadStatus, number>; followUpsDueThisWeek: number } | null;
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
  const leadTotals = await leadCounts(db);
  const hasLeads = OPEN_LEAD_STATUSES.some((status) => leadTotals[status] > 0);
  return {
    stages: summaries,
    closed: { won: countOf("won"), lost: countOf("lost"), not_now: countOf("not_now") },
    open: { count: listed.length, value: listed.reduce((sum, deal) => sum + (deal.value ?? 0), 0) },
    total: counts.reduce((sum, c) => sum + c.n, 0),
    leads: hasLeads ? { counts: leadTotals, followUpsDueThisWeek: await followUpsDueThisWeek(db, now, tz) } : null,
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

/** An open task for Today's list: the task item and when it was made, for the newest-first sort (decision 0047). */
export type OpenTask = TaskItem & { createdAt: string };

/** Today's sorts and filters (decision 0047): the address's `sort` and `show`. */
export const TASK_SORTS = ["due", "newest", "subject"] as const;
export const TASK_SHOWS = ["all", "linked", "standalone"] as const;
export type TaskSort = (typeof TASK_SORTS)[number];
export type TaskShow = (typeof TASK_SHOWS)[number];
export type TaskView = { sort: TaskSort; show: TaskShow };

/**
 * Each sort's order, ties broken by id. Due: the soonest first, so overdue ones (the earliest) lead. Newest: the latest
 * made first. Person: by the person's name (the deal's person for a task on a deal), ignoring ASCII case, standalone
 * tasks last, then as Due.
 */
const TASK_ORDER: Record<TaskSort, string> = {
  due: "t.due_at, t.created_at, t.id",
  newest: "t.created_at DESC, t.id",
  subject: "c.name IS NULL, lower(c.name), t.due_at, t.created_at, t.id",
};

/** A standalone task has no deal, no person and no project (a task on a deal always has the deal's person; one on an internal project has the project). */
const TASK_FILTER: Record<TaskShow, string> = {
  all: "",
  linked: " AND (t.deal_id IS NOT NULL OR t.contact_id IS NOT NULL OR t.project_id IS NOT NULL)",
  standalone: " AND t.deal_id IS NULL AND t.contact_id IS NULL AND t.project_id IS NULL",
};

export interface OpenTaskLists {
  /** To do: the dated open tasks, sorted, at most `limit`. */
  todo: OpenTask[];
  /** Needs a due date: the undated ones, sorted, at most `limit`. */
  undated: OpenTask[];
  /** How many each list holds in all. */
  totals: { todo: number; undated: number };
}

/**
 * Today's two lists of open, awake tasks (not snoozed past now), filtered and sorted in SQL, each cut to `limit`, with
 * each list's total: one D1 batch, whatever the number of open tasks.
 */
export async function openTaskLists(db: Db, now: Date, tz: string, view: TaskView, limit: number): Promise<OpenTaskLists> {
  const open = `t.done_at IS NULL AND (t.snoozed_until IS NULL OR t.snoozed_until <= ?)${TASK_FILTER[view.show]}`;
  const list = (dated: boolean) =>
    db
      .prepare(`${TASK_SELECT} WHERE ${open} AND t.due_at IS ${dated ? "NOT " : ""}NULL ORDER BY ${TASK_ORDER[view.sort]} LIMIT ?`)
      .bind(now.toISOString(), limit);
  const [todo, undated, totals] = await db.batch([
    list(true),
    list(false),
    db.prepare(`SELECT t.due_at IS NULL AS undated, COUNT(*) AS n FROM tasks t WHERE ${open} GROUP BY 1`).bind(now.toISOString()),
  ]);
  const items = (found: D1Result | undefined) =>
    ((found?.results ?? []) as TaskJoin[]).map((row) => ({ ...toTaskItem(row, tz), createdAt: row.created_at }));
  const total = (undatedOnes: number) => ((totals?.results ?? []) as { undated: number; n: number }[]).find((row) => row.undated === undatedOnes)?.n ?? 0;
  return { todo: items(todo), undated: items(undated), totals: { todo: total(0), undated: total(1) } };
}

export interface TaskListFilter {
  status?: "open" | "done";
  contact?: string;
  deal?: string;
  standalone?: boolean;
  /** A project's id or exact name; refused while projects are off. */
  project?: string;
  limit?: number;
}

/**
 * The owner's tasks, open (snoozed ones included, undated ones too) or done: due first with overdue ahead and undated
 * last, then newest. A contact filter takes the person's own tasks and their deals' (decision 0048).
 */
export async function listTaskItems(db: Db, filter: TaskListFilter, tz: string): Promise<(TaskItem & { doneAt: string | null })[]> {
  if (filter.standalone === true && (filter.contact !== undefined || filter.deal !== undefined)) {
    throw new UserError("standalone means tasks with no person and no deal, so it can't be combined with contact or deal. Leave one out.");
  }
  const clauses = [filter.status === "done" ? "t.done_at IS NOT NULL" : "t.done_at IS NULL"];
  const params: unknown[] = [];
  if (filter.standalone === true) clauses.push("t.deal_id IS NULL AND t.contact_id IS NULL AND t.project_id IS NULL");
  if (filter.contact !== undefined) {
    clauses.push("(t.contact_id = ? OR d.contact_id = ?)");
    const id = (await findContact(db, filter.contact)).id;
    params.push(id, id);
  }
  if (filter.deal !== undefined) {
    clauses.push("t.deal_id = ?");
    params.push((await findDeal(db, filter.deal)).id);
  }
  if (filter.project !== undefined) {
    clauses.push("t.project_id = ?");
    params.push((await findProject(db, filter.project)).id);
  }
  const found = await rows<TaskJoin>(
    db,
    `${TASK_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY t.due_at IS NULL, t.due_at, t.created_at DESC, t.id LIMIT ?`,
    [...params, filter.limit ?? 50],
  );
  return found.map((row) => ({ ...toTaskItem(row, tz), doneAt: row.done_at }));
}

/** A project's tasks for its page: the open ones (snoozed too) due first, or the done ones, latest done first. */
export async function projectTaskItems(db: Db, projectId: string, status: "open" | "done", tz: string, limit: number): Promise<TaskItem[]> {
  const order = status === "open" ? "t.due_at IS NULL, t.due_at, t.created_at, t.id" : "t.done_at DESC, t.id";
  const found = await rows<TaskJoin>(
    db,
    `${TASK_SELECT} WHERE t.project_id = ? AND t.done_at IS ${status === "open" ? "" : "NOT "}NULL ORDER BY ${order} LIMIT ?`,
    [projectId, limit],
  );
  return found.map((row) => toTaskItem(row, tz));
}

/** The newest notes and calls logged on a project. */
export async function projectTimeline(db: Db, projectId: string, tz: string, limit: number): Promise<TimelineItem[]> {
  const found = await rows<ActivityRow>(db, "SELECT * FROM activities WHERE project_id = ? ORDER BY occurred_at DESC, rowid DESC LIMIT ?", [projectId, limit]);
  return found.map((activity) => toTimelineItem(activity, tz));
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
  /** The deal's projects that are not archived; left out while projects are off. */
  projects?: { id: string; name: string; status: string; statusLabel: string; untrusted_fields: "name"[] }[];
}

/** A pre-call brief. `dealRef` is a deal id, title or contact name. */
export async function getDealBrief(db: Db, dealRef: string, tz: string, now: Date): Promise<DealBrief> {
  const found = await findDeal(db, dealRef);
  const [stageRow] = await rows<DealRow & { stage_label: string; stage_kind: StageKind }>(
    db,
    `SELECT d.*, s.label AS stage_label, s.kind AS stage_kind FROM deals d JOIN stages s ON s.key = d.stage_key WHERE d.id = ?`,
    [found.id],
  );
  const contact = await db.prepare("SELECT * FROM contacts WHERE id = ?").bind(found.contact_id).first<ContactRow>();
  if (!stageRow || !contact) throw new Error(`Deal ${found.id} points at a missing contact or stage.`);
  const row = { ...stageRow, contact_name: contact.name, contact_untrusted: contact.untrusted_fields };
  const timeline = await rows<ActivityRow>(
    db,
    `SELECT * FROM activities WHERE deal_id = ? OR (deal_id IS NULL AND contact_id = ? AND project_id IS NULL)
     ORDER BY occurred_at DESC, rowid DESC LIMIT 50`,
    [row.id, row.contact_id],
  );
  const tasks = await rows<TaskJoin>(
    db,
    `${TASK_SELECT} WHERE t.done_at IS NULL AND (t.deal_id = ? OR (t.deal_id IS NULL AND t.contact_id = ? AND t.project_id IS NULL))
     ORDER BY t.due_at IS NULL, t.due_at, t.created_at, t.id`,
    [row.id, row.contact_id],
  );
  const item = toDealItem(row, now, tz);
  const projects = (await settingsRow(db)).projects === 1 ? await dealProjects(db, row.id) : undefined;
  return {
    deal: { ...item, fields: parseObject(row.fields), createdAt: row.created_at, archived: row.archived === 1 },
    contact: toContactView(contact, await statusLabels(db)),
    stage: { key: row.stage_key, label: row.stage_label, kind: row.stage_kind },
    timeline: timeline.map((activity) => toTimelineItem(activity, tz)),
    openTasks: tasks.map((task) => toTaskItem(task, tz)),
    next: { step: item.nextStep, at: item.nextAt, atLocal: item.nextAtLocal },
    ...(projects === undefined ? {} : { projects }),
  };
}

async function dealProjects(db: Db, dealId: string): Promise<NonNullable<DealBrief["projects"]>> {
  const found = await rows<ProjectRow>(db, "SELECT * FROM projects WHERE deal_id = ? AND archived = 0 ORDER BY created_at, id", [dealId]);
  const labels = await projectStatusLabels(db);
  return found.map((project) => ({
    id: project.id,
    name: project.name,
    status: project.status_key,
    statusLabel: labels.get(project.status_key) ?? project.status_key,
    untrusted_fields: outsideKeys<"name">([["name", project.untrusted_fields, "name"]]),
  }));
}

export interface ContactMatch extends ContactView {
  deals: { id: string; title: string; stageLabel: string; status: DealStatus; untrusted_fields: "title"[] }[];
}

export interface ContactSearch {
  leadStatuses?: LeadStatus[];
  /** A person status by key or label (decision 0041). */
  personStatus?: string;
  /** One of that status's sub-statuses by key or label; needs `personStatus`. */
  subStatus?: string;
  /** A custom contact field by key or label, with `value`: the value it holds. */
  field?: string;
  value?: string | number;
}

/** The field filter as the query takes it: refused for an unknown or archived field, or a value its type can't hold. */
async function fieldFilter(db: Db, ref: string | undefined, value: string | number | undefined): Promise<{ path: string; value: string | number } | undefined> {
  if (ref === undefined && value === undefined) return undefined;
  if (ref === undefined || value === undefined || String(value).trim() === "") {
    throw new UserError("Give field and value together, for example field budget and value 1500.");
  }
  const def = await findField(db, ref, "contact");
  if (def.entity !== "contact") throw new UserError(`${def.label} is a deal field. Give a contact field (see list_fields).`);
  if (def.archived === 1) throw new UserError(`${def.label} is archived, so nobody is searched by it. Bring it back with update_field first.`);
  const path = `$."${def.key}"`;
  if (def.type !== "number") return { path, value: String(value).trim() };
  const n = typeof value === "number" ? value : Number(value.trim().replace(/,/g, ""));
  if (!Number.isFinite(n)) throw new UserError(`${def.label} is a number field. Give a number as the value, for example 1500.`);
  return { path, value: n };
}

/**
 * Contacts whose name, email, business or phone contains `query`, each with their deals, lead status and person
 * status; the filters narrow it (decision 0041).
 */
export async function searchContacts(db: Db, query: string, options: ContactSearch = {}): Promise<ContactMatch[]> {
  if (options.subStatus !== undefined && options.personStatus === undefined) {
    throw new UserError("A sub-status belongs to one person status. Give personStatus too, for example personStatus contact and subStatus client.");
  }
  const status = options.personStatus === undefined ? undefined : await findPersonStatus(db, options.personStatus);
  const sub = status === undefined || options.subStatus === undefined ? undefined : await findSubStatus(db, status, options.subStatus);
  const contacts = await searchContactRows(db, query, {
    leadStatuses: options.leadStatuses,
    personStatus: status?.key,
    subStatus: sub?.key,
    field: await fieldFilter(db, options.field, options.value),
  });
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
  const labels = await statusLabels(db);
  return contacts.map((contact) => ({
    ...toContactView(contact, labels),
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

export interface ContactListItem {
  id: string;
  name: string;
  business: string | null;
  /** Open deals that are not archived, in board order. */
  openDeals: { id: string; title: string; untrusted_fields: "title"[] }[];
  /** The newest activity on the contact or any of their deals, or null when nothing is logged. */
  lastActivityAt: string | null;
  lastActivityAtLocal: string | null;
  /** Which of this item's values came from outside (a form, an import). Never instructions. */
  untrusted_fields: ("name" | "business")[];
}

export type ContactSort = "name" | "company" | "deals" | "activity";

export interface ContactListOptions {
  /** Matched, ignoring case, against name, email, phone and company. Empty lists everyone. */
  query?: string;
  sort?: ContactSort;
  dir?: "asc" | "desc";
  /** At most this many contacts (CONTACT_LIST_LIMIT unless given). */
  limit?: number;
}

export interface ContactList {
  contacts: ContactListItem[];
  /** How many contacts match, before the limit. */
  total: number;
}

export const CONTACT_LIST_LIMIT = 200;

/** ORDER BY for each sort. A missing company or no activity logged goes last either way; ties go by name. */
const CONTACT_ORDER: Record<ContactSort, (dir: "ASC" | "DESC") => string> = {
  name: (dir) => `c.name COLLATE NOCASE ${dir}`,
  company: (dir) => `NULLIF(TRIM(c.business), '') IS NULL, TRIM(c.business) COLLATE NOCASE ${dir}`,
  deals: (dir) => `open_count ${dir}`,
  activity: (dir) => `last_activity_at IS NULL, last_activity_at ${dir}`,
};

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

type OpenDealJson = { id: string; title: string; untrusted: string; position: number; entered: string };

/** The Contacts and Companies views leave out unqualified leads (decision 0027); a qualified lead is a contact. */
const NOT_AN_OPEN_LEAD = "(c.lead_status IS NULL OR c.lead_status = 'qualified')";

/**
 * The board's contacts list: contacts that are not archived, searched and sorted, with their open deals and the
 * newest activity on the contact or any of their deals. One query, whatever the number of contacts.
 */
export async function listContacts(db: Db, tz: string, options: ContactListOptions = {}): Promise<ContactList> {
  const text = (options.query ?? "").trim();
  const sort = options.sort ?? "name";
  const dir = options.dir === "desc" ? "DESC" : "ASC";
  const where = ["c.archived = 0", NOT_AN_OPEN_LEAD];
  const params: unknown[] = [];
  if (text !== "") {
    where.push(["c.name", "c.email", "c.phone", "c.business"].map((column) => `${column} LIKE ? ESCAPE '\\'`).join(" OR "));
    params.push(...Array.from({ length: 4 }, () => `%${escapeLike(text)}%`));
  }
  const found = await rows<{
    id: string;
    name: string;
    business: string | null;
    untrusted_fields: string;
    open_count: number;
    open_list: string | null;
    last_activity_at: string | null;
    total: number;
  }>(
    db,
    `WITH open_deals AS (
       SELECT d.contact_id, COUNT(*) AS n, json_group_array(json_object('id', d.id, 'title', d.title,
         'untrusted', d.untrusted_fields, 'position', s.position, 'entered', d.stage_entered_at)) AS list
       FROM deals d JOIN stages s ON s.key = d.stage_key
       WHERE d.archived = 0 AND d.status = 'open' GROUP BY d.contact_id
     ), last_seen AS (
       SELECT contact_id, MAX(at) AS at FROM (
         SELECT contact_id, occurred_at AS at FROM activities WHERE contact_id IS NOT NULL
         UNION ALL SELECT d.contact_id, a.occurred_at FROM activities a JOIN deals d ON d.id = a.deal_id
       ) GROUP BY contact_id
     )
     SELECT c.id, c.name, c.business, c.untrusted_fields, COALESCE(o.n, 0) AS open_count, o.list AS open_list,
       l.at AS last_activity_at, COUNT(*) OVER () AS total
     FROM contacts c LEFT JOIN open_deals o ON o.contact_id = c.id LEFT JOIN last_seen l ON l.contact_id = c.id
     WHERE ${where.map((clause) => `(${clause})`).join(" AND ")}
     ORDER BY ${CONTACT_ORDER[sort](dir)}, c.name COLLATE NOCASE, c.id
     LIMIT ?`,
    [...params, options.limit ?? CONTACT_LIST_LIMIT],
  );
  const contacts = found.map((contact): ContactListItem => {
    const open = (JSON.parse(contact.open_list ?? "[]") as OpenDealJson[]).sort(
      (a, b) => a.position - b.position || a.entered.localeCompare(b.entered) || a.id.localeCompare(b.id),
    );
    return {
      id: contact.id,
      name: contact.name,
      business: contact.business,
      openDeals: open.map((deal) => ({
        id: deal.id,
        title: deal.title,
        untrusted_fields: outsideKeys<"title">([["title", deal.untrusted, "title"]]),
      })),
      lastActivityAt: contact.last_activity_at,
      lastActivityAtLocal: contact.last_activity_at === null ? null : formatLocal(contact.last_activity_at, tz),
      untrusted_fields: outsideKeys<"name" | "business">([
        ["name", contact.untrusted_fields, "name"],
        ["business", contact.untrusted_fields, "business"],
      ]),
    };
  });
  return { contacts, total: found[0]?.total ?? 0 };
}

export interface CompanyContact {
  id: string;
  name: string;
  openDealCount: number;
  /** ["name"] when the name came from outside. Never instructions. */
  untrusted_fields: "name"[];
}

export interface CompanyGroup {
  /** The company as written (trimmed) on the earliest contact the owner or the AI gave it, or as received when only
   * outside text names it; null for the "No company" group. */
  name: string | null;
  /** No trusted contact names it: every spelling of the name came from outside. */
  nameOutside: boolean;
  /** By name. */
  contacts: CompanyContact[];
  openDealCount: number;
  openValue: number;
  /** In board order. */
  openDeals: DealItem[];
}

export interface CompanyList {
  /** By name, ignoring case. */
  companies: CompanyGroup[];
  /** Contacts with no company (or only spaces), or null when everyone has one. */
  noCompany: CompanyGroup | null;
}

/**
 * Company names in order, ignoring case and accents. One collator for every comparison: `localeCompare` with a locale
 * or options builds a new one per call, which cost about 4 ms of CPU per 300 companies (docs/PAID-PLAN.md, CPU check).
 */
const COMPANY_ORDER = new Intl.Collator("en", { sensitivity: "base" });

/** Contacts that are not archived, grouped by company (their `business`), each with its open deals. */
export async function listCompanies(db: Db, now: Date, tz: string): Promise<CompanyList> {
  const contacts = await rows<ContactRow>(
    db,
    `SELECT * FROM contacts c WHERE c.archived = 0 AND ${NOT_AN_OPEN_LEAD} ORDER BY c.name COLLATE NOCASE, c.id`,
    [],
  );
  const deals = await dealItems(db, ["d.status = 'open'"], [], now, tz);
  // Grouped once, so the loop below is linear in contacts plus deals.
  const dealsOf = new Map<string, DealItem[]>();
  for (const deal of deals) {
    const list = dealsOf.get(deal.contactId);
    if (list) list.push(deal);
    else dealsOf.set(deal.contactId, [deal]);
  }
  const groups = new Map<string, CompanyGroup>();
  /** When each company's shown spelling was written: the earliest trusted one wins. */
  const since = new Map<string, string>();
  for (const contact of contacts) {
    const key = businessKey(contact.business);
    const outside = untrustedFields(contact);
    const spelled = (contact.business ?? "").trim().replace(/\s+/g, " ");
    let group = groups.get(key);
    if (!group) {
      group = { name: key === "" ? null : spelled, nameOutside: key !== "", contacts: [], openDealCount: 0, openValue: 0, openDeals: [] };
      groups.set(key, group);
    }
    // The spelling on the earliest contact the owner or the AI wrote it for wins over later and outside ones.
    const first = since.get(key);
    if (key !== "" && !outside.has("business") && (first === undefined || contact.created_at < first)) {
      group.name = spelled;
      group.nameOutside = false;
      since.set(key, contact.created_at);
    }
    const own = dealsOf.get(contact.id) ?? [];
    group.contacts.push({
      id: contact.id,
      name: contact.name,
      openDealCount: own.length,
      untrusted_fields: outside.has("name") ? ["name"] : [],
    });
    group.openDeals.push(...own);
    group.openDealCount += own.length;
    group.openValue += own.reduce((sum, deal) => sum + (deal.value ?? 0), 0);
  }
  const order = new Map(deals.map((deal, i) => [deal.id, i]));
  const done = [...groups.values()];
  for (const group of done) group.openDeals.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const companies = done
    .filter((group) => group.name !== null)
    .sort((a, b) => COMPANY_ORDER.compare(a.name ?? "", b.name ?? ""));
  return { companies, noCompany: done.find((group) => group.name === null) ?? null };
}

export interface ContactTimelineItem extends TimelineItem {
  /** The deal the entry is on, or null for one on the contact alone. */
  dealId: string | null;
  /** That deal, archived ones included, so an entry on a deal is never shown as one on the contact alone. */
  deal: { id: string; title: string; untrusted_fields: "title"[]; archived: boolean } | null;
}

export interface ContactDetail {
  contact: ContactView;
  /** Every deal of theirs that is not archived, open and closed, in board order. */
  deals: DealItem[];
  /** Not done yet, snoozed ones included: on the contact or any of their deals. */
  openTasks: TaskItem[];
  /** Newest first, at most CONTACT_TIMELINE_LIMIT: the contact's own entries and their deals'. */
  timeline: ContactTimelineItem[];
  /** There are older entries than the ones listed. */
  timelineMore: boolean;
}

export const CONTACT_TIMELINE_LIMIT = 50;

/** The contact page, or null when there is no contact with this id. Archived contacts are still shown. */
export async function contactDetail(db: Db, id: string, tz: string, now: Date): Promise<ContactDetail | null> {
  const contact = await db.prepare("SELECT * FROM contacts WHERE id = ?").bind(id).first<ContactRow>();
  if (!contact) return null;
  const deals = await dealItems(db, ["d.contact_id = ?"], [id], now, tz);
  const theirs = "(SELECT d.id FROM deals d WHERE d.contact_id = ?)";
  const tasks = await rows<TaskJoin>(
    db,
    `${TASK_SELECT} WHERE t.done_at IS NULL AND (t.contact_id = ? OR t.deal_id IN ${theirs})
     ORDER BY t.due_at IS NULL, t.due_at, t.created_at, t.id`,
    [id, id],
  );
  const timeline = await rows<
    ActivityRow & { deal_title: string | null; deal_untrusted: string | null; deal_archived: number | null }
  >(
    db,
    `SELECT a.*, d.title AS deal_title, d.untrusted_fields AS deal_untrusted, d.archived AS deal_archived
     FROM activities a LEFT JOIN deals d ON d.id = a.deal_id
     WHERE a.contact_id = ? OR a.deal_id IN ${theirs}
     ORDER BY a.occurred_at DESC, a.rowid DESC LIMIT ?`,
    [id, id, CONTACT_TIMELINE_LIMIT + 1],
  );
  return {
    contact: toContactView(contact, await statusLabels(db)),
    deals,
    openTasks: tasks.map((task) => toTaskItem(task, tz)),
    timeline: timeline
      .slice(0, CONTACT_TIMELINE_LIMIT)
      .map(({ deal_title, deal_untrusted, deal_archived, ...activity }) => ({
        ...toTimelineItem(activity, tz),
        dealId: activity.deal_id,
        deal:
          activity.deal_id === null || deal_title === null
            ? null
            : {
                id: activity.deal_id,
                title: deal_title,
                untrusted_fields: outsideKeys<"title">([["title", deal_untrusted, "title"]]),
                archived: deal_archived === 1,
              },
      })),
    timelineMore: timeline.length > CONTACT_TIMELINE_LIMIT,
  };
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

function toChangeItem(row: AuditRow): ChangeItem {
  return {
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
  };
}

/** Changes at or after `since`, newest first; at most `limit` (100 unless given). */
export async function recentChanges(db: Db, since: Date, options: { limit?: number } = {}): Promise<ChangeItem[]> {
  return (await listAudit(db, since.toISOString(), options)).map(toChangeItem);
}

/** One change by id, or null when there is none. */
export async function getChange(db: Db, id: string): Promise<ChangeItem | null> {
  const row = await getAudit(db, id);
  return row === null ? null : toChangeItem(row);
}

/** How many deals that are not archived each stage holds, closed stages included; a stage with none is missing. */
export async function stageCounts(db: Db): Promise<Map<string, number>> {
  return new Map((await countDealsByStage(db)).map((row) => [row.stage_key, row.n]));
}

export const CHANGE_LOG_DAYS = 30;
const CHANGE_LOG_LIMIT = 200;

export interface ChangeLog {
  /** UTC ISO start of the window. */
  since: string;
  changes: ChangeItem[];
  /** More changes happened in the window than the newest CHANGE_LOG_LIMIT shown. */
  truncated: boolean;
}

/** The board's change log: the last 30 days, newest first. */
export async function changeLog(db: Db, now: Date): Promise<ChangeLog> {
  const since = new Date(now.getTime() - CHANGE_LOG_DAYS * 86_400_000);
  const changes = await recentChanges(db, since, { limit: CHANGE_LOG_LIMIT + 1 });
  return {
    since: since.toISOString(),
    changes: changes.slice(0, CHANGE_LOG_LIMIT),
    truncated: changes.length > CHANGE_LOG_LIMIT,
  };
}

export interface BriefView {
  id: string;
  /** The owner's local date the brief is for, YYYY-MM-DD. */
  localDate: string;
  composedAt: string;
  /** The first line, also the email subject. The rest of the stored text is left out: it holds outside text
   * without labels, and `items` carries the same lines with them. */
  subject: string;
  /** One per line, in order; `untrusted: true` when the line includes outside text. */
  items: BriefItem[];
  sentAt: string | null;
  /** "sent", "pending", "off: <reason>" or "failed: <HTTP status>" (decision 0011). */
  sendStatus: string | null;
}

// Built from the compose module's own list, so a new section can never be dropped when a stored brief is read.
const BRIEF_SECTIONS = new Set<string>(Object.keys(SECTION_TITLES));

function isBriefItem(value: unknown): value is BriefItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.section === "string" &&
    BRIEF_SECTIONS.has(item.section) &&
    typeof item.id === "string" &&
    typeof item.line === "string" &&
    typeof item.untrusted === "boolean"
  );
}

/** Stored items that can't be read are left out (and an unreadable list is empty), never guessed. */
function parseBriefItems(json: string): BriefItem[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter(isBriefItem) : [];
  } catch {
    return [];
  }
}

/** The newest brief, or null before the first one is composed. */
export async function latestBrief(db: Db): Promise<BriefView | null> {
  const row = await db.prepare("SELECT * FROM briefs ORDER BY local_date DESC LIMIT 1").first<BriefRow>();
  if (!row) return null;
  return {
    id: row.id,
    localDate: row.local_date,
    composedAt: row.composed_at,
    subject: row.text.split("\n", 1)[0] ?? "",
    items: parseBriefItems(row.items),
    sentAt: row.sent_at,
    sendStatus: row.send_status,
  };
}
