// /contacts/<id>/edit: the contact's details and custom fields (update_contact). Only the fields the owner changes
// are saved (decision 0018), so a value from outside keeps its label until the owner changes it.
import type { ContactRow } from "../../db/db.ts";
import { getContact, listFieldDefs } from "../../db/queries.ts";
import { contactName, isTrusted } from "../../services/labels.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import type { PageContext } from "../context.ts";
import { contactHref } from "../parts.ts";
import { contactSpecs, editShown } from "../record-form.ts";
import { anyOutside } from "../record-fields.ts";
import { type FormState, recordFormPage } from "./record-page.ts";

export const contactEditPath = (id: string): string => `${contactHref(id)}/edit`;

/** "Pat Example", or "contact ct_…" when the name came from outside. */
const safeName = (contact: ContactRow) => (isTrusted(contact, "name") ? contact.name : contactName(contact));

export const OUTSIDE_STAYS = "A value marked From outside stays marked until you change it.";

export async function contactEditPage(ctx: PageContext, id: string, state?: FormState): Promise<string | null> {
  const contact = await getContact(ctx.db, id);
  if (contact === null) return null;
  const specs = contactSpecs(await listFieldDefs(ctx.db));
  const shown = state?.shown ?? (await editShown(specs, contact, await ownerTimezone(ctx.db)));
  const name = safeName(contact);
  const back = contactHref(contact.id);
  return recordFormPage(ctx, {
    title: `Edit ${name}`,
    description: `Change the details and custom fields of ${name}.`,
    heading: `Edit ${name}`,
    lede: anyOutside(shown) ? `Change what you need and save. ${OUTSIDE_STAYS}` : "Change what you need and save.",
    current: contactEditPath(contact.id),
    back: { href: back, text: "Back to the contact" },
    action: contactEditPath(contact.id),
    cancel: back,
    submit: "Save changes",
    prefix: "contact",
    groups: [{ specs }],
    shown,
    errors: state?.errors ?? [],
  });
}
