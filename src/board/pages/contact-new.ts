// /contacts/new: Add contact (add_contact, decision 0041), a person with any person status and no deal: someone who is
// neither a lead to approach nor a deal. Reached from the Add contact button on Contacts.
import { listFieldDefs } from "../../db/queries.ts";
import { listPersonStatuses } from "../../services/person-status.ts";
import type { PageContext } from "../context.ts";
import { addCancel, backText } from "../lead-forms.ts";
import { personStatusSpecs } from "../person-status-form.ts";
import { contactSpecs, type Shown, type Spec } from "../record-form.ts";
import { type FormState, recordFormPage } from "./record-page.ts";

export const CONTACT_PATH = "/contacts/new";

/** The Add contact form's fields, the same for drawing it and reading a post. */
export async function newContactSpecs(db: PageContext["db"]): Promise<Spec[]> {
  const [defs, statuses] = await Promise.all([listFieldDefs(db), listPersonStatuses(db)]);
  return contactSpecs(defs, { status: personStatusSpecs(statuses) });
}

/** A new form starts as a Contact with no sub-status. */
const fresh = () => new Map<string, Shown>([["person_status", { value: "contact", outside: false }]]);

export async function contactNewPage(ctx: PageContext, state?: FormState, cancel = addCancel(ctx.query.get("from"), "/contacts")): Promise<string> {
  return recordFormPage(ctx, {
    title: "Add contact",
    description: "Add someone who is neither a lead nor a deal, with their person status.",
    heading: "Add contact",
    lede: "Someone who isn't a lead to approach or a deal, such as a partner. Pick their person status.",
    current: CONTACT_PATH,
    back: { href: cancel, text: backText(cancel) },
    action: CONTACT_PATH,
    cancel,
    submit: "Add the contact",
    prefix: "contact",
    groups: [{ specs: await newContactSpecs(ctx.db) }],
    shown: state?.shown ?? fresh(),
    errors: state?.errors ?? [],
  });
}
