// The Pending changes posts (run 10, area 5), listed in the route table in actions.ts. Approve is apply_changes as the
// owner (the board is where approval happens, so no refuseOnBoard); Discard drops the list (scratch space, not audited);
// the setting form is update_settings as the owner.
import { parseOwnerEmailsVar } from "../auth/owners.ts";
import { isProposalId } from "../ids.ts";
import { UserError } from "../services/errors.ts";
import { AGAIN, applyChanges, discardProposal } from "../services/proposals.ts";
import { startProjectOffers } from "../services/won-offers.ts";
import { updateSettings } from "../services/settings.ts";
import { type ActionContext, type ActionResult, asOwner, notFound, page, redirect, refusedPage, type Route } from "./action-kit.ts";
import { PENDING_PATH } from "./pages/pending.ts";
import { newProjectOfDealPath } from "./project-form.ts";
import { withChange } from "./return-to.ts";

/** A service refusal speaks to the AI app; here the owner reads it, so the next step is to ask the AI app. */
export function boardWording(message: string): string {
  if (!message.endsWith(AGAIN)) return message;
  if (message.includes("changed since this list was made")) return "This list changed since it was made. Ask your AI app for a new one.";
  return `${message.slice(0, -AGAIN.length)}Ask your AI app for a new list.`;
}

const refused = (ctx: ActionContext, title: string, error: unknown): ActionResult => {
  if (!(error instanceof UserError)) throw error;
  return page(422, refusedPage(ctx, title, boardWording(error.message), PENDING_PATH, "", PENDING_PATH));
};

async function approve(ctx: ActionContext, id: string): Promise<ActionResult> {
  if (!isProposalId(id)) return notFound(ctx);
  try {
    const result = await applyChanges(asOwner(ctx, "apply_changes"), id, { extraOwnerEmails: parseOwnerEmailsVar(ctx.env.OWNER_EMAILS) });
    // An already-applied list answers its first change: nothing was written now, so no banner for it.
    if (result.applied === 0) return redirect(PENDING_PATH);
    // One deal won and no live project: go on to Start a project, as moving a deal to Won does.
    const [won] = result.wonDeals;
    if (won !== undefined && result.wonDeals.length === 1 && (await startProjectOffers(ctx.db, [won])).length === 1) {
      return redirect(withChange(newProjectOfDealPath(won), result.changeId));
    }
    return redirect(withChange(PENDING_PATH, result.changeId));
  } catch (error) {
    return refused(ctx, "The list wasn't approved", error);
  }
}

async function discard(ctx: ActionContext, id: string): Promise<ActionResult> {
  if (!isProposalId(id)) return notFound(ctx);
  try {
    await discardProposal(ctx.db, id, ctx.now);
    return redirect(PENDING_PATH);
  } catch (error) {
    return refused(ctx, "The list wasn't discarded", error);
  }
}

async function setApproval(ctx: ActionContext): Promise<ActionResult> {
  const chosen = ctx.form.get("approve_in");
  try {
    if (chosen !== "chat" && chosen !== "board") throw new UserError("Choose where AI changes are approved: in chat, or on the board only.");
    const result = await updateSettings(asOwner(ctx, "update_settings"), { approveIn: chosen });
    return redirect(withChange(PENDING_PATH, result.changeId));
  } catch (error) {
    return refused(ctx, "The setting wasn't saved", error);
  }
}

export const PENDING_ROUTES: Route[] = [
  { path: /^\/pending\/([^/]+)\/approve$/, handle: approve },
  { path: /^\/pending\/([^/]+)\/discard$/, handle: discard },
  { path: /^\/pending\/(approval)$/, handle: (ctx) => setApproval(ctx) },
];
