// Pieces the campaign review page and the results page share (decision 0053).
import type { SkipReason } from "../campaigns/audience.ts";
import type { CampaignStatus } from "../db/db.ts";
import type { PageContext } from "./context.ts";
import { postForm } from "./forms.ts";
import { type Html, html } from "./html.ts";
import { contactHref, outsideLabel } from "./parts.ts";
import { campaignPath } from "./pages/campaigns.ts";

export const STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  sending: "Sending",
  paused: "Paused",
  sent: "Sent",
  cancelled: "Cancelled",
};

/** Why a person is skipped, in the words both pages use. */
export const SKIP_HEADINGS: [SkipReason, string][] = [
  ["no_email", "No email address"],
  ["bad_email", "Email address can't be used"],
  ["unsubscribed", "Unsubscribed"],
  ["bounced", "Bounced before"],
  ["complained", "Marked an earlier email as spam"],
  ["archived", "Archived"],
];

export const actionPath = (id: string, action: string): string => `${campaignPath(id)}/${action}`;

/** A person by link. An outside name is never the link text: the id is, with the From outside label. */
export function personLink(id: string, label: string): Html {
  if (label === `contact ${id}`) return html`<a href="${contactHref(id)}">Contact ${id}</a> ${outsideLabel()}`;
  return html`<a href="${contactHref(id)}">${label}</a>`;
}

/** One quiet button as its own form, posting to a campaign action. */
export const smallForm = (ctx: PageContext, id: string, action: string, label: string): Html =>
  postForm("row-form", actionPath(id, action), { csrf: ctx.csrf, here: ctx.here }, html`<button class="button button-quiet" type="submit">${label}</button>`);
