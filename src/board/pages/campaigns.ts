// /campaigns (decision 0053): the live campaigns grouped by status, with New campaign and Campaign settings. A campaign's
// name and subject are the owner's or the AI's own text, not outside text, so the name may be the link. 404 while
// campaigns are off.
import { listCampaignItems, type CampaignListItem } from "../../campaigns/list.ts";
import type { CampaignStatus } from "../../db/db.ts";
import { getSettings } from "../../db/queries.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { formatLocal } from "../../time.ts";
import type { PageContext } from "../context.ts";
import { type Html, html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { empty, pairs, section, when } from "../parts.ts";
import { dataTable, layoutDescription, layoutSwitch, layoutTitle, pickLayout, type TableColumn } from "../table.ts";

export const CAMPAIGNS_PATH = "/campaigns";
export const CAMPAIGNS_NEW_PATH = "/campaigns/new";
export const CAMPAIGN_SETTINGS_PATH = "/campaigns/settings";
export const campaignPath = (id: string): string => `${CAMPAIGNS_PATH}/${encodeURIComponent(id)}`;

const GROUPS: { status: CampaignStatus; heading: string }[] = [
  { status: "draft", heading: "Draft" },
  { status: "scheduled", heading: "Scheduled" },
  { status: "sending", heading: "Sending" },
  { status: "paused", heading: "Paused" },
  { status: "sent", heading: "Sent" },
  { status: "cancelled", heading: "Cancelled" },
];

/** The time that matters for a status: when it will go, was approved or finished. */
function timeOf(item: CampaignListItem): { name: string; at: string } | null {
  const pick = (name: string, at: string | null) => (at === null ? null : { name, at });
  switch (item.status) {
    case "scheduled":
      return pick("Scheduled for", item.send_after ?? item.approved_at);
    case "sending":
    case "paused":
      return pick("Approved", item.approved_at);
    case "sent":
      return pick("Completed", item.completed_at);
    default:
      return null;
  }
}

function card(item: CampaignListItem, tz: string): Html {
  const time = timeOf(item);
  return html`<li class="card">
<div class="card-head">
<h3 class="card-title"><a href="${campaignPath(item.id)}">${item.name}</a></h3>
</div>
${pairs([
  { name: "Subject", value: item.subject },
  time !== null && { name: time.name, value: when(time.at, formatLocal(time.at, tz)) },
])}
</li>`;
}

export async function campaignsPage(ctx: PageContext): Promise<string | null> {
  if ((await getSettings(ctx.db)).campaigns !== 1) return null;
  const tz = await ownerTimezone(ctx.db);
  const items = await listCampaignItems(ctx.db);
  const groups = GROUPS.map((group) => ({ ...group, items: items.filter((item) => item.status === group.status) })).filter((group) => group.items.length > 0);
  const layout = pickLayout(ctx.query, "table");
  const ordered = groups.flatMap((group) => group.items);
  const headingOf = (item: CampaignListItem): string => GROUPS.find((group) => group.status === item.status)?.heading ?? item.status;
  const columns: TableColumn<CampaignListItem>[] = [
    { key: "campaign", header: "Campaign", cell: (item) => html`<a href="${campaignPath(item.id)}">${item.name}</a>` },
    { key: "status", header: "Status", cell: headingOf },
    { key: "subject", header: "Subject", cell: (item) => item.subject },
    {
      key: "time",
      header: "Date",
      cell: (item) => {
        const time = timeOf(item);
        return time === null ? "None" : html`${time.name} ${when(time.at, formatLocal(time.at, tz))}`;
      },
    },
  ];
  const list =
    layout === "table"
      ? dataTable({ label: "Campaigns, as a table", caption: "Campaigns by status, with their subject and date.", columns, rows: ordered })
      : groups.map((group) => section(`campaigns-${group.status}`, group.heading, html`<ul class="cards">${group.items.map((item) => card(item, tz))}</ul>`));
  return renderPage({
    region: true,
    title: layoutTitle("Campaigns", layout, "table"),
    description: layoutDescription("Email newsletters and invites: drafts, review, sending and results.", layout, "table"),
    current: CAMPAIGNS_PATH,
    frame: ctx,
    body: html`<h1>Campaigns</h1>
<p class="lede">Email newsletters and invites: drafts, review, sending and results.</p>
<p class="page-action"><a class="button" href="${CAMPAIGNS_NEW_PATH}">New campaign</a><a class="button button-quiet" href="${CAMPAIGN_SETTINGS_PATH}">Campaign settings</a></p>
${groups.length === 0 ? "" : layoutSwitch(CAMPAIGNS_PATH, ctx.query, layout)}
${groups.length === 0 ? empty("No campaigns yet.", "Start one with New campaign, or ask your AI app to draft one.") : list}`,
  });
}
