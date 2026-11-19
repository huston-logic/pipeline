// /leads/new: a person and their first deal (add_lead), reached from the New lead button on Today, Pipeline and
// Contacts. ?from= says which of those Cancel goes back to.
import { listFieldDefs } from "../../db/queries.ts";
import type { PageContext } from "../context.ts";
import { leadSpecs } from "../record-form.ts";
import { type FormState, recordFormPage } from "./record-page.ts";

export const LEAD_PATH = "/leads/new";

const FROM: Record<string, string> = { today: "/", pipeline: "/pipeline", contacts: "/contacts" };
const BACK: Record<string, string> = { "/": "Back to today", "/pipeline": "Back to the pipeline", "/contacts": "Back to contacts" };

/** The page the New lead button was on (?from=today, pipeline or contacts); Pipeline otherwise. */
export const leadCancel = (from: string | null): string => (from !== null && Object.hasOwn(FROM, from) ? (FROM[from] ?? "/pipeline") : "/pipeline");

/** A posted return_to, kept only when it is one of those three pages. */
export const leadReturn = (path: string | null): string => (path !== null && Object.hasOwn(BACK, path) ? path : "/pipeline");

export async function leadPage(ctx: PageContext, state?: FormState, cancel = leadCancel(ctx.query.get("from"))): Promise<string> {
  const specs = leadSpecs(await listFieldDefs(ctx.db));
  return recordFormPage(ctx, {
    title: "New lead",
    description: "Add a person and their first deal to the pipeline.",
    heading: "New lead",
    lede: "Add a person and their first deal, in the first open stage. If the email matches someone you have, the deal is added to them.",
    current: LEAD_PATH,
    back: { href: cancel, text: BACK[cancel] ?? "Back to the pipeline" },
    action: LEAD_PATH,
    cancel,
    submit: "Add the lead",
    prefix: "lead",
    groups: [
      { heading: "Contact", id: "lead-contact-heading", specs: specs.filter((spec) => spec.group === "contact") },
      { heading: "Deal", id: "lead-deal-heading", specs: specs.filter((spec) => spec.group === "deal") },
    ],
    shown: state?.shown ?? new Map(),
    errors: state?.errors ?? [],
  });
}
