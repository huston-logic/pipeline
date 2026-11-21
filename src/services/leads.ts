// add_lead: someone the owner plans to approach, as a person with status New and no deal (decision 0022). Someone who
// wants something is a deal instead (add-deal.ts).
import type { ActivityRow, ContactRow, Db } from "../db/db.ts";
import { findContactByEmail } from "../db/queries.ts";
import { newId } from "../ids.ts";
import type { ChangeResult, Ctx, RowChange } from "./change.ts";
import { commitWithEmail } from "./contacts.ts";
import { capitalize } from "./describe.ts";
import { UserError } from "./errors.ts";
import { checkFieldValues } from "./fields.ts";
import { checkEmail, clean, withoutNulls } from "./input.ts";
import { contactRef } from "./labels.ts";
import { businessKey } from "./lead-change.ts";
import { LEAD_STATUS_LABELS } from "./lead-status.ts";
import type { FieldValues } from "./lookup.ts";

export interface NewLeadInput {
  /** Needed unless `business` is given; with only a business, the lead is named after it. */
  name?: string;
  business?: string;
  email?: string;
  phone?: string;
  source?: string;
  /** Logged as a note on the person. */
  notes?: string;
  /** Contact custom field values. */
  fields?: FieldValues;
  /** Add the lead even though a person on file has the same business. */
  allowDuplicate?: boolean;
}

export interface AddLeadResult extends ChangeResult {
  contactId: string;
}

/** The first person on file (not archived) whose business is the same company, ignoring case and spaces. */
async function sameBusiness(db: Db, business: string): Promise<ContactRow | null> {
  const key = businessKey(business);
  if (key === "") return null;
  // SQLite's lower() only folds ASCII, so the comparison is done here, the way companies are grouped (read.ts).
  const found = await db
    .prepare("SELECT * FROM contacts WHERE archived = 0 AND business IS NOT NULL ORDER BY created_at, id")
    .all<ContactRow>();
  return found.results.find((row) => businessKey(row.business) === key) ?? null;
}

export async function addLead(ctx: Ctx, input: NewLeadInput): Promise<AddLeadResult> {
  const { db } = ctx;
  const business = clean(input.business);
  const name = clean(input.name) ?? business;
  if (name === null) throw new UserError("A lead needs a name or a business.");
  const email = clean(input.email);
  if (email !== null) {
    checkEmail(email);
    const other = await findContactByEmail(db, email);
    if (other) {
      throw new UserError(
        `${capitalize(contactRef(other))} already uses that email. ` +
          "Give them a lead status with update_contact, or use add_deal if they want something.",
      );
    }
  } else if (business !== null && input.allowDuplicate !== true) {
    const other = await sameBusiness(db, business);
    if (other) {
      throw new UserError(`${capitalize(contactRef(other))} already has that business. Say allowDuplicate: true to add another lead anyway.`);
    }
  }
  const fields = withoutNulls(input.fields ?? {});
  await checkFieldValues(db, "contact", fields);

  const now = ctx.now.toISOString();
  const contact: ContactRow = {
    id: newId("ct"),
    name,
    email,
    phone: clean(input.phone),
    business,
    source: clean(input.source),
    notes: null,
    fields: JSON.stringify(fields),
    untrusted_fields: "[]",
    archived: 0,
    version: 1,
    created_at: now,
    updated_at: now,
    lead_status: "new",
    lead_status_at: now,
  };
  const changes: RowChange[] = [{ table: "contacts", id: contact.id, before: null, after: contact }];
  const notes = clean(input.notes);
  if (notes !== null) {
    const note: ActivityRow = {
      id: newId("ac"),
      deal_id: null,
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
  const from = contact.source === null ? "" : `, from ${contact.source}`;
  const summary = `Added lead ${name} (${LEAD_STATUS_LABELS.new})${from}`;
  const result = await commitWithEmail(ctx, { target: { table: "contacts", id: contact.id }, summary, changes }, email);
  return { ...result, contactId: contact.id };
}
