// /campaigns/<id> (decision 0053): the owner's last look before an email goes to real people. A draft or scheduled
// campaign shows who gets it, who is skipped and why, what the email looks like to the first person, and the buttons
// that send it. The page reads and writes nothing. A campaign that has gone out shows its results instead
// (campaign-results.ts). 404 for an unknown or archived campaign and while campaigns are off.
import { parseAudience, type ResolvedAudience, resolveAudience } from "../../campaigns/audience.ts";
import { loadCampaign } from "../../campaigns/drafts.ts";
import { fingerprint } from "../../campaigns/freeze.ts";
import { replyTo, sendingBlocker } from "../../campaigns/readiness.ts";
import { renderEmail } from "../../campaigns/render.ts";
import type { CampaignRow, CampaignStepRow, SettingsRow } from "../../db/db.ts";
import { getSettings } from "../../db/queries.ts";
import { isCampaignId } from "../../ids.ts";
import { UserError } from "../../services/errors.ts";
import { statusLabels } from "../../services/status-labels.ts";
import { addDays, formatLocal, localDate, localWhen } from "../../time.ts";
import { campaignPreview } from "../campaign-preview.ts";
import type { PageContext } from "../context.ts";
import { hidden, postForm } from "../forms.ts";
import { type Html, html } from "../html.ts";
import { errorSummary, field } from "../inputs.ts";
import { renderPage } from "../layout.ts";
import { actionPath, personLink, SKIP_HEADINGS, smallForm, STATUS_LABELS } from "../campaign-parts.ts";
import { count, pairs, section, tag, when } from "../parts.ts";
import { CAMPAIGNS_PATH } from "./campaigns.ts";
import { campaignEditPath } from "./campaign-form.ts";
import { campaignResultsPage } from "./campaign-results.ts";

const people = (n: number): string => count(n, "person", "people");

/** The review page's own refusal: a form that was posted again, with the sentence that says why nothing happened. */
export type ReviewState = {
  refusal?: string;
  /**
   * The Schedule form was posted: the date and time as typed (kept on the form), and whether the refusal is about the
   * date or time themselves (then the field is marked) rather than the list or the sending set-up.
   */
  schedule?: { date: string; time: string; onField: boolean };
};

/** "Thursday, Nov 27" for a local "YYYY-MM-DD". */
const dayName = (date: string): string =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00Z`));

async function howChosen(ctx: PageContext, campaign: CampaignRow): Promise<string> {
  const audience = parseAudience(campaign.audience);
  if (audience.kind === "people") return "people you picked";
  if (audience.kind === "status") return `status ${(await statusLabels(ctx.db)).status(audience.status)}`;
  const view = await ctx.db.prepare("SELECT name FROM views WHERE id = ?").bind(audience.view).first<{ name: string }>();
  return view === null ? "a view that is no longer there" : `view ${view.name}`;
}

function skippedSection(resolved: ResolvedAudience): Html | "" {
  if (resolved.skipped.length === 0) return "";
  const groups = SKIP_HEADINGS.map(([reason, heading]) => ({ heading, members: resolved.skipped.filter((member) => member.reason === reason) })).filter(
    (group) => group.members.length > 0,
  );
  return section(
    "campaign-skipped",
    `Skipped: ${resolved.skipped.length}`,
    html`${groups.map((group) => html`<h3>${group.heading}</h3>
<ul class="plain-list">${group.members.map((member) => html`<li>${personLink(member.contactId, member.label)}</li>`)}</ul>`)}`,
  );
}

function limitLine(n: number, limit: number, sendDay: string): Html | "" {
  if (n <= limit) return "";
  const days = Math.ceil(n / limit);
  return html`<p class="notice">At your limit of ${limit} a day this goes out over ${days} days, finishing about ${dayName(addDays(sendDay, days - 1))}.</p>`;
}

/** The when fields' value for the Schedule form: the suggested time as the owner's wall clock, or empty. */
const suggestedWhen = (campaign: CampaignRow, tz: string): string => (campaign.suggested_send_at === null ? "" : localWhen(campaign.suggested_send_at, tz));

/** "Send test to me": one email to the signed-in owner, never to the list. */
const testForm = (ctx: PageContext, campaign: CampaignRow): Html =>
  html`<div class="card send-forms">
${postForm("send-form", actionPath(campaign.id, "test"), { csrf: ctx.csrf, here: ctx.here }, html`<button class="button button-quiet" type="submit">Send test to me</button>
<p class="field-hint">Sends one email to you, with “Test: ” before the subject.</p>`)}
</div>`;

function sendForms(ctx: PageContext, campaign: CampaignRow, tz: string, n: number, print: string, state: ReviewState | undefined): Html {
  const form = { csrf: ctx.csrf, here: ctx.here };
  const typed = state?.schedule;
  const message = typed === undefined ? undefined : state?.refusal;
  const value = typed === undefined ? suggestedWhen(campaign, tz) : `${typed.date}${typed.time === "" ? "" : `T${typed.time}`}`;
  const timeOnly = typed !== undefined && typed.date !== "" && typed.time === "";
  return html`<div class="card send-forms">
${message === undefined ? "" : errorSummary([{ id: timeOnly ? "schedule-at-time" : "schedule-at-date", message }])}
${postForm("send-form", actionPath(campaign.id, "approve"), form, html`${hidden("fingerprint", print)}<button class="button" type="submit">Approve and send to ${people(n)}</button>`)}
${postForm(
  "send-form",
  actionPath(campaign.id, "schedule"),
  form,
  html`${hidden("fingerprint", print)}${field({
    id: "schedule-at",
    name: "send_at",
    label: "Send at",
    kind: "when",
    value,
    required: true,
    timeRequired: true,
    hint: "In your timezone. Goes out within 15 minutes after this time.",
    ...(typed?.onField && message !== undefined ? { error: message } : {}),
  })}<button class="button button-quiet" type="submit">Schedule</button>`,
)}
</div>`;
}

const refusalNote = (state: ReviewState | undefined): Html | "" =>
  state?.refusal === undefined ? "" : html`<p class="lede refusal" role="alert">${state.refusal}</p>`;

type Reviewed = { campaign: CampaignRow; step: CampaignStepRow; settings: SettingsRow; tz: string };

async function reviewBody(ctx: PageContext, { campaign, step, settings, tz }: Reviewed, state: ReviewState | undefined): Promise<Html> {
  let resolved: ResolvedAudience | null = null;
  let problem: string | null = null;
  try {
    resolved = await resolveAudience(ctx.db, ctx.now, parseAudience(campaign.audience));
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    problem = error.message;
  }
  const scheduled = campaign.status === "scheduled";
  const sendable = resolved?.sendable ?? [];
  const first = sendable[0];
  const business = ctx.look.name;
  const postal = settings.postal_address;
  const rendered = renderEmail(
    step,
    { firstName: first?.firstName ?? null, token: "preview" },
    { business, postal: postal ?? "", baseUrl: ctx.origin ?? "", fallback: campaign.first_name_fallback, accent: settings.accent_color ?? "" },
  );
  const sendDay = localDate(scheduled && campaign.send_after !== null ? new Date(campaign.send_after) : ctx.now, tz);
  const blocker = ctx.campaignEnv === undefined ? "Sending isn't set up for this copy yet." : sendingBlocker(ctx.campaignEnv, settings);
  const reply = ctx.campaignEnv === undefined ? null : replyTo(ctx.campaignEnv, settings);
  const heading = first === undefined ? "Preview" : `Preview, as ${first.label} will see it`;

  const to =
    resolved === null
      ? html`<p class="notice">${problem}</p>`
      : html`${pairs([{ name: "To", value: `${people(sendable.length)}, from ${await howChosen(ctx, campaign)}` }])}${resolved.newLeads > 0
          ? html`<p class="notice">${resolved.newLeads === 1 ? "1 of them is a lead" : `${resolved.newLeads} of them are leads`} you haven't contacted yet. A first email from a list can land in spam and hurt your sending.</p>`
          : ""}${limitLine(sendable.length, settings.campaign_daily_limit, sendDay)}`;

  const timeLine = scheduled
    ? campaign.send_after === null
      ? ""
      : html`<p>Scheduled for ${when(campaign.send_after, formatLocal(campaign.send_after, tz))}</p>`
    : campaign.suggested_send_at === null
      ? ""
      : html`<p>Suggested time: ${when(campaign.suggested_send_at, formatLocal(campaign.suggested_send_at, tz))}</p>`;

  // A notice is announced only when a post was just refused; on a plain load it is ordinary page text.
  const announce = state?.refusal === undefined ? "" : html` role="alert"`;
  const formsShown = !scheduled && resolved !== null && blocker === null && sendable.length > 0;
  let actions: Html;
  if (scheduled) {
    actions = html`<div class="page-action">${smallForm(ctx, campaign.id, "cancel", "Cancel campaign")}${smallForm(ctx, campaign.id, "duplicate", "Duplicate")}</div>${blocker === null ? testForm(ctx, campaign) : ""}`;
  } else {
    const edit = html`<a class="button button-quiet" href="${campaignEditPath(campaign.id)}">Edit</a>`;
    const own = html`<div class="page-action">${edit}${smallForm(ctx, campaign.id, "duplicate", "Duplicate")}${smallForm(ctx, campaign.id, "archive", "Archive")}</div>`;
    const send =
      resolved === null
        ? ""
        : blocker !== null
          ? html`<p class="notice"${announce}>${blocker}</p>`
          : sendable.length === 0
            ? html`<p class="notice"${announce}>No one in this group can get the email.</p>`
            : html`${sendForms(ctx, campaign, tz, sendable.length, await fingerprint(campaign, step, resolved), state)}${testForm(ctx, campaign)}`;
    actions = html`${own}${send}`;
  }

  return html`<h1>${campaign.name}</h1>
${state?.schedule !== undefined && formsShown ? "" : refusalNote(state)}
${ctx.query.get("test") === "sent" ? html`<p class="notice">A test is on its way to you.</p>` : ""}
<p class="lede">${tag(STATUS_LABELS[campaign.status])}</p>
${to}
${resolved === null ? "" : skippedSection(resolved)}
${pairs([
  { name: "From", value: ctx.campaignEnv?.CAMPAIGN_FROM || "Not set yet" },
  { name: "Reply-to", value: reply ?? "Not set yet" },
  { name: "Subject", value: rendered.subject },
])}
${section(
  "campaign-preview",
  heading,
  campaignPreview(step, { business, postal, firstName: first?.firstName ?? campaign.first_name_fallback }),
)}
<details class="text-version">
<summary>Text version</summary>
<pre>${rendered.text}</pre>
</details>
${timeLine}
${actions}
<p class="back-link"><a href="${CAMPAIGNS_PATH}">Back to campaigns</a></p>`;
}

export async function campaignReviewPage(ctx: PageContext, id: string, state?: ReviewState): Promise<string | null> {
  if (!isCampaignId(id)) return null;
  const settings = await getSettings(ctx.db);
  if (settings.campaigns !== 1) return null;
  let found: { campaign: CampaignRow; step: CampaignStepRow };
  try {
    found = await loadCampaign(ctx.db, id);
  } catch (error) {
    if (error instanceof UserError) return null;
    throw error;
  }
  if (found.campaign.archived === 1) return null;
  if (found.campaign.status !== "draft" && found.campaign.status !== "scheduled") return campaignResultsPage(ctx, found.campaign, state);
  const body = await reviewBody(ctx, { ...found, settings, tz: settings.timezone }, state);
  return renderPage({
    title: `Review: ${found.campaign.name}`,
    description: "Check who a campaign goes to and what it says, then approve or schedule it.",
    current: CAMPAIGNS_PATH,
    frame: ctx,
    body,
  });
}
