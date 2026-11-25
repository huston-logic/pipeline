// POST /hooks/resend: Resend's delivery results (decision 0053). Public, whatever the sign-in mode and whether campaigns
// are on or off; the Svix signature is the check. Every event only moves a recipient forward, so a retry or a late
// event changes nothing. Answers 200 for unknown ids and ignored event types so Resend stops retrying.
import { blockAddress } from "../campaigns/suppressions.ts";
import { verifySvix } from "../campaigns/svix.ts";
import type { CampaignRecipientRow } from "../db/db.ts";
import type { Env } from "../env.ts";
import { readCappedBytes } from "./limits.ts";
import { textResponse } from "./respond.ts";

const BODY_MAX_BYTES = 64 * 1024;

interface ResendEvent {
  type: string;
  emailId: string;
  bounceType: string | null;
  /** The campaign tag and first recipient address, for an email whose id was never stored. */
  campaignId: string | null;
  to: string | null;
}

// Resend shows tags as an object or as a list of {name, value}; read both.
function campaignTag(tags: unknown): string | null {
  const found = Array.isArray(tags)
    ? tags.find((tag) => typeof tag === "object" && tag !== null && (tag as { name?: unknown }).name === "campaign")?.value
    : typeof tags === "object" && tags !== null
      ? (tags as { campaign?: unknown }).campaign
      : null;
  return typeof found === "string" ? found : null;
}

const NEEDS_BLOCK = new Set(["email.complained", "email.suppressed", "email.bounced"]);

function parseEvent(body: string): ResendEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { type, data } = value as { type?: unknown; data?: unknown };
  if (typeof type !== "string" || typeof data !== "object" || data === null) return null;
  const { email_id: emailId, bounce, tags, to } = data as { email_id?: unknown; bounce?: unknown; tags?: unknown; to?: unknown };
  if (typeof emailId !== "string" || emailId === "") return null;
  const bounceType = typeof bounce === "object" && bounce !== null ? (bounce as { type?: unknown }).type : null;
  const first = Array.isArray(to) ? to[0] : to;
  return {
    type,
    emailId,
    bounceType: typeof bounceType === "string" ? bounceType : null,
    campaignId: campaignTag(tags),
    to: typeof first === "string" ? first.trim().toLowerCase() : null,
  };
}

function move(env: Env, now: Date, id: string, status: string, from: readonly string[], stampColumn: string | null): D1PreparedStatement {
  const stamp = stampColumn === null ? "" : `, ${stampColumn} = ?`;
  const marks = from.map(() => "?").join(", ");
  const binds: unknown[] = [status, ...(stampColumn === null ? [] : [now.toISOString()]), id, ...from];
  return env.DB.prepare(`UPDATE campaign_recipients SET status = ?${stamp}, version = version + 1 WHERE id = ? AND status IN (${marks})`).bind(...binds);
}

async function apply(env: Env, now: Date, event: ResendEvent, row: CampaignRecipientRow): Promise<void> {
  // The address is always blocked (hard rule 4); only the status move is forward-only, by its WHERE on the status.
  const block = (reason: "bounced" | "complained", status: string, from: readonly string[], column: string | null, why: string) =>
    blockAddress(env.DB, now, row, {
      reason,
      tool: "campaign_webhook",
      summary: `Stopped campaign emails to contact ${row.contact_id}: ${why}`,
      mark: move(env, now, row.id, status, from, column),
    });

  switch (event.type) {
    case "email.delivered":
      await move(env, now, row.id, "delivered", ["sent"], "delivered_at").run();
      return;
    case "email.bounced":
      if (event.bounceType === "Permanent") await block("bounced", "bounced", ["sent", "delivered"], "bounced_at", "the address bounced");
      return;
    case "email.complained":
      await block("complained", "complained", ["sent", "delivered"], "complained_at", "they marked an email as spam");
      return;
    case "email.suppressed":
      await block("bounced", "failed", ["sent"], null, "Resend has the address on its blocked list");
      return;
    case "email.failed":
      await move(env, now, row.id, "failed", ["sent"], null).run();
      return;
    default:
  }
}

async function unmatched(env: Env, event: ResendEvent): Promise<CampaignRecipientRow | null> {
  if (!NEEDS_BLOCK.has(event.type) || event.campaignId === null || event.to === null) return null;
  return env.DB.prepare(
    "SELECT * FROM campaign_recipients WHERE campaign_id = ? AND email = ? AND status IN ('sending', 'sent', 'uncertain') ORDER BY sent_at DESC LIMIT 1",
  )
    .bind(event.campaignId, event.to)
    .first<CampaignRecipientRow>();
}

async function handle(request: Request, env: Env, now: Date): Promise<Response> {
  if (request.method !== "POST") return textResponse("This address only answers POST requests.", 405, { Allow: "POST" });
  const secret = env.CAMPAIGN_WEBHOOK_SECRET;
  if (!secret) return textResponse("Not set up.", 503);

  const bytes = await readCappedBytes(request, BODY_MAX_BYTES);
  if (bytes === null) return textResponse("That is too large.", 413);

  const id = request.headers.get("svix-id");
  const timestamp = request.headers.get("svix-timestamp");
  const signature = request.headers.get("svix-signature");
  if (!id || !timestamp || !signature) return textResponse("Missing signature headers.", 400);
  if (!(await verifySvix(secret, { id, timestamp, signature }, bytes, now))) return textResponse("Signature not accepted.", 401);

  const event = parseEvent(new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes));
  if (event === null) return textResponse("That is not a delivery event.", 400);

  const row = await env.DB.prepare("SELECT * FROM campaign_recipients WHERE resend_id = ?").bind(event.emailId).first<CampaignRecipientRow>();
  const target = row ?? (await unmatched(env, event));
  if (target !== null) await apply(env, now, event, target);
  return textResponse("ok", 200);
}

/** Answers /hooks/resend. A failure is a plain 500 with no detail, so Resend tries again. */
export async function handleResendWebhook(request: Request, env: Env, now: Date): Promise<Response> {
  try {
    return await handle(request, env, now);
  } catch {
    console.error(JSON.stringify({ event: "resend_webhook_failed" }));
    return textResponse("Something went wrong on the server. Nothing was changed.", 500);
  }
}
