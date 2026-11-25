// Approving a campaign freezes its list: the people are worked out again, checked against what the owner reviewed (the
// fingerprint), and written as one row each in campaign_recipients in the same audited change that moves the campaign
// to sending or scheduled. Pause, resume and cancel are here too. None of this sends anything.
// The Worker's sending switches (sendingBlocker, readiness.ts) are NOT checked here: this code has no env. The board and
// the tool check them before calling approveCampaign.
import type { CampaignRow, CampaignStepRow } from "../db/db.ts";
import { newId } from "../ids.ts";
import { CHUNK_BYTES, chunkBy, sqlBytes } from "../services/bulk.ts";
import { type ChangeResult, commitChange, type Ctx, updatedRow } from "../services/change.ts";
import { UserError } from "../services/errors.ts";
import { campaignLabel } from "../services/labels.ts";
import { settingsRow } from "../services/memo.ts";
import { requireCampaigns } from "../services/settings.ts";
import { formatLocal } from "../time.ts";
import { type Member, parseAudience, type ResolvedAudience, resolveAudience } from "./audience.ts";
import { capital, loadCampaign } from "./drafts.ts";

const STALE = "The list or the email changed since you opened this page. Check it again.";
const MAX_SCHEDULE_DAYS = 90;
const DAY_MS = 86_400_000;

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * What the owner reviewed, as a hash: the campaign and its email by version, and every person on the list with why they
 * are skipped. Approval refuses when it is not the same one made again.
 */
export async function fingerprint(campaign: CampaignRow, step: CampaignStepRow, resolved: Pick<ResolvedAudience, "sendable" | "skipped">): Promise<string> {
  const parts = [
    campaign.id,
    campaign.version,
    step.version,
    resolved.sendable.map((member) => member.contactId).sort(),
    resolved.skipped.map((member) => `${member.contactId}:${member.reason}`).sort(),
  ];
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts))));
}

/** 32 random bytes as 43 base64url characters: the secret in a person's unsubscribe link. */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const BAD_BASE_URL = "The board's address must be an https address with no path (http only on localhost).";

/** The board's origin as stored: https, or http on localhost or 127.0.0.1, with no path, query or trailing slash. */
function checkBaseUrl(text: string): string {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new UserError(BAD_BASE_URL);
  }
  const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  const plain = url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "" && url.password === "";
  if ((url.protocol !== "https:" && !local) || !plain) throw new UserError(BAD_BASE_URL);
  return url.origin;
}

/** One frozen row as the insert reads it (short keys: a list of 2,000 is several statements of at most CHUNK_BYTES). */
type FrozenRow = { id: string; c: string; e: string; f: string | null; s: "queued" | "skipped"; r: string | null; t: string | null };

function frozenRows(resolved: Pick<ResolvedAudience, "sendable" | "skipped">): FrozenRow[] {
  const row = (member: Member): Omit<FrozenRow, "s" | "r" | "t"> => ({ id: newId("rc"), c: member.contactId, e: member.email ?? "", f: member.firstName });
  return [
    ...resolved.sendable.map((member): FrozenRow => ({ ...row(member), s: "queued", r: null, t: newToken() })),
    ...resolved.skipped.map((member): FrozenRow => ({ ...row(member), s: "skipped", r: member.reason, t: null })),
  ];
}

/** The inserts of the frozen list, one statement per chunk of at most CHUNK_BYTES of bound JSON. */
export function recipientInserts(db: Ctx["db"], campaignId: string, stepId: string, resolved: Pick<ResolvedAudience, "sendable" | "skipped">): D1PreparedStatement[] {
  const sql =
    "INSERT INTO campaign_recipients (id, campaign_id, step_id, contact_id, email, first_name, status, skip_reason, unsub_token) " +
    "SELECT json_extract(j.value, '$.id'), ?, ?, json_extract(j.value, '$.c'), json_extract(j.value, '$.e'), json_extract(j.value, '$.f'), " +
    "json_extract(j.value, '$.s'), json_extract(j.value, '$.r'), json_extract(j.value, '$.t') FROM json_each(?) AS j";
  return chunkBy(frozenRows(resolved), (row) => sqlBytes(JSON.stringify(row)), CHUNK_BYTES).map((chunk) =>
    db.prepare(sql).bind(campaignId, stepId, JSON.stringify(chunk)),
  );
}

export interface ApproveInput {
  /** The fingerprint of the page the owner reviewed. */
  fingerprint: string;
  sendAfter: Date;
  /** The board's address, for the links in the emails. */
  baseUrl: string;
  /** True: wait for sendAfter (a time in the next 90 days). False: start now. */
  scheduled: boolean;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Approves or schedules a draft: the same list the owner reviewed is frozen into one row per person (queued with a
 * fresh unsubscribe token, or skipped with the reason) in the same change that moves the campaign on. The caller sets
 * ctx.tool to campaign_approve or campaign_schedule. Can't be undone (undo.ts: CAMPAIGN_FINAL_TOOLS).
 */
export async function approveCampaign(ctx: Ctx, id: string, input: ApproveInput): Promise<ChangeResult> {
  await requireCampaigns(ctx);
  const { campaign, step } = await loadCampaign(ctx.db, id);
  if (campaign.status !== "draft") throw new UserError("Only a draft can be approved.");
  if (campaign.archived === 1) throw new UserError(`${capital(campaignLabel(campaign.id))} is archived. Duplicate it to make a new draft.`);
  const baseUrl = checkBaseUrl(input.baseUrl);
  const sendAfter = input.scheduled ? input.sendAfter : ctx.now;
  if (input.scheduled) {
    const wait = sendAfter.getTime() - ctx.now.getTime();
    if (!(wait > 0 && wait <= MAX_SCHEDULE_DAYS * DAY_MS)) throw new UserError(`Pick a time in the next ${MAX_SCHEDULE_DAYS} days.`);
  }
  const resolved = await resolveAudience(ctx.db, ctx.now, parseAudience(campaign.audience));
  if ((await fingerprint(campaign, step, resolved)) !== input.fingerprint) throw new UserError(STALE);
  if (resolved.sendable.length === 0) throw new UserError("No one in this group can get the email.");

  const counts = `${plural(resolved.sendable.length, "person", "people")} (${resolved.skipped.length} skipped)`;
  const summary = input.scheduled
    ? `Scheduled ${campaignLabel(id)} for ${formatLocal(sendAfter, (await settingsRow(ctx)).timezone)}: ${counts}`
    : `Approved ${campaignLabel(id)}: sending to ${counts}`;
  return commitChange(ctx, {
    target: { table: "campaigns", id },
    summary,
    changes: [
      {
        table: "campaigns",
        id,
        before: campaign,
        after: updatedRow(
          campaign,
          {
            status: input.scheduled ? "scheduled" : "sending",
            send_after: sendAfter.toISOString(),
            approved_at: ctx.now.toISOString(),
            base_url: baseUrl,
            send_error: null,
          },
          ctx.now,
        ),
      },
    ],
    extra: recipientInserts(ctx.db, id, step.id, resolved),
  });
}

async function moveCampaign(
  ctx: Ctx,
  id: string,
  options: { from: CampaignRow["status"][]; to: CampaignRow["status"]; refusal: string; verb: string; patch?: (now: Date) => Partial<CampaignRow>; cancelQueued?: boolean },
): Promise<ChangeResult> {
  await requireCampaigns(ctx);
  const { campaign } = await loadCampaign(ctx.db, id);
  if (!options.from.includes(campaign.status)) throw new UserError(options.refusal);
  return commitChange(ctx, {
    target: { table: "campaigns", id },
    summary: `${options.verb} ${campaignLabel(id)}`,
    changes: [{ table: "campaigns", id, before: campaign, after: updatedRow(campaign, { status: options.to, ...options.patch?.(ctx.now) }, ctx.now) }],
    extra: options.cancelQueued
      ? [ctx.db.prepare("UPDATE campaign_recipients SET status = 'cancelled', version = version + 1 WHERE campaign_id = ? AND status = 'queued'").bind(id)]
      : [],
  });
}

export const pauseCampaign = (ctx: Ctx, id: string): Promise<ChangeResult> =>
  moveCampaign(ctx, id, { from: ["sending"], to: "paused", verb: "Paused", refusal: "Only a campaign that is sending can be paused." });

export const resumeCampaign = (ctx: Ctx, id: string): Promise<ChangeResult> =>
  moveCampaign(ctx, id, { from: ["paused"], to: "sending", verb: "Resumed", refusal: "Only a paused campaign can be resumed.", patch: () => ({ send_error: null }) });

/** Stops a campaign for good: every person still queued is marked cancelled. Emails already sent stay sent. */
export const cancelCampaign = (ctx: Ctx, id: string): Promise<ChangeResult> =>
  moveCampaign(ctx, id, {
    from: ["scheduled", "sending", "paused"],
    to: "cancelled",
    verb: "Cancelled",
    refusal: "Only a scheduled, sending or paused campaign can be cancelled.",
    patch: (now) => ({ completed_at: now.toISOString() }),
    cancelQueued: true,
  });
