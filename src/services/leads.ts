// add_lead and update_contact.
import type { ActivityRow, ContactRow, DealRow } from "../db/db.ts";
import { findContactByEmail } from "../db/queries.ts";
import { newId } from "../ids.ts";
import {
  type ChangeInput,
  type ChangeResult,
  changedColumns,
  commitChange,
  type Ctx,
  isDuplicateEmailFailure,
  type Row,
  type RowChange,
  updatedRow,
} from "./change.ts";
import { checkFieldValues } from "./fields.ts";
import { columnLabel, fieldsLabel, joinAnd, nextPart } from "./describe.ts";
import { UserError } from "./errors.ts";
import { checkEmail, checkValue, clean, whenOrNull, withoutNulls } from "./input.ts";
import { contactName, dealTitle, isTrusted } from "./labels.ts";
import {
  type FieldValues,
  findContact,
  firstStageOfKind,
  mergeFields,
  ownerTimezone,
  parseObject,
  parseStringArray,
} from "./lookup.ts";

/** commitChange, with a duplicate email that another writer got in first turned into a plain answer. */
async function commitWithEmail(ctx: Ctx, input: ChangeInput, email: string | null): Promise<ChangeResult> {
  try {
    return await commitChange(ctx, input);
  } catch (error) {
    if (email === null || !isDuplicateEmailFailure(error)) throw error;
    const other = await findContactByEmail(ctx.db, email);
    const who = other ? `: contact ${other.id}` : "";
    throw new UserError(`Another contact already uses that email${who}. Use update_contact on that one instead.`, {
      cause: error,
    });
  }
}

export interface LeadInput {
  /** Needed unless `contact` is given. */
  name?: string;
  /** An existing contact (id or exact name) to add the deal to; the person's details are then left as they are. */
  contact?: string;
  email?: string;
  phone?: string;
  business?: string;
  source?: string;
  /** Logged as a note activity on the new deal. */
  notes?: string;
  dealTitle?: string;
  value?: number;
  nextStep?: string;
  nextAt?: string;
  fields?: FieldValues;
  contactFields?: FieldValues;
}

export interface AddLeadResult extends ChangeResult {
  contactId: string;
  dealId: string;
  /** The email matched a contact already on file, so only a deal was added. */
  matchedExisting: boolean;
}

export async function addLead(ctx: Ctx, input: LeadInput): Promise<AddLeadResult> {
  const { db } = ctx;
  const tz = await ownerTimezone(db);
  const chosen = input.contact === undefined ? null : await findContact(db, input.contact);
  const name = clean(input.name);
  if (name === null && chosen === null) throw new UserError("A lead needs a name. Give the person's name.");
  const email = clean(input.email);
  if (email !== null && chosen === null) checkEmail(email);
  const value = input.value === undefined ? null : checkValue(input.value);
  const nextStep = clean(input.nextStep);
  const nextAt = whenOrNull(input.nextAt ?? null, tz);
  const dealFields = withoutNulls(input.fields ?? {});
  const contactFields = withoutNulls(input.contactFields ?? {});
  await checkFieldValues(db, "deal", dealFields);
  await checkFieldValues(db, "contact", contactFields);
  const stage = await firstStageOfKind(db, "open");
  if (!stage) throw new UserError("There's no open stage to put a new deal in. Add one with add_stage first.");

  const now = ctx.now.toISOString();
  const changes: RowChange[] = [];
  const existing = chosen ?? (email === null ? null : await findContactByEmail(db, email));
  let contact: ContactRow;
  if (existing) {
    contact = existing;
  } else {
    if (name === null) throw new Error("A new contact needs a name.");
    contact = {
      id: newId("ct"),
      name,
      email,
      phone: clean(input.phone),
      business: clean(input.business),
      source: clean(input.source),
      notes: null,
      fields: JSON.stringify(contactFields),
      untrusted_fields: "[]",
      archived: 0,
      version: 1,
      created_at: now,
      updated_at: now,
    };
    changes.push({ table: "contacts", id: contact.id, before: null, after: contact });
  }

  const notes = clean(input.notes);
  const title = clean(input.dealTitle);
  // A default title built from a name that came from outside is outside text too (as /intake does it).
  const namedFrom = title === null ? chosen : null;
  const titleOutside = namedFrom !== null && !isTrusted(namedFrom, "name");
  const deal: DealRow = {
    id: newId("dl"),
    contact_id: contact.id,
    title: title ?? `${namedFrom?.name ?? name} inquiry`,
    stage_key: stage.key,
    value,
    next_step: nextStep,
    next_at: nextAt,
    status: "open",
    fields: JSON.stringify(dealFields),
    stage_entered_at: now,
    last_activity_at: notes === null ? null : now,
    untrusted_fields: titleOutside ? '["title"]' : "[]",
    archived: 0,
    version: 1,
    created_at: now,
    updated_at: now,
  };
  changes.push({ table: "deals", id: deal.id, before: null, after: deal });
  if (notes !== null) {
    const note: ActivityRow = {
      id: newId("ac"),
      deal_id: deal.id,
      contact_id: contact.id,
      type: "note",
      summary: notes,
      untrusted_text: null,
      data: null,
      occurred_at: now,
      actor: ctx.actor,
      version: 1,
      created_at: now,
    };
    changes.push({ table: "activities", id: note.id, before: null, after: note });
  }

  const detailsGiven =
    [input.phone, input.business, input.source, chosen === null ? undefined : input.email].some((v) => clean(v) !== null) ||
    Object.keys(contactFields).length > 0;
  const ignored = existing !== null && detailsGiven;
  // "deal \"Garage plans\"" or "deal dl_…"; "contact Pat Example" or "contact ct_…".
  const dealPart = isTrusted(deal, "title") ? `deal ${dealTitle(deal)}` : dealTitle(deal);
  const contactPart = existing && isTrusted(existing, "name") ? `contact ${contactName(existing)}` : existing ? contactName(existing) : "";
  const summary =
    (existing
      ? `Added ${dealPart} for existing ${contactPart} in ${stage.label}`
      : `Added lead ${name} with deal "${deal.title}" in ${stage.label}`) +
    nextPart(nextStep, nextAt, tz) +
    (ignored ? "; contact details left as they were (use update_contact to change them)" : "");
  const result = await commitWithEmail(ctx, { target: { table: "deals", id: deal.id }, summary, changes }, existing ? null : email);
  return { ...result, contactId: contact.id, dealId: deal.id, matchedExisting: existing !== null };
}

export interface ContactPatch {
  name?: string;
  email?: string | null;
  phone?: string | null;
  business?: string | null;
  source?: string | null;
  notes?: string | null;
  /** Merged into the stored values; null removes a key. */
  fields?: FieldValues;
}

const OPTIONAL_COLUMNS = ["email", "phone", "business", "source", "notes"] as const;

/** Every field this sets is the owner's word from now on, so it leaves `untrusted_fields`. */
export async function updateContact(ctx: Ctx, contactRef: string, patch: ContactPatch): Promise<ChangeResult> {
  const { db } = ctx;
  const before = await findContact(db, contactRef);
  const set: Row = {};
  const confirmed: string[] = [];

  if (patch.name !== undefined) {
    const name = clean(patch.name);
    if (name === null) throw new UserError("A contact's name can't be blank. Give the new name.");
    set.name = name;
    confirmed.push("name");
  }
  for (const column of OPTIONAL_COLUMNS) {
    if (patch[column] === undefined) continue;
    const value = clean(patch[column]);
    if (column === "email" && value !== null) {
      checkEmail(value);
      const other = await findContactByEmail(db, value);
      if (other && other.id !== before.id) {
        throw new UserError(
          `${isTrusted(other, "name") ? `${other.name} (${other.id})` : `contact ${other.id}`} already uses ` +
            `${isTrusted(other, "email") ? other.email : value}. Use a different email, or update that contact instead.`,
        );
      }
    }
    set[column] = value;
    confirmed.push(column);
  }
  if (patch.fields !== undefined) {
    await checkFieldValues(db, "contact", patch.fields);
    set.fields = mergeFields(before.fields, patch.fields);
    confirmed.push(...Object.keys(patch.fields).map((key) => `fields.${key}`));
  }
  const untrusted = parseStringArray(before.untrusted_fields);
  const remaining = untrusted.filter((field) => !confirmed.includes(field));
  if (remaining.length !== untrusted.length) set.untrusted_fields = JSON.stringify(remaining);

  const after = updatedRow(before, set as Partial<ContactRow>, ctx.now);
  const changed = changedColumns(before, after).filter((c) => c !== "version" && c !== "updated_at");
  if (changed.length === 0) {
    throw new UserError(`Nothing to change for ${contactName(before)}: every value you gave is already set.`);
  }
  const labels = changed
    .filter((c) => c !== "untrusted_fields")
    .map((c) => (c === "fields" ? fieldsLabel(parseObject(before.fields), parseObject(after.fields)) : columnLabel(c)));
  const confirmedOnly = untrusted.filter((field) => confirmed.includes(field));
  const summary =
    labels.length > 0
      ? `Updated ${contactName(after)}: ${joinAnd(labels)}`
      : `Confirmed ${joinAnd(confirmedOnly.map(columnLabel))} for ${contactName(after)}`;
  return commitWithEmail(
    ctx,
    {
      target: { table: "contacts", id: before.id },
      summary,
      changes: [{ table: "contacts", id: before.id, before, after }],
    },
    typeof set.email === "string" ? set.email : null,
  );
}
