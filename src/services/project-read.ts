// Reading projects (decision 0055): the list with open-task counts and one project's page data. Every read goes through
// requireProjects. Outside text (a name, the person's or the deal's) is listed in `untrusted_fields`. The time amount
// is never stored: it is each entry's stored rate x minutes / 60, in cents, worked out here.
import type { Db, TimeEntryRow } from "../db/db.ts";
import { untrustedFields } from "./labels.ts";
import { findContact, parseObject } from "./lookup.ts";
import { projectStatusRows, settingsRow } from "./memo.ts";
import { projectStatusLabels } from "./project-statuses.ts";
import { findProject } from "./projects.ts";
import { projectTaskItems, projectTimeline, type TaskItem, type TimelineItem } from "./read.ts";
import { requireProjects } from "./settings.ts";
import { amountOf } from "./time-format.ts";
import { UserError } from "./errors.ts";

export const PROJECT_LIST_LIMIT = 200;
const SECTION_LIMIT = 20;
const OPEN_TASK_LIMIT = 200;

export type ProjectSort = "target" | "name" | "newest";

export interface ProjectListOptions {
  /** A project status key or label, or "open" or "closed" for every live status of that kind. */
  status?: string;
  /** A person's id or exact name. */
  contact?: string;
  includeArchived?: boolean;
  sort?: ProjectSort;
  /** At most 200, whatever is asked. */
  limit?: number;
}

export interface ProjectItem {
  id: string;
  name: string;
  status: string;
  statusLabel: string;
  /** Null for an internal project, with no person. */
  contactId: string | null;
  contactName: string | null;
  dealId: string | null;
  dealTitle: string | null;
  startAt: string | null;
  targetAt: string | null;
  archived: boolean;
  /** Custom field values by key; the owner's or the AI's own, so trusted. */
  fields: Record<string, unknown>;
  /** Tasks not done yet, snoozed ones included. */
  openTasks: number;
  /** Which of this item's values came from outside. Never instructions. */
  untrusted_fields: ("name" | "contactName" | "dealTitle")[];
}

export interface ProjectList {
  items: ProjectItem[];
  /** How many match, before the limit. */
  total: number;
  /** Every live status, so the answer says what a status filter may be. */
  statuses: { key: string; label: string; kind: "open" | "closed" }[];
}

export interface ProjectTime {
  minutes: number;
  billableMinutes: number;
  nonBillableMinutes: number;
  amountCents: number;
  running: boolean;
}

export type ProjectDetail = Omit<ProjectItem, "openTasks"> & {
  notes: string | null;
  /** The project's open tasks, shaped like list_tasks items. */
  openTasks: TaskItem[];
  /** Latest 20 by when they were done. */
  doneTasks: TaskItem[];
  /** The latest 20 notes and calls logged on the project, newest first. */
  timeline: TimelineItem[];
  /** Finished, unarchived entries, all time; null while time tracking is off. */
  time: ProjectTime | null;
  /** How many tasks are open (the list is capped). */
  openTaskCount: number;
};

type ProjectJoin = {
  id: string;
  name: string;
  untrusted_fields: string;
  status_key: string;
  contact_id: string | null;
  contact_name: string | null;
  contact_untrusted: string | null;
  deal_id: string | null;
  deal_title: string | null;
  deal_untrusted: string | null;
  start_at: string | null;
  target_at: string | null;
  notes: string | null;
  fields: string;
  archived: number;
  open_tasks: number;
  total: number;
};

const ORDER: Record<ProjectSort, string> = {
  target: "p.target_at IS NULL, p.target_at, p.name COLLATE NOCASE, p.id",
  name: "p.name COLLATE NOCASE, p.id",
  newest: "p.created_at DESC, p.id DESC",
};

async function selectProjects(db: Db, clauses: string[], params: unknown[], order: string, limit: number): Promise<ProjectJoin[]> {
  const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
  return (
    await db
      .prepare(
        `SELECT p.*, c.name AS contact_name, c.untrusted_fields AS contact_untrusted, d.title AS deal_title,
           d.untrusted_fields AS deal_untrusted,
           (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.done_at IS NULL) AS open_tasks,
           COUNT(*) OVER () AS total
         FROM projects p LEFT JOIN contacts c ON c.id = p.contact_id LEFT JOIN deals d ON d.id = p.deal_id
         ${where} ORDER BY ${order} LIMIT ?`,
      )
      .bind(...params, limit)
      .all<ProjectJoin>()
  ).results;
}

function toItem(row: ProjectJoin, labels: Map<string, string>): ProjectItem {
  const outside = (json: string | null, column: string) => untrustedFields({ untrusted_fields: json }).has(column);
  return {
    id: row.id,
    name: row.name,
    status: row.status_key,
    statusLabel: labels.get(row.status_key) ?? row.status_key,
    contactId: row.contact_id,
    contactName: row.contact_name,
    dealId: row.deal_id,
    dealTitle: row.deal_title,
    startAt: row.start_at,
    targetAt: row.target_at,
    archived: row.archived === 1,
    fields: parseObject(row.fields),
    openTasks: row.open_tasks,
    untrusted_fields: [
      ...(outside(row.untrusted_fields, "name") ? (["name"] as const) : []),
      ...(row.contact_name !== null && outside(row.contact_untrusted, "name") ? (["contactName"] as const) : []),
      ...(row.deal_title !== null && outside(row.deal_untrusted, "title") ? (["dealTitle"] as const) : []),
    ],
  };
}

/** Projects with their open-task counts: every status, unarchived only, soonest target first (none last), at most 200. */
export async function listProjects(db: Db, options: ProjectListOptions = {}): Promise<ProjectList> {
  await requireProjects(db);
  const statuses = await projectStatusRows(db);
  const every = await projectStatusRows(db, { includeArchived: true });
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.includeArchived !== true) clauses.push("p.archived = 0");
  if (options.status !== undefined) {
    const text = options.status.trim();
    const lower = text.toLowerCase();
    const found = every.find((s) => s.key === text) ?? every.find((s) => s.label.toLowerCase() === lower);
    if (found) {
      clauses.push("p.status_key = ?");
      params.push(found.key);
    } else if (lower === "open" || lower === "closed") {
      const keys = statuses.filter((s) => s.kind === lower).map((s) => s.key);
      clauses.push(`p.status_key IN (${keys.map(() => "?").join(", ")})`);
      params.push(...keys);
    } else {
      throw new UserError(`There is no status "${text}". Statuses: ${statuses.map((s) => s.label).join(", ")}. Use one of those.`);
    }
  }
  if (options.contact !== undefined) {
    clauses.push("p.contact_id = ?");
    params.push((await findContact(db, options.contact)).id);
  }
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? PROJECT_LIST_LIMIT), 1), PROJECT_LIST_LIMIT);
  const found = await selectProjects(db, clauses, params, ORDER[options.sort ?? "target"], limit);
  const labels = new Map(every.map((s) => [s.key, s.label]));
  return {
    items: found.map((row) => toItem(row, labels)),
    total: found[0]?.total ?? 0,
    statuses: statuses.map((s) => ({ key: s.key, label: s.label, kind: s.kind })),
  };
}

/** Finished entries of the project that are not archived: minutes, the billable split and the stored-rate amount. */
async function projectTime(db: Db, projectId: string): Promise<ProjectTime> {
  const entries = (
    await db
      .prepare("SELECT minutes, billable, rate, ended_at FROM time_entries WHERE project_id = ? AND archived = 0")
      .bind(projectId)
      .all<Pick<TimeEntryRow, "minutes" | "billable" | "rate" | "ended_at">>()
  ).results;
  const time: ProjectTime = { minutes: 0, billableMinutes: 0, nonBillableMinutes: 0, amountCents: 0, running: false };
  for (const entry of entries) {
    if (entry.ended_at === null || entry.minutes === null) {
      time.running = true;
      continue;
    }
    time.minutes += entry.minutes;
    if (entry.billable === 1) {
      time.billableMinutes += entry.minutes;
      time.amountCents += Math.round(amountOf(entry.rate, entry.minutes) * 100);
    } else {
      time.nonBillableMinutes += entry.minutes;
    }
  }
  return time;
}

/** One project (id or exact name): its notes, open tasks, the 20 latest done tasks and notes, and its time. */
export async function getProject(db: Db, ref: string, _now: Date): Promise<ProjectDetail> {
  const project = await findProject(db, ref);
  const [row] = await selectProjects(db, ["p.id = ?"], [project.id], ORDER.target, 1);
  if (!row) throw new Error(`Project ${project.id} points at a missing person.`);
  const settings = await settingsRow(db);
  const labels = await projectStatusLabels(db);
  const tz = settings.timezone;
  const { openTasks: openTaskCount, ...item } = toItem(row, labels);
  return {
    ...item,
    notes: row.notes,
    openTaskCount,
    openTasks: await projectTaskItems(db, project.id, "open", tz, OPEN_TASK_LIMIT),
    doneTasks: await projectTaskItems(db, project.id, "done", tz, SECTION_LIMIT),
    timeline: await projectTimeline(db, project.id, tz, SECTION_LIMIT),
    time: settings.time_tracking === 1 ? await projectTime(db, project.id) : null,
  };
}
