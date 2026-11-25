// POST /hooks/resend: Resend's delivery results (decision 0053). Public, whatever the sign-in mode and whether campaigns
// are on or off; the Svix signature is the check. Every event only moves a recipient forward, so a retry or a late
// event changes nothing. Answers 200 for unknown ids and ignored event types so Resend stops retrying.
import { blockAddress } from "../campaigns/suppressions.ts";
import { verifySvix } from "../campaigns/svix.ts";
import type { CampaignRecipientRow } from "../db/db.ts";
import type { Env } from "../env.ts";
import { readCappedBody } from "./limits.ts";
import { textResponse } from "./respond.ts";

const BODY_MAX_BYTES = 64 * 1024;

interface ResendEvent {
  type: string;
  emailId: string;
  bounceType: string | null;
}

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
  const { email_id: emailId, bounce } = data as { email_id?: unknown; bounce?: unknown };
  if (typeof emailId !== "string" || emailId === "") return null;
  const bounceType = typeof bounce === "object" && bounce !== null ? (bounce as { type?: unknown }).type : null;
  return { type, emailId, bounceType: typeof bounceType === "string" ? bounceType : null };
}

function move(env: Env, now: Date, id: string, status: string, from: readonly string[], stampColumn: string | null): D1PreparedStatement {
  const stamp = stampColumn === null ? "" : `, ${stampColumn} = ?`;
  const marks = from.map(() => "?").join(", ");
  const binds: unknown[] = [status, ...(stampColumn === null ? [] : [now.toISOString()]), id, ...from];
  return env.DB.prepare(`UPDATE campaign_recipients SET status = ?${stamp}, version = version + 1 WHERE id = ? AND status IN (${marks})`).bind(...binds);
}

async function apply(env: Env, now: Date, event: ResendEvent, row: CampaignRecipientRow): Promise<void> {
  const block = (reason: "bounced" | "complained", status: string, from: readonly string[], column: string | null, why: string) =>
    from.includes(row.status)
      ? blockAddress(env.DB, now, row, {
          reason,
          tool: "campaign_webhook",
          summary: `Stopped campaign emails to contact ${row.contact_id}: ${why}`,
          mark: move(env, now, row.id, status, from, column),
        })
      : Promise.resolve();

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

async function handle(request: Request, env: Env, now: Date): Promise<Response> {
  if (request.method !== "POST") return textResponse("This address only answers POST requests.", 405, { Allow: "POST" });
  const secret = env.CAMPAIGN_WEBHOOK_SECRET;
  if (!secret) return textResponse("Not set up.", 503);

  const body = await readCappedBody(request, BODY_MAX_BYTES);
  if (body === null) return textResponse("That is too large.", 413);

  const id = request.headers.get("svix-id");
  const timestamp = request.headers.get("svix-timestamp");
  const signature = request.headers.get("svix-signature");
  if (!id || !timestamp || !signature) return textResponse("Missing signature headers.", 400);
  if (!(await verifySvix(secret, { id, timestamp, signature }, body, now))) return textResponse("Signature not accepted.", 401);

  const event = parseEvent(body);
  if (event === null) return textResponse("That is not a delivery event.", 400);

  const row = await env.DB.prepare("SELECT * FROM campaign_recipients WHERE resend_id = ?").bind(event.emailId).first<CampaignRecipientRow>();
  if (row !== null) await apply(env, now, event, row);
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
