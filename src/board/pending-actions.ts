// The Pending changes posts (run 10, area 5), listed in the route table in actions.ts. Approve is apply_changes as the
// owner (the board is where approval happens, so no refuseOnBoard); Discard drops the list (scratch space, not audited);
// the setting form is update_settings as the owner.
import { parseOwnerEmailsVar } from "../auth/owners.ts";
import { isProposalId } from "../ids.ts";
import { UserError } from "../services/errors.ts";
import { applyChanges, discardProposal } from "../services/proposals.ts";
import { updateSettings } from "../services/settings.ts";
import { type ActionContext, type ActionResult, asOwner, notFound, page, redirect, refusedPage, type Route } from "./action-kit.ts";
import { PENDING_PATH } from "./pages/pending.ts";
import { withChange } from "./return-to.ts";

const refused = (ctx: ActionContext, title: string, error: unknown): ActionResult => {
  if (!(error instanceof UserError)) throw error;
  return page(422, refusedPage(ctx, title, error.message, PENDING_PATH, "", PENDING_PATH));
};

async function approve(ctx: ActionContext, id: string): Promise<ActionResult> {
  if (!isProposalId(id)) return notFound(ctx);
  try {
    const result = await applyChanges(asOwner(ctx, "apply_changes"), id, { extraOwnerEmails: parseOwnerEmailsVar(ctx.env.OWNER_EMAILS) });
    // An already-applied list answers its first change: nothing was written now, so no banner for it.
    return redirect(result.applied === 0 ? PENDING_PATH : withChange(PENDING_PATH, result.changeId));
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
