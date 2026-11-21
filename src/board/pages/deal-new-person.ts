// /deals/new: a person and their first deal (add_deal), reached from the Add a deal button on Today, Pipeline and
// Contacts (decision 0028; it was /leads/new before). ?from= says which of those Cancel goes back to.
import { listFieldDefs } from "../../db/queries.ts";
import type { PageContext } from "../context.ts";
import { addCancel, backText } from "../lead-forms.ts";
import { personDealSpecs } from "../record-form.ts";
import { type FormState, recordFormPage } from "./record-page.ts";

export const PERSON_DEAL_PATH = "/deals/new";

export async function personDealPage(ctx: PageContext, state?: FormState, cancel = addCancel(ctx.query.get("from"), "/pipeline")): Promise<string> {
  const specs = personDealSpecs(await listFieldDefs(ctx.db));
  return recordFormPage(ctx, {
    title: "Add a deal",
    description: "Add a person and their first deal to the pipeline.",
    heading: "Add a deal",
    lede: "Add a person and their first deal, in the first open stage. If the email matches someone you have, the deal is added to them.",
    current: PERSON_DEAL_PATH,
    back: { href: cancel, text: backText(cancel) },
    action: PERSON_DEAL_PATH,
    cancel,
    submit: "Add the deal",
    prefix: "deal",
    groups: [
      { heading: "Contact", id: "deal-contact-heading", specs: specs.filter((spec) => spec.group === "contact") },
      { heading: "Deal", id: "deal-deal-heading", specs: specs.filter((spec) => spec.group === "deal") },
    ],
    shown: state?.shown ?? new Map(),
    errors: state?.errors ?? [],
  });
}
