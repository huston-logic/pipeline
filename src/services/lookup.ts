// Finding the records a request names. Contacts and deals accept an id or an exact name (ignoring case); a name
// that matches more than one record is refused with every match's id, so the caller can pick.
// The reads by id a record service makes take a Source: a database, or a ctx that may carry a plan (decision 0044).
// In collect mode a row the plan already has is read from the plan, so each action sees what the earlier ones planned.
import type { ContactRow, Db, DealRow, StageKind, StageRow, TaskRow } from "../db/db.ts";
import { findContactByEmail, getSettings, listStages } from "../db/queries.ts";
import type { ChangeTable, Row } from "./change.ts";
import { UserError } from "./errors.ts";
import { contactName, contactRef, dealTitle, isTrusted } from "./labels.ts";
import type { PlanCollector } from "./plan.ts";

export type FieldValue = string | number | boolean | null;
export type FieldValues = Record<string, FieldValue>;

/** Where a service reads records: the database, or a ctx whose plan (when set) is read first. */
export type Source = Db | { db: Db; plan?: PlanCollector | undefined };

export function sourceOf(src: Source): { db: Db; plan: PlanCollector | undefined } {
  return "prepare" in src ? { db: src, plan: undefined } : { db: src.db, plan: src.plan };
}

async function rowById<T>(src: Source, table: "contacts" | "deals" | "tasks", id: string): Promise<T | null> {
  const { db, plan } = sourceOf(src);
  const planned = plan?.row(table, id);
  if (planned !== undefined) return planned as unknown as T | null;
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first<T>();
}

export const contactById = (src: Source, id: string) => rowById<ContactRow>(src, "contacts", id);
export const dealById = (src: Source, id: string) => rowById<DealRow>(src, "deals", id);
export const taskById = (src: Source, id: string) => rowById<TaskRow>(src, "tasks", id);

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

/** The contact using this email (ignoring case, archived ones too), as the plan leaves them. */
export async function contactByEmail(src: Source, email: string): Promise<ContactRow | null> {
  const { db } = sourceOf(src);
  const found = await findContactByEmail(db, email);
  const wanted = email.trim().toLowerCase();
  const uses = (row: Row) => typeof row.email === "string" && row.email.toLowerCase() === wanted;
  return withPlanned(src, "contacts", found === null ? [] : [found], uses)[0] ?? null;
}

export async function ownerTimezone(db: Db): Promise<string> {
  return (await getSettings(db)).timezone;
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
export async function findStage(db: Db, ref: string): Promise<StageRow> {
  const text = ref.trim();
  const stages = await listStages(db);
  const match =
    stages.find((s) => s.key === text) ?? stages.find((s) => s.label.toLowerCase() === text.toLowerCase());
  if (match) return match;
  const list = stages.map((s) => `${s.label} (${s.key})`).join(", ");
  throw new UserError(`There's no stage "${text}". Stages: ${list}. Use one of those.`);
}

/** The lowest-positioned stage of this kind that is not archived. */
export async function firstStageOfKind(db: Db, kind: StageKind): Promise<StageRow | null> {
  return (await listStages(db)).find((s) => s.kind === kind) ?? null;
}

/** Every stage's label by key, archived ones included (old changes and activities name them). */
export async function stageLabels(db: Db): Promise<Map<string, string>> {
  return new Map((await listStages(db, { includeArchived: true })).map((s) => [s.key, s.label]));
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

/** What an activity or task is about: a deal (and so its contact), or a contact alone. */
export async function findSubject(
  src: Source,
  refs: { dealId?: string | undefined; contactId?: string | undefined },
): Promise<{ deal: DealRow | null; contact: ContactRow }> {
  const deal = refs.dealId === undefined ? null : await findDeal(src, refs.dealId);
  const named = refs.contactId === undefined ? null : await findContact(src, refs.contactId);
  if (!deal) {
    if (!named) throw new UserError("This needs a deal or a contact: give a dealId or a contactId.");
    return { deal: null, contact: named };
  }
  const owner = await contactById(src, deal.contact_id);
  if (!owner) throw new Error(`Deal ${deal.id} points at a missing contact.`);
  if (named && named.id !== owner.id) {
    throw new UserError(
      `${dealTitle(deal)} belongs to ${contactName(owner)}, not ${contactName(named)}. ` +
        "Give just the deal, or the deal's own contact.",
    );
  }
  return { deal, contact: owner };
}
