// add_deal: a deal for someone who wants something, with a new person or one already on file (decision 0022). A lead
// it uses becomes Qualified in the same change, so a person with an open deal is never an unqualified lead.
import type { ActivityRow, ContactRow, DealRow } from "../db/db.ts";
import { findContactByEmail } from "../db/queries.ts";
import { newId } from "../ids.ts";
import type { ChangeResult, Ctx, RowChange } from "./change.ts";
import { commitWithEmail } from "./contacts.ts";
import { capitalize, nextPart } from "./describe.ts";
import { UserError } from "./errors.ts";
import { checkFieldValues } from "./fields.ts";
import { checkEmail, checkValue, clean, whenOrNull, withoutNulls } from "./input.ts";
import { contactName, dealTitle, isTrusted } from "./labels.ts";
import { qualifyIfLead } from "./lead-change.ts";
import { type FieldValues, findContact, firstStageOfKind, ownerTimezone } from "./lookup.ts";

export interface DealInput {
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

export interface AddDealResult extends ChangeResult {
  contactId: string;
  dealId: string;
  /** The email matched a contact already on file, so only a deal was added. */
  matchedExisting: boolean;
}

export async function addDeal(ctx: Ctx, input: DealInput): Promise<AddDealResult> {
  const { db } = ctx;
  const tz = await ownerTimezone(db);
  const chosen = input.contact === undefined ? null : await findContact(db, input.contact);
  const name = clean(input.name);
  if (chosen !== null && chosen.archived === 1) {
    throw new UserError(`${capitalize(contactName(chosen))} is archived, so no new deal can be added for them.`);
  }
  if (name === null && chosen === null) throw new UserError("A new deal needs a person: give their name, or an existing contact.");
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
      lead_status: null,
      lead_status_at: null,
    };
    changes.push({ table: "contacts", id: contact.id, before: null, after: contact });
  }
  const qualified = existing === null ? null : qualifyIfLead(existing, ctx.now);
  if (qualified !== null) changes.push(qualified);

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

  // With a chosen contact, a name other than theirs is left as it was too.
  const otherName = chosen !== null && name !== null && name.toLowerCase() !== chosen.name.toLowerCase();
  const detailsGiven =
    otherName ||
    [input.phone, input.business, input.source, chosen === null ? undefined : input.email].some((v) => clean(v) !== null) ||
    Object.keys(contactFields).length > 0;
  const ignored = existing !== null && detailsGiven;
  // "deal \"Garage plans\"" or "deal dl_…"; "contact Pat Example" or "contact ct_…".
  const dealPart = isTrusted(deal, "title") ? `deal ${dealTitle(deal)}` : dealTitle(deal);
  const contactPart = existing && isTrusted(existing, "name") ? `contact ${contactName(existing)}` : existing ? contactName(existing) : "";
  const summary =
    (existing
      ? `Added ${dealPart} for existing ${contactPart} in ${stage.label}`
      : `Added contact ${name} with deal "${deal.title}" in ${stage.label}`) +
    nextPart(nextStep, nextAt, tz) +
    (qualified !== null ? `; ${contactName(contact)} is now Qualified` : "") +
    (ignored ? "; contact details left as they were (use update_contact to change them)" : "");
  const result = await commitWithEmail(ctx, { target: { table: "deals", id: deal.id }, summary, changes }, existing ? null : email);
  return { ...result, contactId: contact.id, dealId: deal.id, matchedExisting: existing !== null };
}
