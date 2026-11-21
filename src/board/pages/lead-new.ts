// /leads/new: Add a lead (add_lead, decision 0028), someone the owner plans to approach, with no deal. Reached from the
// Add a lead button on Today, Pipeline, Contacts and Leads; ?from= says which of those Cancel goes back to. A business
// already on file is refused with an "Add anyway" box (allow_duplicate).
import { listFieldDefs } from "../../db/queries.ts";
import type { PageContext } from "../context.ts";
import { checkbox } from "../inputs.ts";
import { addCancel, backText } from "../lead-forms.ts";
import { newLeadSpecs } from "../record-form.ts";
import { type FormState, recordFormPage } from "./record-page.ts";

export const LEAD_PATH = "/leads/new";

export const ALLOW_DUPLICATE = "allow_duplicate";

/** `anyway` draws the Add anyway box (after a business match), ticked or not. */
export async function leadPage(
  ctx: PageContext,
  state?: FormState,
  cancel = addCancel(ctx.query.get("from"), "/leads"),
  anyway?: { checked: boolean },
): Promise<string> {
  const specs = newLeadSpecs(await listFieldDefs(ctx.db));
  const box =
    anyway === undefined ? undefined : checkbox({ id: "lead-allow_duplicate", name: ALLOW_DUPLICATE, label: "Add anyway", value: "yes", checked: anyway.checked });
  return recordFormPage(ctx, {
    title: "Add a lead",
    description: "Add someone you plan to approach. A lead has no deal yet.",
    heading: "Add a lead",
    lede: "Someone you plan to approach who hasn't asked for anything yet. They start as New.",
    current: LEAD_PATH,
    back: { href: cancel, text: backText(cancel) },
    action: LEAD_PATH,
    cancel,
    submit: "Add the lead",
    prefix: "lead",
    groups: [{ specs, after: box }],
    shown: state?.shown ?? new Map(),
    errors: state?.errors ?? [],
  });
}
