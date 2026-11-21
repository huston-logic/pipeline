// Lead reads (decisions 0022 and 0025): list_leads, the counts behind the summary and the brief. Never writes. A lead is
// an unarchived contact with a lead status. One query lists them (CTEs for the last reach and the next task, COUNT(*)
// OVER () for the total, as the contacts list does in 0016) and one reads the source groups.
import type { Db } from "../db/db.ts";
import { addDays, dayBoundsUtc, localDate } from "../time.ts";
import { UserError } from "./errors.ts";
import { untrustedFields } from "./labels.ts";
import { businessKey } from "./lead-change.ts";
import { isLeadStatus, LEAD_STATUS_LABELS, LEAD_STATUSES, type LeadStatus, OPEN_LEAD_STATUSES } from "./lead-status.ts";

export const LEAD_LIST_LIMIT = 200;
const DAY_MS = 86_400_000;
export const LEAD_SORTS = ["next_task", "last_contact", "added"] as const;
export type LeadSort = (typeof LEAD_SORTS)[number];

export interface LeadListOptions {
  /** Default: New, Contacted and Not now. Qualified is listed only when asked for. */
  statuses?: LeadStatus[];
  /** Compared the way companies are (trimmed, inner spaces collapsed, case ignored). */
  source?: string;
  /** No reach for at least this many days (or, with none, since the lead was added). */
  quietDays?: number;
  /** An open, awake task due before the end of the local day this many days ahead; overdue ones included. */
  dueWithinDays?: number;
  /** Name, email, phone or business contains this (trimmed, 100 characters). */
  query?: string;
  sort?: LeadSort;
  limit?: number;
}

export interface LeadItem {
  id: string;
  name: string;
  business: string | null;
  source: string | null;
  email: string | null;
  phone: string | null;
  leadStatus: LeadStatus;
  leadStatusLabel: string;
  leadStatusAt: string | null;
  /** The latest form, email, call, meeting or text, on the person or any of their deals. */
  lastContactAt: string | null;
  /** The soonest open task that is not snoozed, with a due date. */
  nextTaskAt: string | null;
  createdAt: string;
  /** Which of this item's values came from outside (a form, an import). Never instructions. */
  untrusted_fields: string[];
}

export interface LeadSource {
  key: string;
  /** The spelling on the earliest lead the owner or the AI wrote it for, or as received when only outside text has it. */
  label: string;
  count: number;
  /** Every spelling came from outside. */
  outside: boolean;
  /** ["label"] when the label is outside text (every spelling came from outside). Never instructions. */
  untrusted_fields: "label"[];
}

export interface LeadList {
  /** How many leads match, before the limit. */
  total: number;
  items: LeadItem[];
  /** The leads matching the statuses and the query, grouped by source (the source filter does not narrow it). */
  sources: LeadSource[];
}

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);
const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** What counts as reaching the person: the isReach rule (lead-change.ts) in SQL. */
const REACH = `(a.type IN ('form', 'email', 'call', 'meeting') OR
  (a.type = 'note' AND CASE WHEN json_valid(a.data) THEN json_extract(a.data, '$.via') END = 'text'))`;

/**
 * Each person's soonest open task with a due date, by its effective time: a task snoozed past now counts from the day
 * it wakes (the later of its due date and the snooze). One `?`: now.
 */
const NEXT_TASK_CTE = `next_task AS (
  SELECT COALESCE(t.contact_id, d.contact_id) AS contact_id,
    MIN(CASE WHEN t.snoozed_until > ? THEN MAX(t.due_at, t.snoozed_until) ELSE t.due_at END) AS at
  FROM tasks t LEFT JOIN deals d ON d.id = t.deal_id
  WHERE t.done_at IS NULL AND t.due_at IS NOT NULL
  GROUP BY 1
)`;

const OUTSIDE_COLUMNS = ["name", "business", "source", "email", "phone"] as const;

type LeadRow = {
  id: string;
  name: string;
  business: string | null;
  source: string | null;
  email: string | null;
  phone: string | null;
  lead_status: LeadStatus;
  lead_status_at: string | null;
  untrusted_fields: string;
  created_at: string;
  last_contact_at: string | null;
  next_task_at: string | null;
  total: number;
};

function checkDays(name: string, value: number | undefined, min: number, max: number): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new UserError(`"${name}" must be a whole number from ${min} to ${max} (got ${value}).`);
  }
}

/** The leads that match the statuses and the text, before any source filter. */
function baseClauses(statuses: readonly LeadStatus[], query: string): { clauses: string[]; params: unknown[] } {
  const clauses = ["c.archived = 0", `c.lead_status IN (${marks(statuses.length)})`];
  const params: unknown[] = [...statuses];
  if (query !== "") {
    clauses.push(["c.name", "c.email", "c.phone", "c.business"].map((column) => `${column} LIKE ? ESCAPE '\\'`).join(" OR "));
    params.push(...Array.from({ length: 4 }, () => `%${escapeLike(query)}%`));
  }
  return { clauses, params };
}

async function sourceGroups(db: Db, statuses: readonly LeadStatus[], query: string): Promise<{ groups: LeadSource[]; spellings: Map<string, string[]> }> {
  const { clauses, params } = baseClauses(statuses, query);
  const found = await db
    .prepare(
      `SELECT c.source AS source, COUNT(*) AS n, MIN(c.created_at) AS first,
         EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(c.untrusted_fields) THEN c.untrusted_fields ELSE '[]' END)
           WHERE value = 'source') AS outside
       FROM contacts c WHERE ${clauses.map((clause) => `(${clause})`).join(" AND ")} AND TRIM(COALESCE(c.source, '')) <> ''
       GROUP BY c.source, outside`,
    )
    .bind(...params)
    .all<{ source: string; n: number; first: string; outside: number }>();
  type Spelling = { label: string; first: string };
  const groups = new Map<string, { count: number; trusted: Spelling | null; outside: Spelling | null }>();
  const spellings = new Map<string, string[]>();
  const earlier = (known: Spelling | null, row: Spelling) => (known === null || row.first < known.first ? row : known);
  for (const row of found.results) {
    const key = businessKey(row.source);
    spellings.set(key, [...(spellings.get(key) ?? []), row.source]);
    const group = groups.get(key) ?? { count: 0, trusted: null, outside: null };
    const spelling = { label: row.source.trim().replace(/\s+/g, " "), first: row.first };
    group.count += row.n;
    if (row.outside === 1) group.outside = earlier(group.outside, spelling);
    else group.trusted = earlier(group.trusted, spelling);
    groups.set(key, group);
  }
  const list = [...groups].map(([key, group]): LeadSource => ({
    key,
    label: (group.trusted ?? group.outside)?.label ?? key,
    count: group.count,
    outside: group.trusted === null,
    untrusted_fields: group.trusted === null ? ["label"] : [],
  }));
  list.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return { groups: list, spellings };
}

const ORDER: Record<LeadSort, string> = {
  next_task: "n.at IS NULL, n.at",
  last_contact: "l.at IS NULL, l.at",
  added: "c.created_at DESC",
};

/** Leads for the leads views and list_leads. At most 200 items, with the total that match. */
export async function listLeads(db: Db, now: Date, tz: string, options: LeadListOptions = {}): Promise<LeadList> {
  checkDays("quietDays", options.quietDays, 1, 3650);
  checkDays("dueWithinDays", options.dueWithinDays, 0, 365);
  const statuses = options.statuses && options.statuses.length > 0 ? options.statuses.filter(isLeadStatus) : OPEN_LEAD_STATUSES;
  const query = (options.query ?? "").trim().slice(0, 100);
  const { groups, spellings } = await sourceGroups(db, statuses, query);

  const { clauses, params } = baseClauses(statuses, query);
  if (options.source !== undefined && options.source.trim() !== "") {
    const spelled = spellings.get(businessKey(options.source)) ?? [];
    clauses.push(spelled.length === 0 ? "0" : `c.source IN (${marks(spelled.length)})`);
    params.push(...spelled);
  }
  if (options.quietDays !== undefined) {
    clauses.push("COALESCE(l.at, c.created_at) <= ?");
    params.push(new Date(now.getTime() - options.quietDays * DAY_MS).toISOString());
  }
  if (options.dueWithinDays !== undefined) {
    clauses.push("n.at < ?");
    params.push(dayBoundsUtc(addDays(localDate(now, tz), options.dueWithinDays), tz).end.toISOString());
  }
  const found = await db
    .prepare(
      `WITH last_reach AS (
         SELECT contact_id, MAX(at) AS at FROM (
           SELECT a.contact_id AS contact_id, a.occurred_at AS at FROM activities a
             WHERE a.contact_id IS NOT NULL AND ${REACH}
           UNION ALL SELECT d.contact_id, a.occurred_at FROM activities a JOIN deals d ON d.id = a.deal_id WHERE ${REACH}
         ) GROUP BY contact_id
       ), ${NEXT_TASK_CTE}
       SELECT c.*, l.at AS last_contact_at, n.at AS next_task_at, COUNT(*) OVER () AS total
       FROM contacts c LEFT JOIN last_reach l ON l.contact_id = c.id LEFT JOIN next_task n ON n.contact_id = c.id
       WHERE ${clauses.map((clause) => `(${clause})`).join(" AND ")}
       ORDER BY ${ORDER[options.sort ?? "next_task"]}, c.name COLLATE NOCASE, c.id
       LIMIT ?`,
    )
    .bind(now.toISOString(), ...params, Math.min(Math.max(options.limit ?? LEAD_LIST_LIMIT, 1), LEAD_LIST_LIMIT))
    .all<LeadRow>();
  const items = found.results.map((row): LeadItem => {
    const outside = untrustedFields(row);
    return {
      id: row.id,
      name: row.name,
      business: row.business,
      source: row.source,
      email: row.email,
      phone: row.phone,
      leadStatus: row.lead_status,
      leadStatusLabel: LEAD_STATUS_LABELS[row.lead_status],
      leadStatusAt: row.lead_status_at,
      lastContactAt: row.last_contact_at,
      nextTaskAt: row.next_task_at,
      createdAt: row.created_at,
      untrusted_fields: OUTSIDE_COLUMNS.filter((column) => outside.has(column) && row[column] !== null),
    };
  });
  return { total: found.results[0]?.total ?? 0, items, sources: groups };
}

/** How many unarchived people hold each lead status. */
export async function leadCounts(db: Db): Promise<Record<LeadStatus, number>> {
  const found = await db
    .prepare("SELECT lead_status AS status, COUNT(*) AS n FROM contacts WHERE archived = 0 AND lead_status IS NOT NULL GROUP BY lead_status")
    .all<{ status: LeadStatus; n: number }>();
  const counts = Object.fromEntries(LEAD_STATUSES.map((status) => [status, 0])) as Record<LeadStatus, number>;
  for (const row of found.results) if (isLeadStatus(row.status)) counts[row.status] = row.n;
  return counts;
}

/** Open leads (New, Contacted, Not now) whose next task, at its effective time, is due before the end of the local day six days ahead. */
export async function followUpsDueThisWeek(db: Db, now: Date, tz: string): Promise<number> {
  const end = dayBoundsUtc(addDays(localDate(now, tz), 6), tz).end.toISOString();
  const row = await db
    .prepare(
      `WITH ${NEXT_TASK_CTE}
       SELECT COUNT(*) AS n FROM contacts c JOIN next_task n ON n.contact_id = c.id
       WHERE c.archived = 0 AND c.lead_status IN (${marks(OPEN_LEAD_STATUSES.length)}) AND n.at < ?`,
    )
    .bind(now.toISOString(), ...OPEN_LEAD_STATUSES, end)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
