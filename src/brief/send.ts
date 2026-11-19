// Emails the brief through Resend: plain text only. Off unless every switch is set (decision 0011); the status it
// returns is stored on the brief and holds a fixed phrase or an HTTP status, never the response body, key or address.
import { parseOwnerEmailsVar } from "../auth/owners.ts";
import type { SettingsRow } from "../db/db.ts";
import type { Env } from "../env.ts";
import { parseStringArray } from "../services/lookup.ts";

const RESEND_URL = "https://api.resend.com/emails";

export type SendResult = { sent: true } | { sent: false; reason: string };

type SendSettings = Pick<SettingsRow, "brief_enabled" | "brief_email" | "owner_emails">;

/**
 * The address is an owner email right now (settings.owner_emails or the OWNER_EMAILS var, ignoring case).
 * update_settings checks this too, but an undo can put back an earlier address, so the send checks again (decision
 * 0005, addendum).
 */
function isOwnerAddress(env: Env, settings: SendSettings, email: string): boolean {
  const owners = [...parseStringArray(settings.owner_emails), ...parseOwnerEmailsVar(env.OWNER_EMAILS)];
  return owners.some((owner) => owner.trim().toLowerCase() === email.trim().toLowerCase());
}

/** The first switch that is not set, or null when the brief may be sent. */
export function sendBlocker(env: Env, settings: SendSettings): string | null {
  if (settings.brief_enabled !== 1) return "off: brief_enabled is off";
  if (env.BRIEF_SENDING !== "on") return "off: BRIEF_SENDING is not on";
  if (!env.RESEND_API_KEY) return "off: RESEND_API_KEY is not set";
  if (!env.BRIEF_FROM) return "off: BRIEF_FROM is not set";
  if (!settings.brief_email) return "off: no brief_email is set in the settings";
  if (!isOwnerAddress(env, settings, settings.brief_email)) return "off: brief address isn't an owner email";
  return null;
}

export async function sendBrief(
  env: Env,
  brief: { subject: string; text: string },
  settings: SendSettings,
): Promise<SendResult> {
  const blocker = sendBlocker(env, settings);
  if (blocker !== null) return { sent: false, reason: blocker };
  try {
    const response = await fetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.BRIEF_FROM, to: [settings.brief_email], subject: brief.subject, text: brief.text }),
    });
    return response.ok ? { sent: true } : { sent: false, reason: `failed: ${response.status}` };
  } catch {
    return { sent: false, reason: "failed: network error" };
  }
}
