// The campaign review page's posts (decision 0053): approve, schedule, cancel, pause, resume, duplicate and archive, each
// as the owner under its tool's name. Approve and schedule check the Worker's sending switches again (the page may be
// old) and carry the review page's fingerprint to approveCampaign. Cancel and pause ask first. All are a 404 while
// campaigns are off. A refused post draws the review page again (422) with the sentence that says why.
import { loadCampaign, archiveCampaign, duplicateCampaign } from "../campaigns/drafts.ts";
import { approveCampaign, cancelCampaign, pauseCampaign, resumeCampaign } from "../campaigns/freeze.ts";
import { type CampaignEnv, sendingBlocker } from "../campaigns/readiness.ts";
import { sendTestEmail } from "../campaigns/test-send.ts";
import type { CampaignRow } from "../db/db.ts";
import { getSettings } from "../db/queries.ts";
import { isCampaignId } from "../ids.ts";
import { UserError } from "../services/errors.ts";
import { parseWhen } from "../time.ts";
import { type ActionContext, type ActionResult, asOwner, notFound, page, pageContext, redirect, refusal, refusedPage, type Route } from "./action-kit.ts";
import type { PageContext } from "./context.ts";
import { hidden, postForm } from "./forms.ts";
import { html } from "./html.ts";
import { renderPage } from "./layout.ts";
import { CAMPAIGNS_PATH, campaignPath } from "./pages/campaigns.ts";
import { campaignReviewPage, type ReviewState } from "./pages/campaign-review.ts";
import { withChange } from "./return-to.ts";

const campaignEnvOf = (env: ActionContext["env"]): CampaignEnv => ({
  CAMPAIGN_SENDING: env.CAMPAIGN_SENDING,
  CAMPAIGN_FROM: env.CAMPAIGN_FROM,
  CAMPAIGN_RESEND_API_KEY: env.CAMPAIGN_RESEND_API_KEY,
  CAMPAIGN_WEBHOOK_SECRET: env.CAMPAIGN_WEBHOOK_SECRET,
  OWNER_EMAILS: env.OWNER_EMAILS,
});

/** A campaign form's page context: campaigns are on (the paths 404 otherwise), so More lists Campaigns on a refused form too. */
export const campaignContext = (ctx: ActionContext, here: string): PageContext => ({
  ...pageContext(ctx, here),
  campaigns: true,
  campaignEnv: campaignEnvOf(ctx.env),
  origin: ctx.origin,
});

/** The campaign, when campaigns are on and it exists (archived ones too: the service says what it refuses). */
async function known(ctx: ActionContext, id: string): Promise<CampaignRow | null> {
  if (!isCampaignId(id) || (await getSettings(ctx.db)).campaigns !== 1) return null;
  try {
    return (await loadCampaign(ctx.db, id)).campaign;
  } catch (error) {
    if (error instanceof UserError) return null;
    throw error;
  }
}

/** A refused post: the review page again with the reason, or a plain refusal page when that page is gone (archived). */
async function refused(ctx: ActionContext, id: string, message: string, schedule?: NonNullable<ReviewState["schedule"]>): Promise<ActionResult> {
  const view = await campaignReviewPage(campaignContext(ctx, campaignPath(id)), id, { refusal: message, ...(schedule === undefined ? {} : { schedule }) });
  return page(422, view ?? refusedPage(ctx, "The campaign wasn't changed", message, CAMPAIGNS_PATH, ""));
}

/** The date and time the Schedule form posted, in the owner's timezone, or the sentence that says what is missing. */
function postedWhen(form: URLSearchParams, tz: string): Date | string {
  const date = (form.get("send_at.date") ?? "").trim();
  const time = (form.get("send_at.time") ?? "").trim();
  if (date === "") return "Pick a date to send on.";
  if (time === "") return "Pick a time to send at.";
  try {
    return parseWhen(`${date}T${time}`, tz);
  } catch (error) {
    if (error instanceof UserError) return "Pick a date and time that exist.";
    throw error;
  }
}

async function send(ctx: ActionContext, id: string, scheduled: boolean): Promise<ActionResult> {
  if ((await known(ctx, id)) === null) return notFound(ctx);
  const settings = await getSettings(ctx.db);
  // What the Schedule form was posted with, kept on the form when it is drawn again.
  const typed = (onField: boolean) => ({
    date: (ctx.form.get("send_at.date") ?? "").trim(),
    time: (ctx.form.get("send_at.time") ?? "").trim(),
    onField,
  });
  const blocker = sendingBlocker(ctx.env, settings);
  if (blocker !== null) return refused(ctx, id, blocker, scheduled ? typed(false) : undefined);
  let sendAfter = ctx.now;
  if (scheduled) {
    const at = postedWhen(ctx.form, settings.timezone);
    if (typeof at === "string") return refused(ctx, id, at, typed(true));
    sendAfter = at;
  }
  try {
    const result = await approveCampaign(asOwner(ctx, scheduled ? "campaign_schedule" : "campaign_approve"), id, {
      fingerprint: ctx.form.get("fingerprint") ?? "",
      sendAfter,
      baseUrl: ctx.origin,
      scheduled,
    });
    return redirect(withChange(campaignPath(id), result.changeId));
  } catch (error) {
    const message = refusal(error, "campaign");
    return refused(ctx, id, message, scheduled ? typed(message.startsWith("Pick a time in the next")) : undefined);
  }
}

type Stop = { tool: string; run: typeof cancelCampaign; from: CampaignRow["status"][]; title: string; question: (name: string) => string; button: string };

const STOPS: Record<"cancel" | "pause", Stop> = {
  cancel: {
    tool: "campaign_cancel",
    run: cancelCampaign,
    from: ["scheduled", "sending", "paused"],
    title: "Cancel this campaign?",
    question: (name) => `Cancel ${name}? People who haven't been sent it yet won't get it. Emails already on their way may still arrive.`,
    button: "Cancel the campaign",
  },
  pause: {
    tool: "campaign_pause",
    run: pauseCampaign,
    from: ["sending"],
    title: "Pause this campaign?",
    question: (name) => `Pause ${name}? No new emails go out until you resume. Emails already on their way may still arrive.`,
    button: "Pause the campaign",
  },
};

function confirmPage(ctx: ActionContext, campaign: CampaignRow, action: "cancel" | "pause"): string {
  const stop = STOPS[action];
  const back = campaignPath(campaign.id);
  return renderPage({
    title: `Confirm: ${action} a campaign`,
    description: "This stops a campaign, so it asks first. Confirm, or go back.",
    current: CAMPAIGNS_PATH,
    frame: { look: ctx.look, campaigns: true },
    body: html`<h1>${stop.title}</h1>
<p class="lede">${stop.question(campaign.name)}</p>
${postForm(
  "confirm",
  `${back}/${action}`,
  { csrf: ctx.csrf, here: back },
  html`${hidden("confirm", "yes")}
<div class="confirm-actions">
<button class="button" type="submit">${stop.button}</button>
<a class="confirm-cancel" href="${back}">Go back</a>
</div>`,
)}`,
  });
}

/** Cancel and Pause: asks first unless confirm=yes (and only asks when the campaign is in a state the move allows). */
async function stop(ctx: ActionContext, id: string, action: "cancel" | "pause"): Promise<ActionResult> {
  const campaign = await known(ctx, id);
  if (campaign === null) return notFound(ctx);
  const spec = STOPS[action];
  if (ctx.form.get("confirm") !== "yes" && spec.from.includes(campaign.status)) return page(200, confirmPage(ctx, campaign, action));
  try {
    const result = await spec.run(asOwner(ctx, spec.tool), id);
    return redirect(withChange(campaignPath(id), result.changeId));
  } catch (error) {
    return refused(ctx, id, refusal(error, "campaign"));
  }
}

async function resume(ctx: ActionContext, id: string): Promise<ActionResult> {
  if ((await known(ctx, id)) === null) return notFound(ctx);
  try {
    const result = await resumeCampaign(asOwner(ctx, "campaign_resume"), id);
    return redirect(withChange(campaignPath(id), result.changeId));
  } catch (error) {
    return refused(ctx, id, refusal(error, "campaign"));
  }
}

async function duplicate(ctx: ActionContext, id: string): Promise<ActionResult> {
  if ((await known(ctx, id)) === null) return notFound(ctx);
  try {
    const result = await duplicateCampaign(asOwner(ctx, "duplicate_campaign"), id);
    return redirect(withChange(campaignPath(result.campaignId), result.changeId));
  } catch (error) {
    return refused(ctx, id, refusal(error, "campaign"));
  }
}

async function archive(ctx: ActionContext, id: string): Promise<ActionResult> {
  if ((await known(ctx, id)) === null) return notFound(ctx);
  try {
    const result = await archiveCampaign(asOwner(ctx, "archive_campaign"), id);
    return redirect(withChange(CAMPAIGNS_PATH, result.changeId));
  } catch (error) {
    return refused(ctx, id, refusal(error, "campaign"));
  }
}

/** Send test to me: one email to the signed-in owner. Writes no audit change, so the page's fingerprint stays good. */
async function sendTest(ctx: ActionContext, id: string): Promise<ActionResult> {
  const campaign = await known(ctx, id);
  if (campaign === null || campaign.archived === 1 || (campaign.status !== "draft" && campaign.status !== "scheduled")) return notFound(ctx);
  const { step } = await loadCampaign(ctx.db, id);
  const settings = await getSettings(ctx.db);
  const result = await sendTestEmail(campaignEnvOf(ctx.env), ctx.db, ctx.now, { campaign, step, settings, to: ctx.email, baseUrl: ctx.origin });
  return result.ok ? redirect(`${campaignPath(id)}?test=sent`) : refused(ctx, id, result.message);
}

export const CAMPAIGN_SEND_ROUTES: Route[] = [
  { path: /^\/campaigns\/([^/]+)\/test$/, handle: sendTest },
  { path: /^\/campaigns\/([^/]+)\/approve$/, handle: (ctx, id) => send(ctx, id, false) },
  { path: /^\/campaigns\/([^/]+)\/schedule$/, handle: (ctx, id) => send(ctx, id, true) },
  { path: /^\/campaigns\/([^/]+)\/cancel$/, handle: (ctx, id) => stop(ctx, id, "cancel") },
  { path: /^\/campaigns\/([^/]+)\/pause$/, handle: (ctx, id) => stop(ctx, id, "pause") },
  { path: /^\/campaigns\/([^/]+)\/resume$/, handle: resume },
  { path: /^\/campaigns\/([^/]+)\/duplicate$/, handle: duplicate },
  { path: /^\/campaigns\/([^/]+)\/archive$/, handle: archive },
];
