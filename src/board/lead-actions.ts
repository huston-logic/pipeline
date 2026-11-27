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
import { compareField } from "./edit-state.ts";
import { field, WAS_PREFIX } from "./inputs.ts";
import { renderPage } from "./layout.ts";
import {
  addReturn,
  offersBackToLeads,
  qualifyPath,
  qualifySpecs,
  returnAction,
  statusFingerprint,
  statusOptions,
  statusMenu,
  statusSpecs,
} from "./lead-forms.ts";
import { ALLOW_DUPLICATE, LEAD_PATH, leadPage } from "./pages/lead-new.ts";
import { canQualify, CREATE_DEAL, qualifyPage } from "./pages/qualify.ts";
import { contactHref, dealHref } from "./parts.ts";
import { collectNew, line, newLeadSpecs, parseValue } from "./record-form.ts";
import { withChange } from "./return-to.ts";
import { type StatusLabels, statusLabels } from "../services/status-labels.ts";
import { joinAnd } from "../services/describe.ts";

/** POST /leads/new: add_lead. Then the new lead's page. */
async function newLead(ctx: ActionContext): Promise<ActionResult> {
  const collected = collectNew(newLeadSpecs(await listFieldDefs(ctx.db)), ctx.form);
  const cancel = addReturn(ctx.form.get(RETURN_FIELD), "/leads");
  const allow = ctx.form.get(ALLOW_DUPLICATE) === "yes";
  const input = collected.input as Omit<NewLeadInput, "allowDuplicate">;
  if (collected.errors.length === 0 && input.name === undefined && input.business === undefined) {
    fieldError(collected, "name", "Give a name or an account.");
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
          : `${error.who} already has that account. Tick Add anyway to add another lead.`;
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

const STATUS_CONFLICT = "The lead status was changed while you were saving. The form now shows the saved status; change it again if you need to.";
const NOTHING_NEW = "Nothing to change: the lead already has that status. Choose another status, or a check-back date with Not now.";

/**
 * POST /contacts/<id>/lead-status: update_contact with the status and, for Not now, a check-back date. No confirm.
 * The status is sent only when the owner changed the select (its fingerprint, `was.lead_status`, differs), so a stale
 * page never puts back a status someone else changed since; a check-back date alone still works.
 */
async function saveStatus(ctx: ActionContext, id: string): Promise<ActionResult> {
  const contact = await leadOf(ctx, id);
  if (contact === null) return notFound(ctx);
  const back = backTo(ctx, contactHref(contact.id));
  const current = contact.lead_status as LeadStatus;
  const labels = await statusLabels(ctx.db);
  const collected = collectNew(statusSpecs(labels), ctx.form);
  const parsed = collected.input as { leadStatus?: LeadStatus; followUpDate?: string };
  const was = ctx.form.get(`${WAS_PREFIX}lead_status`);
  const outcome = await compareField(ctx.form.get("lead_status"), was, current, "line");
  const status = collected.shown.get("lead_status");
  if (status !== undefined) status.was = was ?? (await statusFingerprint(current));
  if (collected.errors.length === 0 && outcome === "conflict" && status !== undefined) {
    // Show the saved status, drawn as new, so saving again starts from it.
    Object.assign(status, { value: current, was: await statusFingerprint(current) });
    fieldError(collected, "lead_status", STATUS_CONFLICT);
  }
  const input = {
    ...(outcome === "changed" && parsed.leadStatus !== undefined ? { leadStatus: parsed.leadStatus } : {}),
    ...(parsed.followUpDate !== undefined ? { followUpDate: parsed.followUpDate } : {}),
  };
  if (collected.errors.length === 0 && input.followUpDate !== undefined && (input.leadStatus ?? current) !== "not_now") {
    fieldError(collected, "follow_up", NOT_NOW_ONLY);
  }
  if (collected.errors.length === 0 && Object.keys(input).length === 0) collected.errors.push({ message: NOTHING_NEW });
  const refused = async () =>
    page(
      422,
      refusedFormPage(
        ctx,
        "The lead status wasn't changed",
        await statusMenu(contact.id, current, { csrf: ctx.csrf, here: back }, labels, stateOf(collected)),
        back,
        contactHref(contact.id),
      ),
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

const returnStatusSpec = (labels: StatusLabels) => line("status", "Lead status", "choice", "contact", { options: statusOptions(labels) });

function returnConfirmPage(ctx: ActionContext, deal: DealRow, back: string, labels: StatusLabels): string {
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
<div class="confirm-field">${field({ id: "return-status", name: "status", label: "Lead status", kind: "choice", value: "contacted", options: statusOptions(labels) })}</div>
<div class="confirm-actions">
<button class="button" type="submit">Move back to leads</button>
<a class="confirm-cancel" href="${back}">Keep the deal</a>
</div>`,
)}`,
  });
}

/**
 * POST /deals/<id>/return-to-lead: return_to_lead. Without confirm=yes it asks first (it archives the deal). A Won or
 * archived deal, or one whose person has another open deal, is never offered it; a post for one goes straight to the
 * service, which says why not, so the owner is never asked to confirm something that would be refused.
 */
async function backToLeads(ctx: ActionContext, id: string): Promise<ActionResult> {
  const deal = isDealId(id) ? await getDeal(ctx.db, id) : null;
  if (deal === null) return notFound(ctx);
  const back = backTo(ctx, dealHref(deal.id));
  const offered = await offersBackToLeads(ctx.db, { id: deal.id, contactId: deal.contact_id, status: deal.status, archived: deal.archived === 1 });
  const labels = await statusLabels(ctx.db);
  if (offered && ctx.form.get("confirm") !== "yes") return page(200, returnConfirmPage(ctx, deal, back, labels));
  try {
    // No status (or a blank one) is the service's default, Contacted.
    const parsed = parseValue(returnStatusSpec(labels), ctx.form.get("status") ?? "");
    if (!parsed.ok) {
      const names = joinAnd(statusOptions(labels).map((option) => option.label));
      throw new UserError(`${parsed.message} The lead statuses are ${names}.`);
    }
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
