// Board write routes (decisions 0014, 0017): every POST the board accepts is listed here, and each handler calls the
// same service function as the matching MCP tool, as the owner. src/board/post.ts runs the sign-in, origin, body and
// CSRF checks before any handler sees the form. The editing routes (decision 0018) are in edit-actions.ts.
import type { DealRow, StageRow } from "../db/db.ts";
import { getContact, getDeal, listStages } from "../db/queries.ts";
import { isChangeId, isDealId } from "../ids.ts";
import { updateDeal } from "../services/deals.ts";
import { UserError } from "../services/errors.ts";
import { dealLabel, dealTitle, isTrusted } from "../services/labels.ts";
import { findStage } from "../services/lookup.ts";
import { getChange } from "../services/read.ts";
import { type Removal, undoChange, undoRemovals } from "../services/undo.ts";
import { joinAnd } from "../services/describe.ts";
import { canUndo, undoAction } from "./banner.ts";
import { MAX_BODY_BYTES, RECORD_FORM_MAX_BYTES } from "../http/limits.ts";
import { type ActionContext, type ActionResult, asOwner, backTo, type MatchedAction, notFound, page, redirect, refusedPage, type Route } from "./action-kit.ts";
import { isUnqualified } from "../services/lead-status.ts";
import { EDIT_ROUTES } from "./edit-actions.ts";
import { PUSH_ROUTES } from "./push-actions.ts";
import { type FormContext, hidden, postForm } from "./forms.ts";
import { html } from "./html.ts";
import { renderPage } from "./layout.ts";
import { LEAD_ROUTES } from "./lead-actions.ts";
import { moveAction, moveForm, safeDealName } from "./move.ts";
import { contactHref, count, dealHref } from "./parts.ts";
import { withChange } from "./return-to.ts";

function confirmPage(ctx: ActionContext, deal: DealRow, label: string, stage: StageRow, back: string): string {
  const form: FormContext = { csrf: ctx.csrf, here: back };
  return renderPage({
    title: `Confirm: mark as ${stage.label}`,
    description: "Closing a deal asks first. Confirm the move, or cancel to go back.",
    current: dealHref(deal.id),
    frame: { look: ctx.look },
    body: html`<h1>Mark ${label} as ${stage.label}?</h1>
<p class="lede">This closes the deal. You can undo it straight after.</p>
${postForm(
  "confirm",
  moveAction(deal.id),
  form,
  html`${hidden("stage", stage.key)}${hidden("confirm", "yes")}
<div class="confirm-actions">
<button class="button" type="submit">Mark as ${stage.label}</button>
<a class="confirm-cancel" href="${back}">Cancel</a>
</div>`,
)}`,
  });
}

/** POST /deals/<id>/move: update_deal with the stage. Won, Lost and Not now need confirm=yes, or ask first. */
async function moveDeal(ctx: ActionContext, id: string): Promise<ActionResult> {
  const deal = isDealId(id) ? await getDeal(ctx.db, id) : null;
  if (deal === null) return notFound(ctx);
  const back = backTo(ctx, dealHref(deal.id));
  const asked = (ctx.form.get("stage") ?? "").trim();
  try {
    if (asked === "") throw new UserError("Choose a stage to move the deal to.");
    const stage = await findStage(ctx.db, asked);
    // Checked before the confirm step, so a deal that is already Won is never asked "Mark as Won?".
    if (stage.key === deal.stage_key) throw new UserError(`${dealTitle(deal)} is already in ${stage.label}.`);
    if (stage.kind !== "open" && ctx.form.get("confirm") !== "yes") {
      const contact = await getContact(ctx.db, deal.contact_id);
      if (!contact) throw new Error(`Deal ${deal.id} points at a missing contact.`);
      return page(200, confirmPage(ctx, deal, dealLabel(deal, contact), stage, back));
    }
    const result = await updateDeal(asOwner(ctx, "update_deal"), deal.id, { stage: stage.key });
    return redirect(withChange(back, result.changeId));
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    const stages = await listStages(ctx.db);
    const name = safeDealName(deal.id, deal.title, !isTrusted(deal, "title"));
    const form = moveForm({ id: deal.id, name, stageKey: deal.stage_key }, stages, { csrf: ctx.csrf, here: back }, { selected: asked });
    return page(422, refusedPage(ctx, "The deal wasn't moved", error.message, back, form, dealHref(deal.id)));
  }
}

const REMOVED_NOUNS: Record<Removal["table"], [string, string]> = {
  contacts: ["contact", "contacts"],
  deals: ["deal", "deals"],
  tasks: ["task", "tasks"],
  activities: ["activity", "activities"],
};

/** "1 contact, 1 deal and 1 activity": counts only, so no record's text (outside or not) is shown. */
const removedText = (removals: Removal[]) =>
  joinAnd(removals.map(({ table, count: n }) => count(n, ...REMOVED_NOUNS[table])));

function undoConfirmPage(ctx: ActionContext, changeId: string, removals: Removal[], back: string): string {
  return renderPage({
    title: "Confirm: undo a change",
    description: "Undoing this change removes records, so it asks first. Confirm the undo, or cancel to go back.",
    frame: { look: ctx.look },
    body: html`<h1>Undo this change?</h1>
<p class="lede">It removes ${removedText(removals)}. This can't be reversed.</p>
${postForm(
  "confirm",
  undoAction(changeId),
  { csrf: ctx.csrf, here: back },
  html`${hidden("confirm", "yes")}
<div class="confirm-actions">
<button class="button" type="submit">Undo the change</button>
<a class="confirm-cancel" href="${back}">Cancel</a>
</div>`,
)}`,
  });
}

/**
 * POST /changes/<id>/undo: undo_change, as the owner. An undo that would remove contacts, deals, tasks or activities
 * (the change added them) needs confirm=yes, or asks first; one that only puts values back is one click.
 */
async function undo(ctx: ActionContext, id: string): Promise<ActionResult> {
  if (!isChangeId(id)) return notFound(ctx);
  const back = backTo(ctx, "/changes");
  try {
    if (ctx.form.get("confirm") !== "yes") {
      const change = await getChange(ctx.db, id);
      const removals = change !== null && canUndo(change) ? await undoRemovals(ctx.db, id) : [];
      if (removals.length > 0) return page(200, undoConfirmPage(ctx, id, removals, back));
    }
    const home = await homeIfRemoved(ctx, back);
    const result = await undoChange(asOwner(ctx, "undo_change"), id);
    return redirect(withChange(await home(), result.changeId));
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    return page(422, refusedPage(ctx, "That change wasn't undone", error.message, back, ""));
  }
}

/**
 * An undo can remove the record the page was about (a new deal, a new lead). Read before the undo, this says where to
 * go after it instead of a 404: a removed deal's person when they are still there (an undone Qualify), else Pipeline;
 * a removed lead's list, Leads; any other removed person, Contacts.
 */
async function homeIfRemoved(ctx: ActionContext, back: string): Promise<() => Promise<string>> {
  const record = /^\/(deals|contacts)\/([^/?]+)/.exec(back);
  if (record === null) return async () => back;
  const [, kind, id = ""] = record;
  if (kind === "deals") {
    const deal = await getDeal(ctx.db, id);
    return async () => {
      if (deal === null || (await getDeal(ctx.db, id)) !== null) return back;
      return (await getContact(ctx.db, deal.contact_id)) !== null ? contactHref(deal.contact_id) : "/pipeline";
    };
  }
  const contact = await getContact(ctx.db, id);
  return async () => {
    if (contact === null || (await getContact(ctx.db, id)) !== null) return back;
    return isUnqualified(contact.lead_status) ? "/leads" : "/contacts";
  };
}

const ROUTES: Route[] = [
  { path: /^\/deals\/([^/]+)\/move$/, handle: moveDeal },
  { path: /^\/changes\/([^/]+)\/undo$/, handle: undo },
  ...EDIT_ROUTES,
  ...PUSH_ROUTES,
  ...LEAD_ROUTES,
];

/** The handler for a board write path and its body cap, or null: every other POST keeps the 405 answer. */
export function matchBoardAction(pathname: string): MatchedAction | null {
  for (const route of ROUTES) {
    const id = route.path.exec(pathname)?.[1];
    if (id !== undefined) return { run: (ctx) => route.handle(ctx, id), maxBytes: route.big ? RECORD_FORM_MAX_BYTES : MAX_BODY_BYTES };
  }
  return null;
}
