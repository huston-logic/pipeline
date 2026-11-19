// /contacts/<id>/deals/new: another deal for a contact already on file (add_lead with the contact, decision 0018).
import type { FieldDefRow } from "../../db/db.ts";
import { getContact, listFieldDefs } from "../../db/queries.ts";
import { contactName } from "../../services/labels.ts";
import type { PageContext } from "../context.ts";
import { contactHref } from "../parts.ts";
import { dealSpecs, type Spec } from "../record-form.ts";
import { type FormState, recordFormPage } from "./record-page.ts";

export const newDealPath = (contactId: string): string => `${contactHref(contactId)}/deals/new`;

/** add_lead takes the title as dealTitle. */
export const newDealSpecs = (defs: FieldDefRow[]): Spec[] => dealSpecs(defs, { titleRequired: true, notes: true, titleProp: "dealTitle" });

export async function newDealPage(ctx: PageContext, contactId: string, state?: FormState): Promise<string | null> {
  const contact = await getContact(ctx.db, contactId);
  if (contact === null) return null;
  const specs = newDealSpecs(await listFieldDefs(ctx.db));
  const name = contactName(contact);
  const back = contactHref(contact.id);
  return recordFormPage(ctx, {
    title: `New deal for ${name}`,
    description: `Add another deal for ${name}, in the first open stage.`,
    heading: `New deal for ${name}`,
    lede: "It goes in the first open stage. Their contact details stay as they are.",
    current: newDealPath(contact.id),
    back: { href: back, text: "Back to the contact" },
    action: newDealPath(contact.id),
    cancel: back,
    submit: "Add the deal",
    prefix: "deal",
    groups: [{ specs }],
    shown: state?.shown ?? new Map(),
    errors: state?.errors ?? [],
  });
}
