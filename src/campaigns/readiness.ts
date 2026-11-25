// Whether campaign email can be sent from this copy, and where replies go. The review page and the sender both ask.
import { parseOwnerEmailsVar } from "../auth/owners.ts";
import type { SettingsRow } from "../db/db.ts";
import type { Env } from "../env.ts";
import { parseStringArray } from "../services/lookup.ts";

const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const NAMED = /^([^<>"\r\n]+) <([^<>"\s]+)>$/;

/** A plain address or `Name <address>` on one line; the name has no `<>"` characters. */
function wellFormedFrom(from: string): boolean {
  if (from.length > 254 || /[\r\n]/.test(from)) return false;
  const named = NAMED.exec(from);
  return ADDRESS.test(named?.[2] ?? from);
}

const notSetUp = (piece: string) =>
  `Sending isn't set up for this copy yet: it needs its ${piece}. Whoever installed this app sets it.`;

/** The address replies go to: the first owner email in the settings, else the first in OWNER_EMAILS, else null. */
export function replyTo(env: Pick<Env, "OWNER_EMAILS">, settings: Pick<SettingsRow, "owner_emails">): string | null {
  const stored = parseStringArray(settings.owner_emails).map((email) => email.trim()).find((email) => email !== "");
  return stored ?? parseOwnerEmailsVar(env.OWNER_EMAILS)[0] ?? null;
}

/** The plain sentence saying what stops sending, or null when it can send. The audience is not checked here. */
export function sendingBlocker(env: Env, settings: SettingsRow): string | null {
  if (settings.postal_address === null || settings.postal_address.trim() === "") {
    return "Add your business's postal address on Campaign settings. Every campaign email shows it.";
  }
  if (env.CAMPAIGN_SENDING !== "on") return notSetUp("sending switch");
  if (!env.CAMPAIGN_RESEND_API_KEY) return notSetUp("Resend key");
  if (!env.CAMPAIGN_FROM || !wellFormedFrom(env.CAMPAIGN_FROM)) return notSetUp("from address");
  if (replyTo(env, settings) === null) return "Add an owner email to the settings so replies reach you.";
  return null;
}
