// Board write routes (decisions 0014, 0017): every POST the board accepts is listed here, and each handler calls the
// same service function as the matching MCP tool, as the owner. src/board/post.ts runs the sign-in, origin, body and
// CSRF checks before any handler sees the form.
import type { DealRow, StageRow } from "../db/db.ts";
import { getContact, getDeal, listStages } from "../db/queries.ts";
import { isChangeId, isDealId } from "../ids.ts";
import type { Ctx } from "../services/change.ts";
import { updateDeal } from "../services/deals.ts";
import { UserError } from "../services/errors.ts";
import { dealLabel, isTrusted } from "../services/labels.ts";
import { findStage } from "../services/lookup.ts";
import { undoChange } from "../services/undo.ts";
import { type FormContext, hidden, postForm, RETURN_FIELD } from "./forms.ts";
import { html, type Html } from "./html.ts";
import { type Look, renderPage } from "./layout.ts";
import { moveAction, moveForm, safeDealName } from "./move.ts";
import { notFoundPage } from "./pages/not-found.ts";
import { dealHref } from "./parts.ts";
import { boardReturnPath, withChange } from "./return-to.ts";

/** What a handler gets once every check has passed. `csrf` is the request's (checked) token, for the forms it draws. */
export interface ActionContext {
  db: Ctx["db"];
  now: Date;
  csrf: string;
  form: URLSearchParams;
  look: Look;
}

export type ActionResult = { kind: "redirect"; location: string } | { kind: "page"; status: 200 | 404 | 422; body: string };

export type BoardAction = (ctx: ActionContext) => Promise<ActionResult>;

type Route = { path: RegExp; handle: (ctx: ActionContext, id: string) => Promise<ActionResult> };

const asOwner = (ctx: ActionContext, tool: string): Ctx => ({ db: ctx.db, now: ctx.now, actor: "owner", tool });

const redirect = (location: string): ActionResult => ({ kind: "redirect", location });

const page = (status: 200 | 404 | 422, body: string): ActionResult => ({ kind: "page", status, body });

const notFound = (ctx: ActionContext): ActionResult => page(404, notFoundPage({ look: ctx.look }));

/** Where to come back to: the form's return_to when it is a board page, else the record's own page. */
const backTo = (ctx: ActionContext, fallback: string): string => boardReturnPath(ctx.form.get(RETURN_FIELD)) ?? fallback;

/**
 * A refused write: the plain-English reason, the form again when there is one, and the way back. `current` is the
 * record's page, so the nav marks its section (a deal is in Pipeline).
 */
function refusedPage(ctx: ActionContext, title: string, message: string, back: string, form: Html | "", current?: string): string {
  return renderPage({
    title,
    description: "The change was refused, so nothing was changed. The reason is on the page.",
    current,
    frame: { look: ctx.look },
    body: html`<h1>${title}</h1>
<p class="lede refusal">${message}</p>
${form === "" ? "" : html`<div class="card refused-form">${form}</div>`}
<p class="back-link"><a href="${back}">Back to the page</a></p>`,
  });
}

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

/** POST /changes/<id>/undo: undo_change, as the owner. */
async function undo(ctx: ActionContext, id: string): Promise<ActionResult> {
  if (!isChangeId(id)) return notFound(ctx);
  const back = backTo(ctx, "/changes");
  try {
    const result = await undoChange(asOwner(ctx, "undo_change"), id);
    return redirect(withChange(back, result.changeId));
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    return page(422, refusedPage(ctx, "That change wasn't undone", error.message, back, ""));
  }
}

const ROUTES: Route[] = [
  { path: /^\/deals\/([^/]+)\/move$/, handle: moveDeal },
  { path: /^\/changes\/([^/]+)\/undo$/, handle: undo },
];

/** The handler for a board write path, or null: every other POST keeps the 405 answer. */
export function matchBoardAction(pathname: string): BoardAction | null {
  for (const route of ROUTES) {
    const id = route.path.exec(pathname)?.[1];
    if (id !== undefined) return (ctx) => route.handle(ctx, id);
  }
  return null;
}
