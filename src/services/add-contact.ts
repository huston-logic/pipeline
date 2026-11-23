// add_contact (decision 0041): a person with any live person status (Contact unless told otherwise) and no deal, in
// one audited change. Someone the owner plans to approach is add_lead; someone who asked for something is add_deal.
import type { ContactRow } from "../db/db.ts";
import { findContactByEmail } from "../db/queries.ts";
import { newId } from "../ids.ts";
import type { ChangeResult, Ctx } from "./change.ts";
import { commitWithEmail } from "./contacts.ts";
import { capitalize, withArticle } from "./describe.ts";
import { UserError } from "./errors.ts";
import { checkFieldValues } from "./fields.ts";
import { checkEmail, clean, withoutNulls } from "./input.ts";
import { contactRef } from "./labels.ts";
import type { FieldValues } from "./lookup.ts";
import { CONTACT, newPersonColumns } from "./person-move.ts";
import { resolveMove } from "./person-status.ts";

export interface NewContactInput {
  name: string;
  email?: string;
  phone?: string;
  business?: string;
  source?: string;
  /** The contact's own notes. */
  notes?: string;
  /** A live person status, by key or label; default Contact. */
  personStatus?: string;
  /** One of its live sub-statuses, by key or label; left out, a Lead starts New and the others have none. */
  subStatus?: string | null;
  /** Contact custom field values. */
  fields?: FieldValues;
}

export async function addContact(ctx: Ctx, input: NewContactInput): Promise<ChangeResult & { contactId: string }> {
  const { db } = ctx;
  const name = clean(input.name);
  if (name === null) throw new UserError("A contact needs a name. Give the person's name.");
  const email = clean(input.email);
  if (email !== null) {
    checkEmail(email);
    const other = await findContactByEmail(db, email);
    if (other) {
      throw new UserError(`${capitalize(contactRef(other))} already uses that email. Change them with update_contact instead.`);
    }
  }
  const { status, sub, move } = await resolveMove(db, null, { status: input.personStatus ?? CONTACT, sub: input.subStatus });
  const fields = withoutNulls(input.fields ?? {});
  await checkFieldValues(db, "contact", fields);

  const now = ctx.now.toISOString();
  const contact: ContactRow = {
    id: newId("ct"),
    name,
    email,
    phone: clean(input.phone),
    business: clean(input.business),
    source: clean(input.source),
    notes: clean(input.notes),
    fields: JSON.stringify(fields),
    untrusted_fields: "[]",
    archived: 0,
    version: 1,
    created_at: now,
    updated_at: now,
    ...newPersonColumns(move, ctx.now),
  };
  const kind = `${withArticle(status.label)}${sub === null ? "" : ` (${sub.label})`}`;
  const from = contact.source === null ? "" : `, from ${contact.source}`;
  const result = await commitWithEmail(
    ctx,
    {
      target: { table: "contacts", id: contact.id },
      summary: `Added ${name} as ${kind}${from}`,
      changes: [{ table: "contacts", id: contact.id, before: null, after: contact }],
    },
    email,
  );
  return { ...result, contactId: contact.id };
}
