// Campaign tools (decision 0053). The AI app can read campaigns and save drafts, nothing more: no tool approves,
// schedules, sends, pauses or cancels one, because the owner reviews each on the board and taps Approve. The two draft
// tools write at once (a draft sends nothing) as the `ai` actor, outside propose_changes. Reads give ids, labels and
// counts, never an email address or an unsubscribe token. Every tool refuses while campaigns are off.
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { parseAudience, resolveAudience } from "../campaigns/audience.ts";
import { addCampaignDraft, type CampaignDraftInput, loadCampaign, updateCampaignDraft } from "../campaigns/drafts.ts";
import type { CampaignRow, Db } from "../db/db.ts";
import { settingsRow } from "../services/memo.ts";
import { requireCampaigns } from "../services/settings.ts";
import { formatLocal } from "../time.ts";
import { toolResult } from "./format.ts";
import { orNull, shortText } from "./schemas.ts";
import { aiCtx, registerTool, type ToolDeps } from "./tool.ts";

const STATUSES = ["draft", "scheduled", "sending", "paused", "sent", "cancelled"] as const;
const PREVIEW_PEOPLE = 25;
const LIST_MAX = 100;

const reviewUrl = ({ origin }: ToolDeps, id: string) => `${origin ?? ""}/campaigns/${id}`;

const NOT_SENT =
  "This only saves a draft: nothing is sent, scheduled or approved. The owner reviews it on the board and taps Approve; " +
  "give them the review_url.";

const audience = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("status"), status: shortText("A person status key, for example partner (list_person_statuses).") }),
  z.strictObject({ kind: z.literal("view"), view: shortText("The id (vw_...) of a saved view of people (list_views).") }),
  z.strictObject({
    kind: z.literal("people"),
    people: z.array(shortText("A person's id (ct_...).")).min(1).max(500).describe("1 to 500 people, by id."),
  }),
]).describe("Who gets it: a person status, a saved view of people, or a list of people.");

const draftFields = {
  name: shortText("The campaign's name, one line (up to 100 characters). Only the owner sees it."),
  subject: shortText("The email subject, one line, up to 150 characters. May use {{first_name}}."),
  body: z.string().min(1).max(20_000).describe("The email, plain text, up to 20,000 characters. Blank lines make paragraphs. May use {{first_name}}."),
  buttonLabel: shortText("The button's label (up to 40 characters). Needs buttonUrl too."),
  buttonUrl: shortText("The button's full https:// address. Needs buttonLabel too."),
  firstNameFallback: shortText("Used for {{first_name}} when a person has no first name (up to 40 characters; the default is \"there\")."),
  suggestedSendAt: shortText("When you suggest it goes out, in the owner's timezone, in the future (YYYY-MM-DDTHH:mm). Only a suggestion: the owner picks the time."),
};

const toDraftInput = (args: Record<string, unknown>): CampaignDraftInput => {
  const { recipients, ...rest } = args;
  return { ...rest, ...(recipients === undefined ? {} : { recipients: recipients as CampaignDraftInput["recipients"] }) };
};

async function recipientCounts(db: Db, ids: string[]): Promise<Map<string, { recipients: Record<string, number>; skipped_by_reason: Record<string, number> }>> {
  const counts = new Map<string, { recipients: Record<string, number>; skipped_by_reason: Record<string, number> }>();
  if (ids.length === 0) return counts;
  const rows = await db
    .prepare(
      "SELECT campaign_id, status, skip_reason, COUNT(*) AS n FROM campaign_recipients " +
        "WHERE campaign_id IN (SELECT value FROM json_each(?)) GROUP BY campaign_id, status, skip_reason",
    )
    .bind(JSON.stringify(ids))
    .all<{ campaign_id: string; status: string; skip_reason: string | null; n: number }>();
  for (const row of rows.results) {
    const entry = counts.get(row.campaign_id) ?? { recipients: {}, skipped_by_reason: {} };
    entry.recipients[row.status] = (entry.recipients[row.status] ?? 0) + row.n;
    if (row.skip_reason !== null) entry.skipped_by_reason[row.skip_reason] = row.n;
    counts.set(row.campaign_id, entry);
  }
  return counts;
}

/** A time as UTC and as the owner reads it, or two nulls. */
function times(name: string, at: string | null, tz: string): Record<string, string | null> {
  return { [name]: at, [`${name}_local`]: at === null ? null : formatLocal(at, tz) };
}

function summaryOf(campaign: CampaignRow, tz: string): Record<string, unknown> {
  return {
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    ...times("suggested_send_at", campaign.suggested_send_at, tz),
    ...times("send_after", campaign.send_after, tz),
    ...times("approved_at", campaign.approved_at, tz),
    ...times("completed_at", campaign.completed_at, tz),
  };
}

const untrusted = { untrusted_fields: ["name", "subject", "body", "button_label", "first_name_fallback"] };

export function registerCampaignTools(server: McpServer, deps: ToolDeps): void {
  registerTool(
    server,
    {
      name: "list_campaigns",
      title: "List campaigns",
      kind: "read",
      description:
        `Campaigns, newest first (at most ${LIST_MAX}), archived ones left out, with their status, times and, once approved, ` +
        "counts by recipient status. Filter by status. Each has a review_url on the board.",
      input: z.strictObject({ status: z.enum(STATUSES).optional().describe("Only campaigns with this status.") }),
      async run(args, { db }) {
        await requireCampaigns(db);
        const tz = (await settingsRow(db)).timezone;
        const rows = await db
          .prepare(
            "SELECT * FROM campaigns WHERE archived = 0 AND (? IS NULL OR status = ?) ORDER BY created_at DESC, id DESC LIMIT ?",
          )
          .bind(args.status ?? null, args.status ?? null, LIST_MAX)
          .all<CampaignRow>();
        const counts = await recipientCounts(db, rows.results.map((row) => row.id));
        const campaigns = rows.results.map((row) => ({
          ...summaryOf(row, tz),
          ...(row.approved_at === null ? {} : { recipients: counts.get(row.id)?.recipients ?? {} }),
          review_url: reviewUrl(deps, row.id),
        }));
        const n = campaigns.length;
        return toolResult(n === 0 ? "No campaigns." : `${n} campaign${n === 1 ? "" : "s"}.`, { ...untrusted, campaigns });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "get_campaign",
      title: "Get a campaign",
      kind: "read",
      description:
        "One campaign: its email (subject, body, button, first-name fallback), who it is for (as given), the suggested send " +
        "time, status, any send error, counts of its recipients by status and skip reason, and its review_url.",
      input: z.strictObject({ id: shortText("The campaign's id, cp_... (list_campaigns).") }),
      async run({ id }, { db }) {
        await requireCampaigns(db);
        const { campaign, step } = await loadCampaign(db, id);
        const tz = (await settingsRow(db)).timezone;
        const counts = (await recipientCounts(db, [id])).get(id);
        return toolResult(`Campaign ${id}: ${campaign.status}.`, {
          ...untrusted,
          ...summaryOf(campaign, tz),
          audience: parseAudience(campaign.audience),
          subject: step.subject,
          body: step.body,
          button_label: step.button_label,
          button_url: step.button_url,
          first_name_fallback: campaign.first_name_fallback,
          send_error: campaign.send_error,
          recipients: counts?.recipients ?? {},
          skipped_by_reason: counts?.skipped_by_reason ?? {},
          review_url: reviewUrl(deps, id),
        });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "preview_campaign_recipients",
      title: "Preview a campaign's recipients",
      kind: "read",
      description:
        "Who the campaign's audience would reach right now, whatever its status: how many are sendable, how many are skipped " +
        `and why (no email, unsubscribed, bounced and so on), how many are leads nobody has contacted, and up to ${PREVIEW_PEOPLE} ` +
        "of them by id and name. Never gives an email address.",
      input: z.strictObject({ id: shortText("The campaign's id, cp_... (list_campaigns).") }),
      async run({ id }, { db, now }) {
        await requireCampaigns(db);
        const { campaign } = await loadCampaign(db, id);
        const resolved = await resolveAudience(db, now(), parseAudience(campaign.audience));
        const skipped: Record<string, number> = {};
        for (const person of resolved.skipped) skipped[person.reason] = (skipped[person.reason] ?? 0) + 1;
        const n = resolved.sendable.length;
        const away = resolved.skipped.length;
        return toolResult(
          `${n} ${n === 1 ? "person" : "people"} would get this campaign${away === 0 ? "." : `; ${away} skipped.`}`,
          {
            untrusted_fields: ["people"],
            sendable: n,
            skipped,
            newLeads: resolved.newLeads,
            people: resolved.sendable.slice(0, PREVIEW_PEOPLE).map(({ contactId, label }) => ({ id: contactId, label })),
            review_url: reviewUrl(deps, id),
          },
        );
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "add_campaign_draft",
      title: "Save a campaign draft",
      kind: "write",
      description:
        "Saves a campaign email as a draft, only when the owner asks, in the rulebook's voice. " + NOT_SENT +
        " Dates and times are in the owner's timezone.",
      input: z.strictObject({
        name: draftFields.name,
        recipients: audience,
        subject: draftFields.subject,
        body: draftFields.body,
        buttonLabel: draftFields.buttonLabel.optional(),
        buttonUrl: draftFields.buttonUrl.optional(),
        firstNameFallback: draftFields.firstNameFallback.optional(),
        suggestedSendAt: draftFields.suggestedSendAt.optional(),
      }),
      async run(args, deps) {
        const result = await addCampaignDraft(aiCtx(deps, "add_campaign_draft"), toDraftInput(args));
        return toolResult(result.summary, { changeId: result.changeId, campaignId: result.campaignId, review_url: reviewUrl(deps, result.campaignId) });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "update_campaign_draft",
      title: "Change a campaign draft",
      kind: "write",
      destructive: true,
      description:
        "Changes a campaign draft (only a draft can be changed), only when the owner asks. Give only what changes; null " +
        "clears the button or the suggested send time. " + NOT_SENT,
      input: z.strictObject({
        id: shortText("The draft's id, cp_... (list_campaigns)."),
        name: draftFields.name.optional(),
        recipients: audience.optional(),
        subject: draftFields.subject.optional(),
        body: draftFields.body.optional(),
        buttonLabel: orNull(draftFields.buttonLabel).optional(),
        buttonUrl: orNull(draftFields.buttonUrl).optional(),
        firstNameFallback: draftFields.firstNameFallback.optional(),
        suggestedSendAt: orNull(draftFields.suggestedSendAt).optional(),
      }),
      async run({ id, ...patch }, deps) {
        const result = await updateCampaignDraft(aiCtx(deps, "update_campaign_draft"), id, toDraftInput(patch));
        return toolResult(result.summary, { changeId: result.changeId, campaignId: result.campaignId, review_url: reviewUrl(deps, result.campaignId) });
      },
    },
    deps,
  );
}
