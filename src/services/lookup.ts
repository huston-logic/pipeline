// Finding the records a request names. Contacts and deals accept an id or an exact name (ignoring case); a name
// that matches more than one record is refused with every match's id, so the caller can pick.
// The reads by id a record service makes take a Source: a database, or a ctx that may carry a plan (decision 0044).
// In collect mode a row the plan already has is read from the plan, so each action sees what the earlier ones planned.
import type { ContactRow, Db, DealRow, ProjectRow, StageKind, StageRow, TaskRow, TimeEntryRow, WorkTypeRow } from "../db/db.ts";
import { findContactByEmail } from "../db/queries.ts";
import type { ChangeTable, Row } from "./change.ts";
import { UserError } from "./errors.ts";
import { contactName, contactRef, dealTitle, isTrusted } from "./labels.ts";
import { memoWorkType, type Reader, type ReadMemo, settingsRow, stageRows } from "./memo.ts";
import type { PlanCollector } from "./plan.ts";

export type FieldValue = string | number | boolean | null;
export type FieldValues = Record<string, FieldValue>;

/**
 * Where a service reads records: the database, or a ctx whose plan (when set) is read first. Its memo (memo.ts), when
 * set, answers the settings-like reads only, never a record row.
 */
export type Source = Db | { db: Db; plan?: PlanCollector | undefined; memo?: ReadMemo | undefined };

export function sourceOf(src: Source): { db: Db; plan: PlanCollector | undefined } {
  return "prepare" in src ? { db: src, plan: undefined } : { db: src.db, plan: src.plan };
}

type ById = "contacts" | "deals" | "tasks" | "time_entries" | "work_types" | "projects";

async function rowById<T>(src: Source, table: ById, id: string): Promise<T | null> {
  const { db, plan } = sourceOf(src);
  const planned = plan?.row(table, id);
  if (planned !== undefined) return planned as unknown as T | null;
  // Work types are configuration (a plan never writes them): the memo may hold them.
  const memoized = table === "work_types" ? await memoWorkType(src, id) : undefined;
  if (memoized !== undefined) return memoized as unknown as T | null;
  const read = () => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first<T>();
  if (plan === undefined) return read();
  return (await plan.readOnce(table, id, read as () => Promise<Row | null>)) as T | null;
}

export const contactById = (src: Source, id: string) => rowById<ContactRow>(src, "contacts", id);
export const dealById = (src: Source, id: string) => rowById<DealRow>(src, "deals", id);
export const taskById = (src: Source, id: string) => rowById<TaskRow>(src, "tasks", id);
export const timeEntryById = (src: Source, id: string) => rowById<TimeEntryRow>(src, "time_entries", id);
export const workTypeById = (src: Source, id: string) => rowById<WorkTypeRow>(src, "work_types", id);
export const projectById = (src: Source, id: string) => rowById<ProjectRow>(src, "projects", id);

/** A row the plan has (null: planned deleted), else the one read with it, if it is that row, else a read of its own. */
async function plannedOr<T extends { id: string }>(src: Source, table: ById, id: string, read: T | undefined): Promise<T | null> {
  const planned = sourceOf(src).plan?.row(table, id);
  if (planned !== undefined) return planned as unknown as T | null;
  return read?.id === id ? read : rowById<T>(src, table, id);
}

/**
 * A deal and its person by the deal's id, as the plan leaves them, or null when there's no such deal. In collect mode
 * (decision 0044, "D1 calls") a deal the plan doesn't have is read with its person in one D1 batch; otherwise one read
 * each, as dealById and contactById.
 */
export async function dealWithOwner(src: Source, id: string): Promise<{ deal: DealRow; contact: ContactRow | null } | null> {
  const { db, plan } = sourceOf(src);
  if (plan === undefined || plan.row("deals", id) !== undefined) {
    const deal = await dealById(src, id);
    return deal === null ? null : { deal, contact: await contactById(src, deal.contact_id) };
  }
  const [deals, contacts] = await db.batch([
    db.prepare("SELECT * FROM deals WHERE id = ?").bind(id),
    db.prepare("SELECT * FROM contacts WHERE id = (SELECT contact_id FROM deals WHERE id = ?)").bind(id),
  ]);
  const deal = deals?.results[0] as DealRow | undefined;
  if (deal === undefined) return null;
  return { deal, contact: await plannedOr(src, "contacts", deal.contact_id, contacts?.results[0] as ContactRow | undefined) };
}

/**
 * A task with its deal and its person (the task's own, else its deal's), as the plan leaves them, or null when there's
 * no such task. In collect mode a task the plan doesn't have is read with both in one D1 batch.
 */
export async function taskWithLinks(src: Source, id: string): Promise<{ task: TaskRow; deal: DealRow | null; contact: ContactRow | null } | null> {
  const { db, plan } = sourceOf(src);
  let read: { deal?: DealRow; contact?: ContactRow } = {};
  let task: TaskRow | null;
  if (plan === undefined || plan.row("tasks", id) !== undefined) {
    task = await taskById(src, id);
  } else {
    const [tasks, deals, contacts] = await db.batch([
      db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id),
      db.prepare("SELECT * FROM deals WHERE id = (SELECT deal_id FROM tasks WHERE id = ?)").bind(id),
      db
        .prepare("SELECT * FROM contacts WHERE id = (SELECT coalesce(t.contact_id, d.contact_id) FROM tasks t LEFT JOIN deals d ON d.id = t.deal_id WHERE t.id = ?)")
        .bind(id),
    ]);
    task = (tasks?.results[0] as TaskRow | undefined) ?? null;
    read = { deal: deals?.results[0] as DealRow | undefined, contact: contacts?.results[0] as ContactRow | undefined };
  }
  if (task === null) return null;
  const deal = task.deal_id === null ? null : await plannedOr(src, "deals", task.deal_id, read.deal);
  const contactId = task.contact_id ?? deal?.contact_id ?? null;
  return { task, deal, contact: contactId === null ? null : await plannedOr(src, "contacts", contactId, read.contact) };
}

/**
 * The rows a list read found in the database, as the plan leaves them: a planned row replaces its database row (and
 * drops out when it no longer matches), and planned rows that match now are added after them.
 */
export function withPlanned<T extends { id: string }>(src: Source, table: ChangeTable, found: readonly T[], match: (row: Row) => boolean): T[] {
  const { plan } = sourceOf(src);
  if (plan === undefined) return [...found];
  const out: T[] = [];
  const ids = new Set<string>();
  for (const row of found) {
    ids.add(row.id);
    const planned = plan.row(table, row.id);
    if (planned === undefined) out.push(row);
    else if (planned !== null && match(planned)) out.push(planned as unknown as T);
  }
  for (const planned of plan.rows(table, match)) if (!ids.has(String(planned.id))) out.push(planned as unknown as T);
  return out;
}

const isOpenDealOf = (contactId: string) => (row: Row) => row.contact_id === contactId && row.status === "open" && row.archived === 0;

/** A contact's open, unarchived deals, oldest first, as the plan leaves them. */
export async function openDealsOf(src: Source, contactId: string): Promise<DealRow[]> {
  const { db } = sourceOf(src);
  const found = await db
    .prepare("SELECT * FROM deals WHERE contact_id = ? AND status = 'open' AND archived = 0 ORDER BY created_at, id")
    .bind(contactId)
    .all<DealRow>();
  return withPlanned(src, "deals", found.results, isOpenDealOf(contactId));
}

const isOpenTaskOf = (dealId: string) => (row: Row) => row.deal_id === dealId && row.done_at === null;

/** A deal's tasks that are not done (snoozed ones too), oldest first, as the plan leaves them. */
export async function openTasksOfDeal(src: Source, dealId: string): Promise<TaskRow[]> {
  const { db } = sourceOf(src);
  const found = await db.prepare("SELECT * FROM tasks WHERE deal_id = ? AND done_at IS NULL ORDER BY created_at, id").bind(dealId).all<TaskRow>();
  return withPlanned(src, "tasks", found.results, isOpenTaskOf(dealId));
}

/** A project's tasks under one parent (null: top level) in order, as the plan leaves them: planned ones count too. */
export async function siblingTasks(src: Source, projectId: string, parentId: string | null): Promise<TaskRow[]> {
  const { db } = sourceOf(src);
  const found = await db
    .prepare("SELECT * FROM tasks WHERE project_id = ? AND parent_id IS ? ORDER BY position, created_at, id")
    .bind(projectId, parentId)
    .all<TaskRow>();
  const match = (row: Row) => row.project_id === projectId && (row.parent_id ?? null) === parentId;
  const all = withPlanned(src, "tasks", found.results, match);
  return all.sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id));
}

/** The position a new task takes: last among its siblings (same project, same parent), planned tasks counted, plus one. */
export async function nextPosition(src: Source, projectId: string, parentId: string | null): Promise<number> {
  const siblings = await siblingTasks(src, projectId, parentId);
  return siblings.reduce((most, task) => Math.max(most, task.position ?? 0), 0) + 1;
}

/** The contact using this email (ignoring case, archived ones too), as the plan leaves them. */
export async function contactByEmail(src: Source, email: string): Promise<ContactRow | null> {
  const { db } = sourceOf(src);
  const found = await findContactByEmail(db, email);
  const wanted = email.trim().toLowerCase();
  const uses = (row: Row) => typeof row.email === "string" && row.email.toLowerCase() === wanted;
  return withPlanned(src, "contacts", found === null ? [] : [found], uses)[0] ?? null;
}

export async function ownerTimezone(src: Reader): Promise<string> {
  return (await settingsRow(src)).timezone;
}

async function rows<T>(db: Db, sql: string, ...params: unknown[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...params).all<T>()).results;
}

function required(ref: string, what: string): string {
  const text = ref.trim();
  if (!text) throw new UserError(`Say which ${what}: give its id or its exact name.`);
  return text;
}

export async function findContact(src: Source, ref: string): Promise<ContactRow> {
  const { db } = sourceOf(src);
  const text = required(ref, "contact");
  const byId = await contactById(src, text);
  if (byId) return byId;
  const matches = await rows<ContactRow>(
    db,
    "SELECT * FROM contacts WHERE lower(name) = lower(?) AND archived = 0 ORDER BY created_at, id",
    text,
  );
  const [only, ...others] = matches;
  if (!only) throw new UserError(`No contact matches "${text}". Use search_contacts to find the contact's id.`);
  if (others.length === 0) return only;
  const list = matches.map(contactRef).join("; ");
  throw new UserError(`"${text}" matches more than one contact: ${list}. Use the contact id instead.`);
}

/** findDeal and the deal's person: by id in one D1 call in collect mode (dealWithOwner). */
export async function findDealWithOwner(src: Source, ref: string): Promise<{ deal: DealRow; contact: ContactRow }> {
  const pair = sourceOf(src).plan === undefined ? null : await dealWithOwner(src, ref.trim());
  const deal = pair?.deal ?? (await findDeal(src, ref));
  const contact = pair !== null ? pair.contact : await contactById(src, deal.contact_id);
  if (!contact) throw new Error(`Deal ${deal.id} points at a missing contact.`);
  return { deal, contact };
}

export async function findDeal(src: Source, ref: string): Promise<DealRow> {
  const { db } = sourceOf(src);
  const text = required(ref, "deal");
  const byId = await dealById(src, text);
  if (byId) return byId;
  let matches = await rows<DealRow>(
    db,
    "SELECT * FROM deals WHERE lower(title) = lower(?) AND archived = 0 ORDER BY created_at, id",
    text,
  );
  if (matches.length === 0) {
    matches = await rows<DealRow>(
      db,
      `SELECT d.* FROM deals d JOIN contacts c ON c.id = d.contact_id
       WHERE lower(c.name) = lower(?) AND d.archived = 0 ORDER BY d.created_at, d.id`,
      text,
    );
  }
  const [only, ...others] = matches;
  if (!only) {
    throw new UserError(`No deal matches "${text}". Use list_deals or search_contacts to find the deal's id.`);
  }
  if (others.length === 0) return only;
  const details = await rows<{
    id: string;
    title: string;
    untrusted_fields: string;
    contact_id: string;
    contact: string;
    contact_untrusted: string;
    stage: string;
  }>(
    db,
    `SELECT d.id, d.title, d.untrusted_fields, c.id AS contact_id, c.name AS contact,
       c.untrusted_fields AS contact_untrusted, s.label AS stage FROM deals d
     JOIN contacts c ON c.id = d.contact_id JOIN stages s ON s.key = d.stage_key
     WHERE d.id IN (${matches.map(() => "?").join(", ")}) ORDER BY d.created_at, d.id`,
    ...matches.map((d) => d.id),
  );
  const list = details
    .map((d) => {
      const who = contactName({ id: d.contact_id, name: d.contact, untrusted_fields: d.contact_untrusted });
      return isTrusted(d, "title") ? `${dealTitle(d)} (${d.id}, ${who}, ${d.stage})` : `${dealTitle(d)} (${who}, ${d.stage})`;
    })
    .join("; ");
  throw new UserError(`"${text}" matches ${matches.length} deals: ${list}. Use the deal id instead.`);
}

/** A stage that is not archived, by key or by label (ignoring case). */
export async function findStage(src: Reader, ref: string): Promise<StageRow> {
  const text = ref.trim();
  const stages = await stageRows(src);
  const match =
    stages.find((s) => s.key === text) ?? stages.find((s) => s.label.toLowerCase() === text.toLowerCase());
  if (match) return match;
  const list = stages.map((s) => `${s.label} (${s.key})`).join(", ");
  throw new UserError(`There's no stage "${text}". Stages: ${list}. Use one of those.`);
}

/** The lowest-positioned stage of this kind that is not archived. */
export async function firstStageOfKind(src: Reader, kind: StageKind): Promise<StageRow | null> {
  return (await stageRows(src)).find((s) => s.kind === kind) ?? null;
}

/** Every stage's label by key, archived ones included (old changes and activities name them). */
export async function stageLabels(src: Reader): Promise<Map<string, string>> {
  return new Map((await stageRows(src, { includeArchived: true })).map((s) => [s.key, s.label]));
}

export function parseObject(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function parseStringArray(json: string): string[] {
  const value: unknown = JSON.parse(json);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Merges a patch into stored custom field values; a null value removes the key. */
export function mergeFields(stored: string, patch: FieldValues): string {
  const merged = parseObject(stored);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return JSON.stringify(merged);
}

type SubjectRefs = { dealId?: string | undefined; contactId?: string | undefined };

/**
 * What an activity or task is about: a deal (and so its contact), or a contact alone. An activity needs one; with
 * `{ optional: true }` (a task, decision 0046) naming neither is a subject of nobody, but a name that matches no one is
 * still refused.
 */
export async function findSubject(src: Source, refs: SubjectRefs): Promise<{ deal: DealRow | null; contact: ContactRow }>;
export async function findSubject(
  src: Source,
  refs: SubjectRefs,
  options: { optional: true },
): Promise<{ deal: DealRow | null; contact: ContactRow | null }>;
export async function findSubject(
  src: Source,
  refs: SubjectRefs,
  options: { optional?: boolean } = {},
): Promise<{ deal: DealRow | null; contact: ContactRow | null }> {
  const pair = refs.dealId === undefined ? null : await findDealWithOwner(src, refs.dealId);
  // The deal's own person named by id is the one already read.
  const named =
    refs.contactId === undefined ? null : pair !== null && refs.contactId.trim() === pair.contact.id ? pair.contact : await findContact(src, refs.contactId);
  if (!pair) {
    if (!named && options.optional !== true) throw new UserError("This needs a deal or a contact: give a dealId or a contactId.");
    return { deal: null, contact: named };
  }
  const { deal, contact: owner } = pair;
  if (named && named.id !== owner.id) {
    throw new UserError(
      `${dealTitle(deal)} belongs to ${contactName(owner)}, not ${contactName(named)}. ` +
        "Give just the deal, or the deal's own contact.",
    );
  }
  return { deal, contact: owner };
}
