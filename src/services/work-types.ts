// Work types and client rates (decision 0049): add_work_type, update_work_type, set_client_rate and list_work_types.
// They are configuration, like stages and fields: the AI app changes them only when the owner asks (server rule 5), and
// they write at once rather than through a proposal. A client rate is one person's own hourly rate for a work type;
// it beats the work type's rate. Clearing it archives the row, so its undo puts it back.
import type { ClientRateRow, ContactRow, Db, WorkTypeRow } from "../db/db.ts";
import { newId } from "../ids.ts";
import {
  type ChangeResult,
  commitChange,
  type Ctx,
  isClientRatePairFailure,
  isWorkTypeNameFailure,
  updatedRow,
} from "./change.ts";
import { joinAnd, short } from "./describe.ts";
import { UserError } from "./errors.ts";
import { clean } from "./input.ts";
import { contactName } from "./labels.ts";
import { findContact, type Source, sourceOf, withPlanned, workTypeById } from "./lookup.ts";
import { liveWorkTypeRows } from "./memo.ts";
import { requireTimeTracking } from "./settings.ts";
import { formatMoney, toCents } from "./time-format.ts";

const NAME_MAX = 60;
const RATE_MAX = 100_000;

export interface WorkTypeView {
  id: string;
  name: string;
  hourlyRate: number | null;
  billableDefault: boolean;
  position: number;
  /** People with a rate of their own for this work type. */
  clientRates: { contactId: string; contact: string; hourlyRate: number }[];
}

async function liveWorkTypes(db: Db): Promise<WorkTypeRow[]> {
  const found = await db.prepare("SELECT * FROM work_types WHERE archived = 0 ORDER BY position, created_at, id").all<WorkTypeRow>();
  return found.results;
}

function checkName(input: string): string {
  const name = clean(input);
  if (name === null || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name) || [...name].length > NAME_MAX) {
    throw new UserError(`A work type name must be one line of plain text, 1 to ${NAME_MAX} characters.`);
  }
  return name;
}

/** A rate in cents, null for none, or a UserError. */
export function checkRate(rate: number | null): number | null {
  if (rate === null) return null;
  if (!Number.isFinite(rate) || rate < 0 || rate > RATE_MAX) {
    throw new UserError(`An hourly rate must be a number from 0 to ${RATE_MAX.toLocaleString("en-US")}, or null for none.`);
  }
  return toCents(rate);
}

const rateText = (rate: number | null) => (rate === null ? "no rate" : `${formatMoney(rate)}/h`);

/** Refuses a name another live work type has (ignoring case); `except` is the one being renamed or restored. */
async function checkNameFree(db: Db, name: string, except?: string): Promise<void> {
  const taken = await db
    .prepare("SELECT * FROM work_types WHERE archived = 0 AND lower(name) = lower(?) AND id IS NOT ?")
    .bind(name, except ?? null)
    .first<WorkTypeRow>();
  if (taken) throw new UserError(`There's already a work type called ${taken.name}. Use another name, or update_work_type to change it.`);
}

/** A live work type by id or name (ignoring case). Time entries and the timer use this. */
export async function findWorkType(src: Source, ref: string): Promise<WorkTypeRow> {
  const text = ref.trim();
  const byId = text === "" ? null : await workTypeById(src, text);
  if (byId && byId.archived === 0) return byId;
  const live = await liveWorkTypeRows(src);
  const match = live.find((row) => row.name.toLowerCase() === text.toLowerCase());
  if (match) return match;
  const shown = short(text, 40);
  if (live.length === 0) throw new UserError(`There's no work type "${shown}". There are no work types yet: add one with add_work_type.`);
  throw new UserError(`There's no work type "${shown}". Work types: ${live.map((row) => row.name).join(", ")}. Use one of those, or add it with add_work_type.`);
}

/** A work type by id or name, live ones first, then the latest archived one (to restore it). */
async function findAnyWorkType(db: Db, ref: string): Promise<WorkTypeRow> {
  const text = ref.trim();
  const byId = text === "" ? null : await workTypeById(db, text);
  if (byId) return byId;
  const found = await db
    .prepare("SELECT * FROM work_types WHERE lower(name) = lower(?) ORDER BY archived, updated_at DESC, id LIMIT 1")
    .bind(text)
    .first<WorkTypeRow>();
  if (found) return found;
  return findWorkType(db, text);
}

const nextPosition = async (db: Db) =>
  ((await db.prepare("SELECT MAX(position) AS n FROM work_types WHERE archived = 0").first<number | null>("n")) ?? 0) + 1;

/** Turns a lost race on the name into the same refusal as the check before it. */
async function committed(ctx: Ctx, write: () => Promise<ChangeResult>, name: string): Promise<ChangeResult> {
  try {
    return await write();
  } catch (error) {
    if (isWorkTypeNameFailure(error)) await checkNameFree(ctx.db, name);
    throw error;
  }
}

export async function addWorkType(
  ctx: Ctx,
  input: { name: string; hourlyRate?: number | null; billableDefault?: boolean },
): Promise<ChangeResult & { workTypeId: string }> {
  const { db } = ctx;
  await requireTimeTracking(db);
  const name = checkName(input.name);
  const hourlyRate = checkRate(input.hourlyRate ?? null);
  await checkNameFree(db, name);
  const now = ctx.now.toISOString();
  const row: WorkTypeRow = {
    id: newId("wt"),
    name,
    hourly_rate: hourlyRate,
    billable_default: input.billableDefault === false ? 0 : 1,
    position: await nextPosition(db),
    archived: 0,
    version: 1,
    created_at: now,
    updated_at: now,
  };
  const billing = row.billable_default === 1 ? "billable by default" : "not billable by default";
  const summary = `Added work type ${name}${hourlyRate === null ? ", no rate" : ` at ${rateText(hourlyRate)}`}, ${billing}`;
  const result = await committed(
    ctx,
    () => commitChange(ctx, { target: { table: "work_types", id: row.id }, summary, changes: [{ table: "work_types", id: row.id, before: null, after: row }] }),
    name,
  );
  return { ...result, workTypeId: row.id };
}

export async function updateWorkType(
  ctx: Ctx,
  ref: string,
  patch: { name?: string; hourlyRate?: number | null; billableDefault?: boolean; archived?: boolean },
): Promise<ChangeResult & { workTypeId: string }> {
  const { db } = ctx;
  await requireTimeTracking(db);
  const before = await findAnyWorkType(db, ref);
  const set: Partial<WorkTypeRow> = {};
  const parts: string[] = [];
  if (patch.name !== undefined) {
    const name = checkName(patch.name);
    if (name !== before.name) {
      if (before.archived === 0 || patch.archived === false) await checkNameFree(db, name, before.id);
      set.name = name;
      parts.push(`renamed from ${before.name}`);
    }
  }
  if (patch.hourlyRate !== undefined) {
    const rate = checkRate(patch.hourlyRate);
    if (rate !== before.hourly_rate) {
      set.hourly_rate = rate;
      parts.push(rate === null ? "hourly rate cleared" : `hourly rate ${rateText(before.hourly_rate)} -> ${rateText(rate)}`);
    }
  }
  if (patch.billableDefault !== undefined && (patch.billableDefault ? 1 : 0) !== before.billable_default) {
    set.billable_default = patch.billableDefault ? 1 : 0;
    parts.push(patch.billableDefault ? "billable by default" : "not billable by default");
  }
  const name = set.name ?? before.name;
  let summary = `Updated work type ${name}: ${joinAnd(parts)}`;
  if (patch.archived !== undefined && (patch.archived ? 1 : 0) !== before.archived) {
    if (!patch.archived) {
      await checkNameFree(db, name, before.id);
      set.position = await nextPosition(db);
    }
    set.archived = patch.archived ? 1 : 0;
    const verb = patch.archived ? "Archived" : "Restored";
    summary = parts.length === 0 ? `${verb} work type ${name}` : `${verb} work type ${name}: ${joinAnd(parts)}`;
    parts.push(verb);
  } else if (before.archived === 1 && parts.length > 0) {
    throw new UserError(`Work type ${before.name} is archived. Restore it first (archived false).`);
  }
  if (parts.length === 0) throw new UserError(`Nothing to change on work type ${before.name}: every value you gave is already set.`);
  const after = updatedRow(before, set, ctx.now);
  const result = await committed(
    ctx,
    () => commitChange(ctx, { target: { table: "work_types", id: before.id }, summary, changes: [{ table: "work_types", id: before.id, before, after }] }),
    name,
  );
  return { ...result, workTypeId: before.id };
}

const isLivePair = (workTypeId: string, contactId: string) => (row: Record<string, unknown>) =>
  row.work_type_id === workTypeId && row.contact_id === contactId && row.archived === 0;

/** The live client rate for a work type and person, as the plan (if any) leaves it. */
async function livePair(src: Source, workTypeId: string, contactId: string): Promise<ClientRateRow | null> {
  const { db } = sourceOf(src);
  const found = await db
    .prepare("SELECT * FROM client_rates WHERE work_type_id = ? AND contact_id = ? AND archived = 0")
    .bind(workTypeId, contactId)
    .first<ClientRateRow>();
  return withPlanned(src, "client_rates", found === null ? [] : [found], isLivePair(workTypeId, contactId))[0] ?? null;
}

/** "Pat Example's Design rate", the person by their safe label (labels.ts). */
const rateName = (contact: ContactRow, workType: WorkTypeRow) => `${contactName(contact)}'s ${workType.name} rate`;

/** Sets a person's own rate for a work type, changes it, or (hourlyRate null) clears it. */
export async function setClientRate(
  ctx: Ctx,
  input: { workType: string; contact: string; hourlyRate: number | null },
): Promise<ChangeResult> {
  const { db } = ctx;
  await requireTimeTracking(db);
  const workType = await findWorkType(ctx, input.workType);
  const contact = await findContact(ctx, input.contact);
  const rate = checkRate(input.hourlyRate);
  const current = await livePair(ctx, workType.id, contact.id);
  const target = (id: string) => ({ table: "client_rates" as const, id });
  const write = async (): Promise<ChangeResult> => {
    if (rate === null) {
      if (current === null) throw new UserError(`${contactName(contact)} has no ${workType.name} rate of their own to clear.`);
      return commitChange(ctx, {
        target: target(current.id),
        summary: `Cleared ${rateName(contact, workType)} (back to ${rateText(workType.hourly_rate)})`,
        changes: [{ table: "client_rates", id: current.id, before: current, after: updatedRow(current, { archived: 1 }, ctx.now) }],
      });
    }
    if (current !== null) {
      if (current.hourly_rate === rate) throw new UserError(`${rateName(contact, workType)} is already ${rateText(rate)}. Nothing to change.`);
      return commitChange(ctx, {
        target: target(current.id),
        summary: `Changed ${rateName(contact, workType)} from ${rateText(current.hourly_rate)} to ${rateText(rate)}`,
        changes: [{ table: "client_rates", id: current.id, before: current, after: updatedRow(current, { hourly_rate: rate }, ctx.now) }],
      });
    }
    const now = ctx.now.toISOString();
    const row: ClientRateRow = {
      id: newId("cr"),
      work_type_id: workType.id,
      contact_id: contact.id,
      hourly_rate: rate,
      archived: 0,
      version: 1,
      created_at: now,
      updated_at: now,
    };
    return commitChange(ctx, {
      target: target(row.id),
      summary: `Set ${rateName(contact, workType)} to ${rateText(rate)} (the default is ${rateText(workType.hourly_rate)})`,
      changes: [{ table: "client_rates", id: row.id, before: null, after: row }],
    });
  };
  try {
    return await write();
  } catch (error) {
    if (isClientRatePairFailure(error)) {
      throw new UserError(`${rateName(contact, workType)} was set meanwhile. Read it with list_work_types and try again.`, { cause: error });
    }
    throw error;
  }
}

/** The live work types in order, each with the people who have a rate of their own for it. */
export async function listWorkTypes(db: Db): Promise<WorkTypeView[]> {
  await requireTimeTracking(db);
  const types = await liveWorkTypes(db);
  const rates = await db
    .prepare(
      `SELECT r.work_type_id, r.hourly_rate, c.id, c.name, c.untrusted_fields FROM client_rates r JOIN contacts c ON c.id = r.contact_id
       WHERE r.archived = 0 ORDER BY lower(c.name), c.id`,
    )
    .all<{ work_type_id: string; hourly_rate: number; id: string; name: string; untrusted_fields: string }>();
  return types.map((row) => ({
    id: row.id,
    name: row.name,
    hourlyRate: row.hourly_rate,
    billableDefault: row.billable_default === 1,
    position: row.position,
    clientRates: rates.results
      .filter((rate) => rate.work_type_id === row.id)
      .map((rate) => ({ contactId: rate.id, contact: contactName(rate), hourlyRate: rate.hourly_rate })),
  }));
}
