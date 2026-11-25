// /campaigns/<id> (decision 0053): the owner's last look before an email goes to real people. A draft or scheduled
// campaign shows who gets it, who is skipped and why, what the email looks like to the first person, and the buttons
// that send it. The page reads and writes nothing. A campaign that has gone out shows a short placeholder until its
// results page (Task B4) replaces it. 404 for an unknown or archived campaign and while campaigns are off.
import { parseAudience, type ResolvedAudience, resolveAudience, type SkipReason } from "../../campaigns/audience.ts";
import { loadCampaign } from "../../campaigns/drafts.ts";
import { fingerprint } from "../../campaigns/freeze.ts";
import { replyTo, sendingBlocker } from "../../campaigns/readiness.ts";
import { renderEmail } from "../../campaigns/render.ts";
import type { CampaignRow, CampaignStatus, CampaignStepRow, SettingsRow } from "../../db/db.ts";
import { getSettings } from "../../db/queries.ts";
import { isCampaignId } from "../../ids.ts";
import { UserError } from "../../services/errors.ts";
import { statusLabels } from "../../services/status-labels.ts";
import { addDays, formatLocal, localDate, localWhen } from "../../time.ts";
import { campaignPreview } from "../campaign-preview.ts";
import type { PageContext } from "../context.ts";
import { hidden, postForm } from "../forms.ts";
import { type Html, html } from "../html.ts";
import { field } from "../inputs.ts";
import { renderPage } from "../layout.ts";
import { contactHref, count, outsideLabel, pairs, section, tag, when } from "../parts.ts";
import { CAMPAIGNS_PATH, campaignPath } from "./campaigns.ts";
import { campaignEditPath } from "./campaign-form.ts";

const STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  sending: "Sending",
  paused: "Paused",
  sent: "Sent",
  cancelled: "Cancelled",
};

const SKIP_HEADINGS: [SkipReason, string][] = [
  ["no_email", "No email address"],
  ["bad_email", "Email address can't be used"],
  ["unsubscribed", "Unsubscribed"],
  ["bounced", "Bounced before"],
  ["complained", "Marked an earlier email as spam"],
  ["archived", "Archived"],
];

const people = (n: number): string => count(n, "person", "people");

/** The review page's own refusal: a form that was posted again, with the sentence that says why nothing happened. */
export type ReviewState = { refusal?: string };

const actionPath = (id: string, action: string): string => `${campaignPath(id)}/${action}`;

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

/** A skipped person by link. An outside name is never the link text: the id is, with the From outside label. */
function personLink(id: string, label: string): Html {
  if (label === `contact ${id}`) return html`<a href="${contactHref(id)}">Contact ${id}</a> ${outsideLabel()}`;
  return html`<a href="${contactHref(id)}">${label}</a>`;
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

function sendForms(ctx: PageContext, campaign: CampaignRow, tz: string, n: number, print: string): Html {
  const form = { csrf: ctx.csrf, here: ctx.here };
  return html`<div class="card send-forms">
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
    value: suggestedWhen(campaign, tz),
    required: true,
    hint: "In your timezone. Goes out within 15 minutes after this time.",
  })}<button class="button button-quiet" type="submit">Schedule</button>`,
)}
</div>`;
}

const smallForm = (ctx: PageContext, id: string, action: string, label: string): Html =>
  postForm("row-form", actionPath(id, action), { csrf: ctx.csrf, here: ctx.here }, html`<button class="button button-quiet" type="submit">${label}</button>`);

const refusalNote = (state: ReviewState | undefined): Html | "" =>
  state?.refusal === undefined ? "" : html`<p class="lede refusal" role="alert">${state.refusal}</p>`;

/** After approval the campaign leaves this page's care: a status line and Duplicate until the results page exists. */
function placeholder(ctx: PageContext, campaign: CampaignRow, state: ReviewState | undefined): string {
  return renderPage({
    title: `Review: ${campaign.name}`,
    description: "A campaign that has been approved: its status, and a way to copy it into a new draft.",
    current: CAMPAIGNS_PATH,
    frame: ctx,
    body: html`<h1>${campaign.name}</h1>
${refusalNote(state)}
<p class="lede">${tag(STATUS_LABELS[campaign.status])}</p>
<div class="page-action">${smallForm(ctx, campaign.id, "duplicate", "Duplicate")}</div>
<p class="back-link"><a href="${CAMPAIGNS_PATH}">Back to campaigns</a></p>`,
  });
}

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
      ? html`<p class="notice" role="alert">${problem}</p>`
      : html`${pairs([{ name: "To", value: `${people(sendable.length)}, from ${await howChosen(ctx, campaign)}` }])}${resolved.newLeads > 0
          ? html`<p class="notice">${resolved.newLeads} of them are leads you haven't contacted yet. A first email from a list can land in spam and hurt your sending.</p>`
          : ""}${limitLine(sendable.length, settings.campaign_daily_limit, sendDay)}`;

  const timeLine = scheduled
    ? campaign.send_after === null
      ? ""
      : html`<p>Scheduled for ${when(campaign.send_after, formatLocal(campaign.send_after, tz))}</p>`
    : campaign.suggested_send_at === null
      ? ""
      : html`<p>Suggested time: ${when(campaign.suggested_send_at, formatLocal(campaign.suggested_send_at, tz))}</p>`;

  let actions: Html;
  if (scheduled) {
    actions = html`<div class="page-action">${smallForm(ctx, campaign.id, "cancel", "Cancel")}${smallForm(ctx, campaign.id, "duplicate", "Duplicate")}</div>`;
  } else {
    const edit = html`<a class="button button-quiet" href="${campaignEditPath(campaign.id)}">Edit</a>`;
    const own = html`<div class="page-action">${edit}${smallForm(ctx, campaign.id, "duplicate", "Duplicate")}${smallForm(ctx, campaign.id, "archive", "Archive")}</div>`;
    // Task C3 adds "Send test to me" here: one more form beside Edit, shown whatever the blocker says (it has its own checks).
    const send =
      resolved === null
        ? ""
        : blocker !== null
          ? html`<p class="notice" role="alert">${blocker}</p>`
          : sendable.length === 0
            ? html`<p class="notice" role="alert">No one in this group can get the email.</p>`
            : sendForms(ctx, campaign, tz, sendable.length, await fingerprint(campaign, step, resolved));
    actions = html`${own}${send}`;
  }

  return html`<h1>${campaign.name}</h1>
${refusalNote(state)}
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
<details>
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
  if (found.campaign.status !== "draft" && found.campaign.status !== "scheduled") return placeholder(ctx, found.campaign, state);
  const body = await reviewBody(ctx, { ...found, settings, tz: settings.timezone }, state);
  return renderPage({
    title: `Review: ${found.campaign.name}`,
    description: "Check who a campaign goes to and what it says, then approve or schedule it.",
    current: CAMPAIGNS_PATH,
    frame: ctx,
    body,
  });
}
