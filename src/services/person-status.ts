// Person statuses (decision 0040): what kind of person someone is (Lead, Contact, Partner, and any the owner adds),
// each with its own sub-status list, and the owner's move of a person between them. Shaped like stages.ts: a key is
// the slug of the first label and never changes, refs take a key or a label, positions are renumbered 1..n inside the
// change that moves one (live ones first, archived ones after), and every write is one audited change that undo
// reverses. Lead and Contact can be renamed but never archived; Lead's sub-statuses are today's lead status keys,
// which rules and reports use, so they can be renamed but not archived, and Lead gets no new ones.
import type { ContactRow, Db, PersonStatusRow, PersonSubstatusRow } from "../db/db.ts";
import { type ChangeResult, commitChange, type Ctx, type RowChange, StaleWriteError, updatedRow } from "./change.ts";
import { capitalize, joinAnd } from "./describe.ts";
import { UserError } from "./errors.ts";
import { clean } from "./input.ts";
import { contactName } from "./labels.ts";
import { noOpenDeal, openDealCount, withPersonStatus } from "./lead-change.ts";
import { findContact } from "./lookup.ts";
import { CONTACT, LEAD, type PersonMove, type StatusEntry, statusEntriesOf } from "./person-move.ts";
import { slugOf, uniqueKey } from "./slug.ts";

export { personStatusPatch } from "./person-move.ts";

const MAX_LABEL = 60;
const SHOWN_PEOPLE = 5;

export interface SubStatusView {
  key: string;
  label: string;
  position: number;
  archived: boolean;
}

export interface PersonStatusView {
  key: string;
  label: string;
  position: number;
  /** What the sub-status field is called for this status. */
  subLabel: string;
  /** Can be renamed and moved, never archived (Lead and Contact). */
  locked: boolean;
  archived: boolean;
  /** In position order, archived ones included. */
  subStatuses: SubStatusView[];
}

async function statusRows(db: Db): Promise<PersonStatusRow[]> {
  const found = await db.prepare("SELECT * FROM person_statuses ORDER BY archived, position, key").all<PersonStatusRow>();
  return found.results;
}

async function subRows(db: Db, statusKey?: string): Promise<PersonSubstatusRow[]> {
  const sql = "SELECT * FROM person_substatuses";
  const order = " ORDER BY status_key, archived, position, key";
  const found =
    statusKey === undefined
      ? await db.prepare(sql + order).all<PersonSubstatusRow>()
      : await db.prepare(`${sql} WHERE status_key = ?${order}`).bind(statusKey).all<PersonSubstatusRow>();
  return found.results;
}

/** Every status with its sub-statuses, live ones first in board order, archived ones after. */
export async function listPersonStatuses(db: Db): Promise<PersonStatusView[]> {
  const [statuses, subs] = await Promise.all([statusRows(db), subRows(db)]);
  return statuses.map((row) => ({
    key: row.key,
    label: row.label,
    position: row.position,
    subLabel: row.sub_label,
    locked: row.locked === 1,
    archived: row.archived === 1,
    subStatuses: subs
      .filter((s) => s.status_key === row.key)
      .map((s) => ({ key: s.key, label: s.label, position: s.position, archived: s.archived === 1 })),
  }));
}

export interface PersonStatusOverview extends Omit<PersonStatusView, "subStatuses"> {
  /** People (not archived) with this status. */
  people: number;
  subStatuses: (SubStatusView & { people: number })[];
}

/** list_person_statuses (decision 0041): the statuses in board order with how many people hold each; archived ones on request. */
export async function personStatusOverview(db: Db, includeArchived: boolean): Promise<PersonStatusOverview[]> {
  const [all, held] = await Promise.all([
    listPersonStatuses(db),
    db
      .prepare("SELECT person_status AS status, sub_status AS sub, COUNT(*) AS n FROM contacts WHERE archived = 0 GROUP BY 1, 2")
      .all<{ status: string; sub: string | null; n: number }>(),
  ]);
  const count = (status: string, sub?: string) =>
    held.results.filter((row) => row.status === status && (sub === undefined || row.sub === sub)).reduce((sum, row) => sum + row.n, 0);
  return all
    .filter((status) => includeArchived || !status.archived)
    .map((status) => ({
      ...status,
      people: count(status.key),
      subStatuses: status.subStatuses
        .filter((sub) => includeArchived || !sub.archived)
        .map((sub) => ({ ...sub, people: count(status.key, sub.key) })),
    }));
}

/** The statuses as the import plan takes them (src/import/modules/people.ts). */
export async function statusEntries(db: Db): Promise<readonly StatusEntry[]> {
  const [statuses, subs] = await Promise.all([statusRows(db), subRows(db)]);
  return statusEntriesOf(statuses, subs);
}

const sameLabel = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function cleanLabel(label: string | undefined, what: string, example: string): string {
  const text = clean(label);
  if (text === null) throw new UserError(`A ${what} needs a label. Say what to call it, for example "${example}".`);
  if (text.length > MAX_LABEL) throw new UserError(`A ${what} label can be at most ${MAX_LABEL} characters (got ${text.length}).`);
  return text;
}

type Labelled = { key: string; label: string; archived: number };

/** By key (archived ones too), else by label among the live ones, else by label among the archived ones. */
function pick<T extends Labelled>(rows: readonly T[], ref: string, what: string): T {
  const text = ref.trim();
  const live = rows.filter((row) => row.archived === 0);
  const match =
    rows.find((row) => row.key === text) ??
    live.find((row) => sameLabel(row.label, text)) ??
    rows.find((row) => row.archived === 1 && sameLabel(row.label, text));
  if (match) return match;
  const list = live.map((row) => `${row.label} (${row.key})`).join(", ");
  throw new UserError(list === "" ? `There's no ${what} "${text}". There are none yet.` : `There's no ${what} "${text}". Use one of: ${list}.`);
}

function refuseDuplicate(rows: readonly Labelled[], label: string, what: string, except?: string): void {
  const clash = rows.find((row) => row.archived === 0 && row.key !== except && sameLabel(row.label, label));
  if (clash) throw new UserError(`There's already a ${what} called ${clash.label} (${clash.key}). Pick a different label.`);
}

type Positioned = { position: number; archived: number; version: number; updated_at: string };

/** Row changes giving `ordered` positions 1..n with any edits; rows already as wanted are left alone. */
function renumber<T extends Positioned>(
  ordered: readonly T[],
  table: "person_statuses" | "person_substatuses",
  idOf: (row: T) => string,
  now: Date,
  edited: Map<string, Partial<T>>,
): RowChange[] {
  const changes: RowChange[] = [];
  ordered.forEach((row, index) => {
    const patch = { ...edited.get(idOf(row)), position: index + 1 } as Partial<T>;
    const differs = Object.entries(patch).some(([column, value]) => row[column as keyof T] !== value);
    if (differs) changes.push({ table, id: idOf(row), before: row, after: updatedRow(row, patch, now) });
  });
  return changes;
}

/** `live` in the order given, then the archived rows of `all` (each keeping its order), skipping any in `live`. */
function withArchivedLast<T extends Labelled>(live: readonly T[], all: readonly T[]): T[] {
  const placed = new Set(live.map((row) => row.key));
  return [...live, ...all.filter((row) => row.archived === 1 && !placed.has(row.key))];
}

function checkPosition(position: number, count: number): void {
  if (!Number.isInteger(position) || position < 1 || position > count) {
    throw new UserError(`The position must be a whole number between 1 and ${count} (got ${position}).`);
  }
}

/** The live people who have this status (and sub-status, when given), for a refusal: a count and up to five names. */
async function peopleWith(db: Db, status: string, sub?: string): Promise<{ count: number; names: string }> {
  const where = sub === undefined ? "person_status = ?" : "person_status = ? AND sub_status = ?";
  const binds = sub === undefined ? [status] : [status, sub];
  const count = (await db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE archived = 0 AND ${where}`).bind(...binds).first<number>("n")) ?? 0;
  const shown = await db
    .prepare(`SELECT id, name, untrusted_fields FROM contacts WHERE archived = 0 AND ${where} ORDER BY created_at, id LIMIT ${SHOWN_PEOPLE}`)
    .bind(...binds)
    .all<{ id: string; name: string; untrusted_fields: string }>();
  const names = shown.results.map(contactName);
  const more = count > names.length ? ` and ${count - names.length} more` : "";
  return { count, names: count > names.length ? `${names.join(", ")}${more}` : joinAnd(names) };
}

const people = (n: number) => (n === 1 ? "1 person has" : `${n} people have`);

export interface NewPersonStatus {
  label: string;
  /** What its sub-status field is called; default "Sub-status". */
  subLabel?: string;
  /** 1-based place among the live statuses; default last. */
  position?: number;
}

export async function addPersonStatus(ctx: Ctx, input: NewPersonStatus): Promise<ChangeResult & { key: string }> {
  const all = await statusRows(ctx.db);
  const live = all.filter((row) => row.archived === 0);
  const label = cleanLabel(input.label, "person status", "Supplier");
  refuseDuplicate(all, label, "person status");
  const subLabel = input.subLabel === undefined ? "Sub-status" : cleanLabel(input.subLabel, "sub-status field", "Supplier type");
  const position = input.position ?? live.length + 1;
  checkPosition(position, live.length + 1);
  const key = uniqueKey(slugOf(label), new Set(all.map((row) => row.key)));

  const now = ctx.now.toISOString();
  const added: PersonStatusRow = {
    key,
    label,
    position,
    sub_label: subLabel,
    locked: 0,
    archived: 0,
    version: 1,
    created_at: now,
    updated_at: now,
  };
  const ordered = withArchivedLast([...live.slice(0, position - 1), added, ...live.slice(position - 1)], all);
  const result = await commitChange(ctx, {
    target: { table: "person_statuses", id: key },
    summary: `Added person status ${label} (key ${key}) at position ${position} of ${live.length + 1}`,
    // The new status is already in its place, so renumber() leaves it out and moves only the others.
    changes: [
      { table: "person_statuses", id: key, before: null, after: added },
      ...renumber(ordered, "person_statuses", (row) => row.key, ctx.now, new Map()),
    ],
  });
  return { ...result, key };
}

export interface PersonStatusPatch {
  label?: string;
  subLabel?: string;
  /** 1-based place among the live statuses. */
  position?: number;
  /** true archives it (refused for Lead and Contact, and while anyone has it); false brings it back. */
  archived?: boolean;
}

export async function updatePersonStatus(ctx: Ctx, ref: string, patch: PersonStatusPatch): Promise<ChangeResult & { key: string }> {
  const { db } = ctx;
  const all = await statusRows(db);
  const status = pick(all, ref, "person status");
  const edit: Partial<PersonStatusRow> = {};
  const parts: string[] = [];
  const name = () => edit.label ?? status.label;

  if (patch.label !== undefined) {
    const label = cleanLabel(patch.label, "person status", "Supplier");
    refuseDuplicate(all, label, "person status", status.key);
    if (label !== status.label) {
      edit.label = label;
      parts.push(`Renamed person status ${status.label} to ${label}`);
    }
  }
  if (patch.subLabel !== undefined) {
    const subLabel = cleanLabel(patch.subLabel, "sub-status field", "Supplier type");
    if (subLabel !== status.sub_label) {
      edit.sub_label = subLabel;
      parts.push(parts.length > 0 ? `called its sub-status field ${subLabel}` : `Called the sub-status field of ${name()} ${subLabel}`);
    }
  }
  let archived = status.archived === 1;
  if (patch.archived !== undefined && patch.archived !== archived) {
    if (patch.archived) {
      if (status.locked === 1) {
        throw new UserError(
          `${status.label} can be renamed but not archived: the app moves people to it by itself, and rules and reports use it.`,
        );
      }
      const holders = await peopleWith(db, status.key);
      if (holders.count > 0) {
        throw new UserError(
          `${people(holders.count)} the status ${status.label}: ${holders.names}. Move ${holders.count === 1 ? "them" : "each of them"} to another status first.`,
        );
      }
      parts.push(parts.length > 0 ? "archived it" : `Archived person status ${name()}`);
    } else {
      refuseDuplicate(all, name(), "person status", status.key);
      parts.push(parts.length > 0 ? "brought it back" : `Brought back person status ${name()}`);
    }
    archived = patch.archived;
    edit.archived = archived ? 1 : 0;
  } else if (status.archived === 1 && (patch.label !== undefined || patch.position !== undefined)) {
    throw new UserError(`${status.label} is archived. Bring it back first (archived: false), then change it.`);
  }

  const live = all.filter((row) => row.archived === 0 && row.key !== status.key);
  let ordered: PersonStatusRow[];
  if (archived) {
    if (patch.position !== undefined) throw new UserError("An archived status has no position. Leave out the position, or bring it back.");
    ordered = [...live, status, ...all.filter((row) => row.archived === 1 && row.key !== status.key)];
  } else {
    const count = live.length + 1;
    const from = status.archived === 1 ? count : all.filter((row) => row.archived === 0).indexOf(status) + 1;
    const to = patch.position ?? from;
    checkPosition(to, count);
    if (to !== from) {
      parts.push(parts.length > 0 ? `moved it to position ${to} of ${count}` : `Moved person status ${name()} to position ${to} of ${count}`);
    }
    ordered = withArchivedLast([...live.slice(0, to - 1), status, ...live.slice(to - 1)], all);
  }
  const changes = renumber(ordered, "person_statuses", (row) => row.key, ctx.now, new Map([[status.key, edit]]));
  if (changes.length === 0 || parts.length === 0) {
    throw new UserError(`Nothing to change on ${status.label}: give a new label, sub-status label or position.`);
  }
  const result = await commitChange(ctx, { target: { table: "person_statuses", id: status.key }, summary: parts.join("; "), changes });
  return { ...result, key: status.key };
}

/** A status for a sub-status write: it must be live. */
async function liveStatus(db: Db, ref: string): Promise<PersonStatusRow> {
  const status = pick(await statusRows(db), ref, "person status");
  if (status.archived === 1) throw new UserError(`${status.label} is archived. Bring it back first, then change its sub-statuses.`);
  return status;
}

export async function addSubStatus(ctx: Ctx, statusRef: string, input: { label: string }): Promise<ChangeResult & { key: string }> {
  const status = await liveStatus(ctx.db, statusRef);
  if (status.key === LEAD) {
    throw new UserError(
      `${status.label}'s sub-statuses are fixed, because rules and reports use them. Rename one with updateSubStatus instead.`,
    );
  }
  const all = await subRows(ctx.db, status.key);
  const label = cleanLabel(input.label, "sub-status", "Wholesale");
  refuseDuplicate(all, label, `sub-status of ${status.label}`);
  const key = uniqueKey(slugOf(label), new Set(all.map((row) => row.key)));
  const live = all.filter((row) => row.archived === 0);
  const now = ctx.now.toISOString();
  const added: PersonSubstatusRow = {
    id: `${status.key}.${key}`,
    status_key: status.key,
    key,
    label,
    position: live.length + 1,
    archived: 0,
    version: 1,
    created_at: now,
    updated_at: now,
  };
  // Archived ones sit after the live ones, so the new one takes the first place after them and they move down one.
  const ordered = withArchivedLast([...live, added], all);
  const changes = renumber(ordered, "person_substatuses", (row) => row.id, ctx.now, new Map());
  const result = await commitChange(ctx, {
    target: { table: "person_substatuses", id: added.id },
    summary: `Added sub-status ${label} (key ${key}) to ${status.label}`,
    changes: [{ table: "person_substatuses", id: added.id, before: null, after: added }, ...changes],
  });
  return { ...result, key };
}

export interface SubStatusPatch {
  label?: string;
  /** 1-based place among the status's live sub-statuses. */
  position?: number;
  /** true archives it (refused for Lead's, and while anyone has it); false brings it back. */
  archived?: boolean;
}

export async function updateSubStatus(
  ctx: Ctx,
  statusRef: string,
  subRef: string,
  patch: SubStatusPatch,
): Promise<ChangeResult & { key: string }> {
  const { db } = ctx;
  const status = await liveStatus(db, statusRef);
  const all = await subRows(db, status.key);
  const sub = pick(all, subRef, `sub-status of ${status.label}`);
  const edit: Partial<PersonSubstatusRow> = {};
  const parts: string[] = [];
  const name = () => edit.label ?? sub.label;

  if (patch.label !== undefined) {
    const label = cleanLabel(patch.label, "sub-status", "Wholesale");
    refuseDuplicate(all, label, `sub-status of ${status.label}`, sub.key);
    if (label !== sub.label) {
      edit.label = label;
      parts.push(`Renamed sub-status ${sub.label} of ${status.label} to ${label}`);
    }
  }
  let archived = sub.archived === 1;
  if (patch.archived !== undefined && patch.archived !== archived) {
    if (patch.archived) {
      if (status.key === LEAD) {
        throw new UserError(`${sub.label} can be renamed but not archived: rules and reports use ${status.label}'s sub-statuses.`);
      }
      const holders = await peopleWith(db, status.key, sub.key);
      if (holders.count > 0) {
        throw new UserError(
          `${people(holders.count)} the sub-status ${sub.label}: ${holders.names}. Give ${holders.count === 1 ? "them" : "each of them"} another one first.`,
        );
      }
      parts.push(parts.length > 0 ? "archived it" : `Archived sub-status ${name()} of ${status.label}`);
    } else {
      refuseDuplicate(all, name(), `sub-status of ${status.label}`, sub.key);
      parts.push(parts.length > 0 ? "brought it back" : `Brought back sub-status ${name()} of ${status.label}`);
    }
    archived = patch.archived;
    edit.archived = archived ? 1 : 0;
  } else if (sub.archived === 1 && (patch.label !== undefined || patch.position !== undefined)) {
    throw new UserError(`${sub.label} is archived. Bring it back first (archived: false), then change it.`);
  }

  const live = all.filter((row) => row.archived === 0 && row.key !== sub.key);
  let ordered: PersonSubstatusRow[];
  if (archived) {
    if (patch.position !== undefined) throw new UserError("An archived sub-status has no position. Leave out the position, or bring it back.");
    ordered = [...live, sub, ...all.filter((row) => row.archived === 1 && row.key !== sub.key)];
  } else {
    const count = live.length + 1;
    const from = sub.archived === 1 ? count : all.filter((row) => row.archived === 0).indexOf(sub) + 1;
    const to = patch.position ?? from;
    checkPosition(to, count);
    if (to !== from) {
      parts.push(
        parts.length > 0 ? `moved it to position ${to} of ${count}` : `Moved sub-status ${name()} of ${status.label} to position ${to} of ${count}`,
      );
    }
    ordered = withArchivedLast([...live.slice(0, to - 1), sub, ...live.slice(to - 1)], all);
  }
  const changes = renumber(ordered, "person_substatuses", (row) => row.id, ctx.now, new Map([[sub.id, edit]]));
  if (changes.length === 0 || parts.length === 0) {
    throw new UserError(`Nothing to change on ${sub.label}: give a new label or position.`);
  }
  const result = await commitChange(ctx, { target: { table: "person_substatuses", id: sub.id }, summary: parts.join("; "), changes });
  return { ...result, key: sub.key };
}

export interface PersonStatusInput {
  /** A live status, by key or label. */
  status: string;
  /**
   * One of its live sub-statuses, by key or label; null for none (never for Lead). Left out: kept when the status
   * stays the same, otherwise New for Lead and none for the others.
   */
  sub?: string | null;
}

/** Where a write moves a person: the live status and sub-status rows, and the move as keys. */
export interface ResolvedMove {
  status: PersonStatusRow;
  sub: PersonSubstatusRow | null;
  move: PersonMove;
}

/**
 * The live status and sub-status a write moves a person to, or the plain refusal. `current` is the person now, or null
 * for a new person. With no sub-status given: kept when the status stays the same, New for Lead, none otherwise. Lead
 * always has one.
 */
export async function resolveMove(
  db: Db,
  current: Pick<ContactRow, "person_status" | "sub_status"> | null,
  input: PersonStatusInput,
): Promise<ResolvedMove> {
  const statuses = await statusRows(db);
  const text = input.status.trim();
  const status = statuses.find((row) => row.key === text) ?? statuses.find((row) => row.archived === 0 && sameLabel(row.label, text));
  if (!status || status.archived === 1) {
    const list = statuses.filter((row) => row.archived === 0).map((row) => `${row.label} (${row.key})`).join(", ");
    throw new UserError(`There's no live person status "${text}". Use one of: ${list}.`);
  }
  const subs = (await subRows(db, status.key)).filter((row) => row.archived === 0);
  let sub: PersonSubstatusRow | null = null;
  if (input.sub === undefined) {
    if (current !== null && status.key === current.person_status) sub = subs.find((row) => row.key === current.sub_status) ?? null;
    else if (status.key === LEAD) sub = subs.find((row) => row.key === "new") ?? null;
  } else if (input.sub !== null && clean(input.sub) !== null) {
    const subText = input.sub.trim();
    sub = subs.find((row) => row.key === subText) ?? subs.find((row) => sameLabel(row.label, subText)) ?? null;
    if (sub === null) {
      const list = subs.map((row) => `${row.label} (${row.key})`).join(", ");
      throw new UserError(
        list === ""
          ? `${status.label} has no sub-statuses. Leave the sub-status out.`
          : `${status.label} has no sub-status "${subText}". Use one of: ${list}.`,
      );
    }
  }
  if (status.key === LEAD && sub === null) {
    throw new UserError(`A lead always has a ${status.sub_label.toLowerCase()}. Give one of: ${subs.map((row) => row.key).join(", ")}.`);
  }
  return { status, sub, move: { status: status.key, sub: sub?.key ?? null } };
}

/** A status by key (archived ones too) or label, for a filter: the refusal lists the live ones. */
export async function findPersonStatus(db: Db, ref: string): Promise<PersonStatusRow> {
  return pick(await statusRows(db), ref, "person status");
}

/** One of a status's sub-statuses by key (archived ones too) or label. */
export async function findSubStatus(db: Db, status: PersonStatusRow, ref: string): Promise<PersonSubstatusRow> {
  const all = await subRows(db, status.key);
  if (all.length === 0) throw new UserError(`${status.label} has no sub-statuses. Leave the sub-status out.`);
  return pick(all, ref, `sub-status of ${status.label}`);
}

/** The refusal for Lead while the person has open deals (invariant 1, decision 0022). */
async function refuseLeadWithDeal(db: Db, contact: ContactRow): Promise<void> {
  const open = await openDealCount(db, contact.id);
  if (open === 0) return;
  const who = capitalize(contactName(contact));
  throw new UserError(
    open === 1
      ? `${who} has an open deal, so they can't be a lead. Use return_to_lead on that deal instead, or close it first.`
      : `${who} has ${open} open deals, so they can't be a lead. Close them first, or close all but one and use return_to_lead on that one.`,
  );
}

/**
 * The owner's move of a person to another status and sub-status, in one change. Lead is refused while the person has
 * an open deal, checked again inside the batch so a deal added at the same moment can't slip past.
 */
export async function setPersonStatus(ctx: Ctx, contactRef: string, input: PersonStatusInput): Promise<ChangeResult & { contactId: string }> {
  const { db } = ctx;
  const contact = await findContact(db, contactRef);
  const who = contactName(contact);
  if (contact.archived === 1) throw new UserError(`${capitalize(who)} is archived, so their status can't change.`);
  const { status, sub, move: to } = await resolveMove(db, contact, input);
  if (to.status === contact.person_status && to.sub === contact.sub_status) {
    throw new UserError(`Nothing to change for ${who}: they are ${status.label}${sub ? ` (${sub.label})` : ""} already.`);
  }
  if (to.status === LEAD) await refuseLeadWithDeal(db, contact);

  const after = withPersonStatus(contact, to, ctx.now);
  const summary = `Moved ${who} to ${status.label}${sub ? ` (${sub.label})` : ""}`;
  const extra = to.status === LEAD && contact.person_status !== LEAD ? [noOpenDeal(db, contact.id)] : [];
  try {
    const result = await commitChange(ctx, {
      target: { table: "contacts", id: contact.id },
      summary,
      changes: [{ table: "contacts", id: contact.id, before: contact, after }],
      extra,
    });
    return { ...result, contactId: contact.id };
  } catch (error) {
    // The guard that tripped may be the open-deal one: then say so, not "changed since".
    if (error instanceof StaleWriteError && extra.length > 0) await refuseLeadWithDeal(db, contact);
    throw error;
  }
}

/** What the owner calls the Client sub-status now ("Client" unless renamed). */
export async function clientLabel(db: Db): Promise<string> {
  return (await db.prepare("SELECT label FROM person_substatuses WHERE id = 'contact.client'").first<string>("label")) ?? "Client";
}

/**
 * Contact to Client when one of their deals is marked Won (decision 0040): the change for the caller's batch, or null
 * when the person isn't a Contact, is a Client already, or the Client sub-status is archived.
 */
export async function clientIfWon(db: Db, contact: ContactRow, now: Date): Promise<RowChange | null> {
  if (contact.person_status !== CONTACT || contact.sub_status === "client") return null;
  const live = await db
    .prepare("SELECT 1 AS one FROM person_substatuses WHERE id = 'contact.client' AND archived = 0")
    .first<{ one: number }>();
  if (live === null) return null;
  return { table: "contacts", id: contact.id, before: contact, after: withPersonStatus(contact, { status: CONTACT, sub: "client" }, now) };
}
