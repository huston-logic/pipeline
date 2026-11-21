// /contacts/<id>/qualify: a lead becomes a contact (qualify_lead, decisions 0022, 0024 and 0028), with a deal unless
// the owner unticks "Create a deal". Only for an unqualified lead who is not archived; anyone else gets the 404 page.
import type { ContactRow } from "../../db/db.ts";
import { getContact, listStages } from "../../db/queries.ts";
import { isTrusted } from "../../services/labels.ts";
import { isUnqualified } from "../../services/lead-status.ts";
import type { PageContext } from "../context.ts";
import { checkbox } from "../inputs.ts";
import { qualifyPath, qualifySpecs } from "../lead-forms.ts";
import { contactHref } from "../parts.ts";
import { type FormState, recordFormPage } from "./record-page.ts";

export const CREATE_DEAL = "create_deal";

/** A contact the Qualify form is for: an unqualified lead who is not archived. */
export const canQualify = (contact: ContactRow | null): contact is ContactRow =>
  contact !== null && contact.archived === 0 && isUnqualified(contact.lead_status);

export async function qualifyPage(ctx: PageContext, contactId: string, state?: FormState, createDeal = true): Promise<string | null> {
  const contact = await getContact(ctx.db, contactId);
  if (!canQualify(contact)) return null;
  const specs = qualifySpecs(await listStages(ctx.db));
  // The <title> can't show the "From outside" label, so an outside name never goes there or in the heading.
  const name = isTrusted(contact, "name") ? contact.name : "this lead";
  const back = contactHref(contact.id);
  const firstStage = specs[0]?.options?.[0]?.value ?? "";
  const shown = state?.shown ?? new Map([["stage", { value: firstStage, outside: false }]]);
  return recordFormPage(ctx, {
    title: `Qualify ${name}`,
    description: "Make a lead a contact, with a deal unless you untick Create a deal.",
    heading: `Qualify ${name}`,
    lede: "They become a contact. Their notes, timeline and tasks stay.",
    current: qualifyPath(contact.id),
    back: { href: back, text: "Back to the lead" },
    action: qualifyPath(contact.id),
    cancel: back,
    submit: "Qualify",
    prefix: "qualify",
    groups: [{ specs, before: checkbox({ id: "qualify-create_deal", name: CREATE_DEAL, label: "Create a deal", value: "yes", checked: createDeal }) }],
    shown,
    errors: state?.errors ?? [],
  });
}
