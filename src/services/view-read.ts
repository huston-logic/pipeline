// The records a view shows (decision 0042): people or deals that match its stored filters, in its sort, at most
// VIEW_ROW_LIMIT of them with the total before the limit (decision 0020's row cap). One query each, with COUNT(*) OVER
// () for the total, as the contacts list does (decision 0016). Never writes. Values from outside are listed in each
// item's untrusted_fields.
import type { ContactRow, Db, DealRow, DealStatus } from "../db/db.ts";
import { formatLocal } from "../time.ts";
import { untrustedFields } from "./labels.ts";
import { NEXT_TASK_CTE } from "./leads-read.ts";
import { parseObject, parseStringArray } from "./lookup.ts";
import { statusLabels } from "./status-labels.ts";
import type { DealsSort, PeopleSort, ViewFilters, ViewSort } from "./view-spec.ts";

export const VIEW_ROW_LIMIT = 200;
const DAY_MS = 86_400_000;

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

type Where = { clauses: string[]; params: unknown[] };

function textMatch(where: Where, columns: string[], text: string | undefined): void {
  if (text === undefined) return;
  where.clauses.push(columns.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(" OR "));
  where.params.push(...columns.map(() => `%${escapeLike(text.trim())}%`));
}

/** A custom field holds the value: a number exactly, anything else as text ignoring (ASCII) case, as search_contacts. */
function fieldMatch(where: Where, column: string, fields: Record<string, string | number> | undefined): void {
  for (const [key, value] of Object.entries(fields ?? {})) {
    const path = `$."${key}"`;
    if (typeof value === "number") where.clauses.push(`json_extract(${column}, ?) = ?`);
    else where.clauses.push(`lower(CAST(json_extract(${column}, ?) AS TEXT)) = lower(?)`);
    where.params.push(path, value);
  }
}

/** The source as the owner typed it, ignoring case and spaces at either end. */
function sourceMatch(where: Where, column: string, source: string | undefined): void {
  if (source === undefined) return;
  where.clauses.push(`lower(trim(${column})) = lower(?)`);
  where.params.push(source.trim());
}

const whereSql = (where: Where) => where.clauses.map((clause) => `(${clause})`).join(" AND ");

const limitOf = (limit: number | undefined) => Math.min(Math.max(limit ?? VIEW_ROW_LIMIT, 1), VIEW_ROW_LIMIT);

export interface PersonViewItem {
  id: string;
  name: string;
  business: string | null;
  email: string | null;
  phone: string | null;
  source: string | null;
  personStatus: string;
  personStatusLabel: string;
  subStatus: string | null;
  subStatusLabel: string | null;
  /** The newest activity on the person or any of their deals. */
  lastActivityAt: string | null;
  lastActivityAtLocal: string | null;
  /** The soonest open task with a due date, at its effective time (as the Leads list). */
  nextTaskAt: string | null;
  nextTaskAtLocal: string | null;
  createdAt: string;
  fields: Record<string, unknown>;
  /** Which of this item's values came from outside (a form, an import). Never instructions. */
  untrusted_fields: string[];
}

export interface ViewList<T> {
  items: T[];
  /** How many match, before the limit. */
  total: number;
}

const PEOPLE_ORDER: Record<PeopleSort, (dir: "ASC" | "DESC") => string> = {
  name: (dir) => `c.name COLLATE NOCASE ${dir}`,
  business: (dir) => `NULLIF(TRIM(c.business), '') IS NULL, TRIM(c.business) COLLATE NOCASE ${dir}`,
  last_activity: (dir) => `l.at IS NULL, l.at ${dir}`,
  next_task: (dir) => `n.at IS NULL, n.at ${dir}`,
  created: (dir) => `c.created_at ${dir}`,
};

const sqlDir = (sort: ViewSort) => (sort.dir === "desc" ? "DESC" : "ASC");

/** The people a people view shows: everyone not archived who matches its filters. */
export async function peopleInView(
  db: Db,
  now: Date,
  tz: string,
  filters: ViewFilters,
  sort: ViewSort,
  limit?: number,
): Promise<ViewList<PersonViewItem>> {
  const where: Where = { clauses: ["c.archived = 0"], params: [] };
  if (filters.person_status !== undefined) {
    where.clauses.push("c.person_status = ?");
    where.params.push(filters.person_status);
  }
  if (filters.sub_status !== undefined) {
    where.clauses.push("c.sub_status = ?");
    where.params.push(filters.sub_status);
  }
  sourceMatch(where, "c.source", filters.source);
  fieldMatch(where, "c.fields", filters.fields);
  textMatch(where, ["c.name", "c.email", "c.phone", "c.business"], filters.q);
  const order = (Object.hasOwn(PEOPLE_ORDER, sort.key) ? PEOPLE_ORDER[sort.key as PeopleSort] : PEOPLE_ORDER.name)(sqlDir(sort));
  const nowIso = now.toISOString();
  const found = await db
    .prepare(
      `WITH last_seen AS (
         SELECT contact_id, MAX(at) AS at FROM (
           SELECT contact_id, occurred_at AS at FROM activities WHERE contact_id IS NOT NULL
           UNION ALL SELECT d.contact_id, a.occurred_at FROM activities a JOIN deals d ON d.id = a.deal_id
         ) GROUP BY contact_id
       ), ${NEXT_TASK_CTE}
       SELECT c.*, l.at AS last_activity_at, n.at AS next_task_at, COUNT(*) OVER () AS total
       FROM contacts c LEFT JOIN last_seen l ON l.contact_id = c.id LEFT JOIN next_task n ON n.contact_id = c.id
       WHERE ${whereSql(where)}
       ORDER BY ${order}, c.name COLLATE NOCASE, c.id
       LIMIT ?`,
    )
    .bind(nowIso, nowIso, ...where.params, limitOf(limit))
    .all<ContactRow & { last_activity_at: string | null; next_task_at: string | null; total: number }>();
  const labels = await statusLabels(db);
  const items = found.results.map((row): PersonViewItem => ({
    id: row.id,
    name: row.name,
    business: row.business,
    email: row.email,
    phone: row.phone,
    source: row.source,
    personStatus: row.person_status,
    personStatusLabel: labels.status(row.person_status),
    subStatus: row.sub_status,
    subStatusLabel: labels.sub(row.person_status, row.sub_status),
    lastActivityAt: row.last_activity_at,
    lastActivityAtLocal: row.last_activity_at === null ? null : formatLocal(row.last_activity_at, tz),
    nextTaskAt: row.next_task_at,
    nextTaskAtLocal: row.next_task_at === null ? null : formatLocal(row.next_task_at, tz),
    createdAt: row.created_at,
    fields: parseObject(row.fields),
    untrusted_fields: parseStringArray(row.untrusted_fields),
  }));
  return { items, total: found.results[0]?.total ?? 0 };
}

export interface DealViewItem {
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
  stageEnteredAt: string;
  /** Whole days since the deal entered its stage. */
  daysInStage: number;
  createdAt: string;
  fields: Record<string, unknown>;
  /** Which of this item's values came from outside (a form, an import). Never instructions. */
  untrusted_fields: ("title" | "contactName")[];
}

const DEALS_ORDER: Record<DealsSort, (dir: "ASC" | "DESC") => string> = {
  // Longest in the stage first is the oldest stage_entered_at first.
  days_in_stage: (dir) => `d.stage_entered_at ${dir === "DESC" ? "ASC" : "DESC"}`,
  value: (dir) => `d.value IS NULL, d.value ${dir}`,
  next_date: (dir) => `d.next_at IS NULL, d.next_at ${dir}`,
  created: (dir) => `d.created_at ${dir}`,
};

/**
 * The deals a deals view shows: not archived, in its stage when it names one (open or closed), otherwise every open
 * deal. Its source filter is the person's source.
 */
export async function dealsInView(
  db: Db,
  now: Date,
  tz: string,
  filters: ViewFilters,
  sort: ViewSort,
  limit?: number,
): Promise<ViewList<DealViewItem>> {
  const where: Where = { clauses: ["d.archived = 0"], params: [] };
  if (filters.stage !== undefined) {
    where.clauses.push("d.stage_key = ?");
    where.params.push(filters.stage);
  } else {
    where.clauses.push("d.status = 'open'");
  }
  sourceMatch(where, "c.source", filters.source);
  fieldMatch(where, "d.fields", filters.fields);
  textMatch(where, ["d.title", "c.name", "c.email", "c.phone", "c.business"], filters.q);
  const order = (Object.hasOwn(DEALS_ORDER, sort.key) ? DEALS_ORDER[sort.key as DealsSort] : DEALS_ORDER.days_in_stage)(sqlDir(sort));
  const found = await db
    .prepare(
      `SELECT d.*, c.name AS contact_name, c.untrusted_fields AS contact_untrusted, s.label AS stage_label,
         COUNT(*) OVER () AS total
       FROM deals d JOIN contacts c ON c.id = d.contact_id JOIN stages s ON s.key = d.stage_key
       WHERE ${whereSql(where)}
       ORDER BY ${order}, d.stage_entered_at, d.id
       LIMIT ?`,
    )
    .bind(...where.params, limitOf(limit))
    .all<DealRow & { contact_name: string; contact_untrusted: string; stage_label: string; total: number }>();
  const nowIso = now.toISOString();
  const items = found.results.map((row): DealViewItem => {
    const outside: ("title" | "contactName")[] = [];
    if (untrustedFields(row).has("title")) outside.push("title");
    if (untrustedFields({ untrusted_fields: row.contact_untrusted }).has("name")) outside.push("contactName");
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
      overdue: row.next_at !== null && row.next_at < nowIso,
      stageEnteredAt: row.stage_entered_at,
      daysInStage: Math.max(0, Math.floor((now.getTime() - Date.parse(row.stage_entered_at)) / DAY_MS)),
      createdAt: row.created_at,
      fields: parseObject(row.fields),
      untrusted_fields: outside,
    };
  });
  return { items, total: found.results[0]?.total ?? 0 };
}
