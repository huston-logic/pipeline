// The board's lead posts (decisions 0022, 0028): Add a lead, a lead's status, Qualify and Back to leads. Each calls the
// service the matching MCP tool calls, as the owner under that tool's name, and answers 303 with ?change=. A refused
// post draws its form again (422) with the values kept; Back to leads asks first, because it archives the deal.
import type { DealRow } from "../db/db.ts";
import { getContact, getDeal, listFieldDefs, listStages } from "../db/queries.ts";
import { isContactId, isDealId } from "../ids.ts";
import { updateContact } from "../services/contacts.ts";
import { UserError } from "../services/errors.ts";
import type { LeadStatus } from "../services/lead-status.ts";
import { addLead, DuplicateLeadError, type NewLeadInput, qualifyLead, type QualifyInput, returnToLead } from "../services/leads.ts";
import {
  type ActionContext,
  type ActionResult,
  asOwner,
  backTo,
  fieldError,
  notFound,
  page,
  pageContext,
  redirect,
  refusal,
  refusedFormPage,
  refusedPage,
  type Route,
  stateOf,
} from "./action-kit.ts";
import { hidden, postForm, RETURN_FIELD } from "./forms.ts";
import { html } from "./html.ts";
import { field } from "./inputs.ts";
import { renderPage } from "./layout.ts";
import { addReturn, qualifyPath, qualifySpecs, returnAction, STATUS_OPTIONS, statusMenu, statusSpecs } from "./lead-forms.ts";
import { ALLOW_DUPLICATE, LEAD_PATH, leadPage } from "./pages/lead-new.ts";
import { canQualify, CREATE_DEAL, qualifyPage } from "./pages/qualify.ts";
import { contactHref, dealHref } from "./parts.ts";
import { collectNew, line, newLeadSpecs, parseValue } from "./record-form.ts";
import { withChange } from "./return-to.ts";

/** POST /leads/new: add_lead. Then the new lead's page. */
async function newLead(ctx: ActionContext): Promise<ActionResult> {
  const collected = collectNew(newLeadSpecs(await listFieldDefs(ctx.db)), ctx.form);
  const cancel = addReturn(ctx.form.get(RETURN_FIELD), "/leads");
  const allow = ctx.form.get(ALLOW_DUPLICATE) === "yes";
  const input = collected.input as Omit<NewLeadInput, "allowDuplicate">;
  if (collected.errors.length === 0 && input.name === undefined && input.business === undefined) {
    fieldError(collected, "name", "Give a name or a business.");
  }
  const refused = async (offerAnyway = false) =>
    page(422, await leadPage(pageContext(ctx, LEAD_PATH), stateOf(collected), cancel, offerAnyway || allow ? { checked: allow } : undefined));
  if (collected.errors.length > 0) return refused();
  try {
    const result = await addLead(asOwner(ctx, "add_lead"), { ...input, allowDuplicate: allow });
    return redirect(withChange(contactHref(result.contactId), result.changeId));
  } catch (error) {
    if (error instanceof DuplicateLeadError) {
      const message =
        error.by === "email"
          ? `${error.who} already uses that email, so they are on file already.`
          : `${error.who} already has that business. Tick Add anyway to add another lead.`;
      fieldError(collected, error.by, message);
      return refused(error.by === "business");
    }
    collected.errors.push({ message: refusal(error, "lead") });
    return refused();
  }
}

/** The lead a status or Qualify post is for: an unqualified lead who is not archived, or null. */
async function leadOf(ctx: ActionContext, id: string) {
  const contact = isContactId(id) ? await getContact(ctx.db, id) : null;
  return canQualify(contact) ? contact : null;
}

const NOT_NOW_ONLY = "A check-back date only goes with Not now. Choose Not now, or clear the date.";

/** POST /contacts/<id>/lead-status: update_contact with the status and, for Not now, a check-back date. No confirm. */
async function saveStatus(ctx: ActionContext, id: string): Promise<ActionResult> {
  const contact = await leadOf(ctx, id);
  if (contact === null) return notFound(ctx);
  const back = backTo(ctx, contactHref(contact.id));
  const collected = collectNew(statusSpecs(), ctx.form);
  const input = collected.input as { leadStatus?: LeadStatus; followUpDate?: string };
  if (collected.errors.length === 0 && input.leadStatus === undefined) fieldError(collected, "lead_status", "Choose a lead status.");
  if (collected.errors.length === 0 && input.followUpDate !== undefined && input.leadStatus !== "not_now") {
    fieldError(collected, "follow_up", NOT_NOW_ONLY);
  }
  const current = contact.lead_status as LeadStatus;
  const refused = () =>
    page(
      422,
      refusedFormPage(ctx, "The lead status wasn't changed", statusMenu(contact.id, current, { csrf: ctx.csrf, here: back }, stateOf(collected)), back, contactHref(contact.id)),
    );
  if (collected.errors.length > 0) return refused();
  try {
    const result = await updateContact(asOwner(ctx, "update_contact"), contact.id, input);
    return redirect(withChange(back, result.changeId));
  } catch (error) {
    collected.errors.push({ message: refusal(error, "lead") });
    return refused();
  }
}

const DETAILS_WITHOUT_DEAL = "Deal details only go with a deal. Tick Create a deal, or clear the deal details.";

/** POST /contacts/<id>/qualify: qualify_lead, with a deal when Create a deal is ticked. Then the deal, or the person. */
async function qualify(ctx: ActionContext, id: string): Promise<ActionResult> {
  const contact = await leadOf(ctx, id);
  if (contact === null) return notFound(ctx);
  const createDeal = ctx.form.get(CREATE_DEAL) === "yes";
  const collected = collectNew(qualifySpecs(await listStages(ctx.db)), ctx.form);
  const { stage, ...details } = collected.input as Omit<QualifyInput, "contact" | "createDeal">;
  if (!createDeal && Object.keys(details).length > 0) collected.errors.push({ message: DETAILS_WITHOUT_DEAL });
  const refused = async () =>
    page(422, (await qualifyPage(pageContext(ctx, qualifyPath(contact.id)), contact.id, stateOf(collected), createDeal)) ?? "");
  if (collected.errors.length > 0) return refused();
  try {
    const result = await qualifyLead(asOwner(ctx, "qualify_lead"), {
      contact: contact.id,
      createDeal,
      ...(createDeal ? { stage, ...details } : {}),
    });
    const home = result.dealId === null ? contactHref(contact.id) : dealHref(result.dealId);
    return redirect(withChange(home, result.changeId));
  } catch (error) {
    collected.errors.push({ message: refusal(error, "lead") });
    return refused();
  }
}

const returnStatusSpec = line("status", "Lead status", "choice", "contact", { options: STATUS_OPTIONS });

function returnConfirmPage(ctx: ActionContext, deal: DealRow, back: string): string {
  return renderPage({
    title: "Confirm: move back to leads",
    description: "Moving a deal back to leads asks first. Confirm it, or keep the deal.",
    current: dealHref(deal.id),
    frame: { look: ctx.look },
    body: html`<h1>Move back to leads?</h1>
<p class="lede">This archives the deal and makes the person a lead again. Their notes, timeline and tasks stay. You can undo it.</p>
${postForm(
  "confirm",
  returnAction(deal.id),
  { csrf: ctx.csrf, here: back },
  html`${hidden("confirm", "yes")}
<div class="confirm-field">${field({ id: "return-status", name: "status", label: "Lead status", kind: "choice", value: "contacted", options: STATUS_OPTIONS })}</div>
<div class="confirm-actions">
<button class="button" type="submit">Move back to leads</button>
<a class="confirm-cancel" href="${back}">Keep the deal</a>
</div>`,
)}`,
  });
}

/**
 * POST /deals/<id>/return-to-lead: return_to_lead. Without confirm=yes it asks first (it archives the deal). A Won or
 * archived deal is never offered it; a post for one goes straight to the service, which says why not.
 */
async function backToLeads(ctx: ActionContext, id: string): Promise<ActionResult> {
  const deal = isDealId(id) ? await getDeal(ctx.db, id) : null;
  if (deal === null) return notFound(ctx);
  const back = backTo(ctx, dealHref(deal.id));
  const offered = deal.archived === 0 && deal.status !== "won";
  if (offered && ctx.form.get("confirm") !== "yes") return page(200, returnConfirmPage(ctx, deal, back));
  try {
    // No status (or a blank one) is the service's default, Contacted.
    const parsed = parseValue(returnStatusSpec, ctx.form.get("status") ?? "");
    if (!parsed.ok) throw new UserError(`${parsed.message} The lead statuses are New, Contacted, Not now, Not a fit and Bad lead.`);
    const status = parsed.value === null ? undefined : (parsed.value as LeadStatus);
    const result = await returnToLead(asOwner(ctx, "return_to_lead"), { deal: deal.id, status });
    return redirect(withChange(contactHref(result.contactId), result.changeId));
  } catch (error) {
    return page(422, refusedPage(ctx, "The deal wasn't moved back to leads", refusal(error, "deal"), back, "", dealHref(deal.id)));
  }
}

export const LEAD_ROUTES: Route[] = [
  { path: /^\/leads\/(new)$/, handle: (ctx) => newLead(ctx), big: true },
  { path: /^\/contacts\/([^/]+)\/lead-status$/, handle: saveStatus },
  { path: /^\/contacts\/([^/]+)\/qualify$/, handle: qualify, big: true },
  { path: /^\/deals\/([^/]+)\/return-to-lead$/, handle: backToLeads },
];
