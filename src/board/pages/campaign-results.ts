// /campaigns/<id> once a campaign has been approved (decision 0053): what happened to each email. Counts, a table of
// the people with their status, and Pause, Resume, Cancel and Duplicate as they apply. The page reads and writes nothing.
import { SKIP_HEADINGS, personLink, smallForm, STATUS_LABELS } from "../campaign-parts.ts";
import type { CampaignRow, Db } from "../../db/db.ts";
import { contactName } from "../../services/labels.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { formatLocal } from "../../time.ts";
import type { PageContext } from "../context.ts";
import { type Html, html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { pairs, section, tag, when } from "../parts.ts";
import { dataTable, withParams } from "../table.ts";
import { CAMPAIGNS_PATH, campaignPath } from "./campaigns.ts";
import type { ReviewState } from "./campaign-review.ts";

export const RESULT_ROWS = 200;

/** The filters and counts, in the order the page shows them. `sql` is a fixed condition on a recipient row. */
const KINDS = [
  { key: "sent", label: "Sent", sql: "r.status IN ('sent', 'delivered', 'bounced', 'complained')" },
  { key: "delivered", label: "Delivered", sql: "r.status = 'delivered'" },
  { key: "bounced", label: "Bounced", sql: "r.status = 'bounced'" },
  { key: "complained", label: "Marked as spam", sql: "r.status = 'complained'" },
  { key: "unsubscribed", label: "Unsubscribed", sql: "r.unsubscribed_at IS NOT NULL" },
  { key: "skipped", label: "Skipped", sql: "r.status = 'skipped'" },
  { key: "uncertain", label: "Not confirmed", sql: "r.status = 'uncertain'" },
  { key: "failed", label: "Failed", sql: "r.status = 'failed'" },
  { key: "waiting", label: "Waiting", sql: "r.status IN ('queued', 'sending')" },
  { key: "cancelled", label: "Cancelled", sql: "r.status = 'cancelled'" },
] as const;

type Kind = (typeof KINDS)[number];

const STATUS_WORDS: Record<string, string> = {
  queued: "Waiting",
  sending: "Waiting",
  sent: "Sent",
  delivered: "Delivered",
  bounced: "Bounced",
  complained: "Marked as spam",
  failed: "Failed",
  uncertain: "Not confirmed",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

type Line = {
  contact_id: string;
  contact_name: string;
  untrusted_fields: string;
  status: string;
  skip_reason: string | null;
  claimed_at: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  bounced_at: string | null;
  complained_at: string | null;
  unsubscribed_at: string | null;
};

async function countsOf(db: Db, campaignId: string): Promise<{ all: number; by: Map<string, number> }> {
  const columns = KINDS.map((kind) => `COALESCE(SUM(${kind.sql}), 0) AS ${kind.key}`).join(", ");
  const found = await db
    .prepare(`SELECT COUNT(*) AS total, ${columns} FROM campaign_recipients r WHERE r.campaign_id = ?`)
    .bind(campaignId)
    .first<Record<string, number>>();
  return { all: found?.total ?? 0, by: new Map(KINDS.map((kind) => [kind.key, found?.[kind.key] ?? 0])) };
}

/** An empty cell: a dash for the eye, "none" for a screen reader. */
const none = html`<span aria-hidden="true">&mdash;</span><span class="visually-hidden">none</span>`;

const latest = (line: Line): string | null =>
  [line.claimed_at, line.sent_at, line.delivered_at, line.bounced_at, line.complained_at, line.unsubscribed_at].filter((at): at is string => at !== null).sort().at(-1) ?? null;

const statusWords = (line: Line): string => {
  const base = STATUS_WORDS[line.status] ?? line.status;
  return line.unsubscribed_at === null ? base : `${base}, unsubscribed`;
};

function filterLinks(path: string, query: URLSearchParams, shown: Kind | null, counts: { all: number; by: Map<string, number> }): Html {
  const item = (key: string | null, label: string, n: number) =>
    html`<li><a href="${withParams(path, query, { status: key })}"${(shown?.key ?? null) === key ? html` aria-current="page"` : ""}>${label} (${n})</a></li>\n`;
  return html`<ul class="view-switch" aria-label="Show people by result">
${item(null, "All", counts.all)}${KINDS.filter((kind) => (counts.by.get(kind.key) ?? 0) > 0).map((kind) => item(kind.key, kind.label, counts.by.get(kind.key) ?? 0))}</ul>`;
}

function actions(ctx: PageContext, campaign: CampaignRow): Html {
  const id = campaign.id;
  const { status } = campaign;
  return html`<div class="page-action">${status === "sending" ? smallForm(ctx, id, "pause", "Pause campaign") : ""}${
    status === "paused" ? smallForm(ctx, id, "resume", "Resume") : ""
  }${status === "sending" || status === "paused" ? smallForm(ctx, id, "cancel", "Cancel campaign") : ""}${smallForm(ctx, id, "duplicate", "Duplicate")}</div>`;
}

/** The results of an approved campaign: sending, paused, sent or cancelled. */
export async function campaignResultsPage(ctx: PageContext, campaign: CampaignRow, state?: ReviewState): Promise<string> {
  const tz = await ownerTimezone(ctx.db);
  const counts = await countsOf(ctx.db, campaign.id);
  const asked = ctx.query.get("status");
  const shown = KINDS.find((kind) => kind.key === asked) ?? null;
  const lines = await ctx.db
    .prepare(
      `SELECT r.contact_id, c.name AS contact_name, c.untrusted_fields, r.status, r.skip_reason, r.claimed_at, r.sent_at, r.delivered_at, r.bounced_at, r.complained_at, r.unsubscribed_at
       FROM campaign_recipients r JOIN contacts c ON c.id = r.contact_id
       WHERE r.campaign_id = ?${shown === null ? "" : ` AND ${shown.sql}`}
       ORDER BY lower(c.name), r.id LIMIT ?`,
    )
    .bind(campaign.id, RESULT_ROWS)
    .all<Line>();
  const inView = shown === null ? counts.all : (counts.by.get(shown.key) ?? 0);

  const total = (kind: Kind) => counts.by.get(kind.key) ?? 0;
  const shownCounts = KINDS.filter((kind) => kind.key === "sent" || total(kind) > 0);
  const stamp = (label: string, at: string | null) => (at === null ? "" : html`<p>${label} ${when(at, formatLocal(at, tz))}</p>`);
  const webhookNote = ctx.campaignEnv?.CAMPAIGN_WEBHOOK_SECRET
    ? ""
    : html`<p class="notice">Delivered, bounced and spam results arrive once the Resend webhook is set up.</p>`;

  const table = dataTable({
    label: "People in this campaign",
    caption: `People in ${campaign.name}, with what happened to each email`,
    columns: [
      {
        key: "person",
        header: "Person",
        cell: (line: Line) => personLink(line.contact_id, contactName({ id: line.contact_id, name: line.contact_name, untrusted_fields: line.untrusted_fields })),
      },
      { key: "status", header: "Status", cell: (line) => statusWords(line) },
      { key: "when", header: "When", cell: (line) => (latest(line) === null ? none : when(latest(line) ?? "", formatLocal(latest(line) ?? "", tz))) },
      {
        key: "reason",
        header: "Reason",
        cell: (line) => (line.skip_reason === null ? none : (SKIP_HEADINGS.find(([reason]) => reason === line.skip_reason)?.[1] ?? "")),
      },
    ],
    rows: lines.results,
  });

  return renderPage({
    title: shown === null ? `${campaign.name}: results` : `${campaign.name}: results, ${shown.label.toLowerCase()}`,
    description:
      shown === null
        ? "What happened to each email in a campaign that has gone out."
        : `The people in a campaign that has gone out, filtered to those marked ${shown.label}.`,
    current: CAMPAIGNS_PATH,
    frame: ctx,
    body: html`<h1>${campaign.name}</h1>
${state?.refusal === undefined ? "" : html`<p class="lede refusal" role="alert">${state.refusal}</p>`}
<p class="lede">${tag(STATUS_LABELS[campaign.status])}</p>
${stamp("Approved", campaign.approved_at)}${stamp(campaign.status === "cancelled" ? "Cancelled" : "Finished", campaign.completed_at)}
${campaign.send_error === null ? "" : html`<p class="notice">${campaign.send_error}</p>`}
${webhookNote}
${section(
  "campaign-counts",
  "Results",
  pairs(shownCounts.map((kind) => ({ name: kind.label, value: String(total(kind)) }))),
)}
${actions(ctx, campaign)}
${section(
  "campaign-people",
  "People",
  html`${filterLinks(campaignPath(campaign.id), ctx.query, shown, counts)}
${lines.results.length === 0 ? html`<p class="empty">No one to show.</p>` : table}
${inView > RESULT_ROWS ? html`<p class="section-note">Showing ${RESULT_ROWS} of ${inView}.</p>` : ""}`,
)}
<p class="back-link"><a href="${CAMPAIGNS_PATH}">Back to campaigns</a></p>`,
  });
}
