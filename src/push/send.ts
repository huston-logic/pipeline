// Sends the brief notification to every subscription that is on (decision 0030). Each push is one POST to the
// browser's push service: the fixed payload {"kind":"brief"}, encrypted for that browser (RFC 8291), signed with this
// copy's VAPID key (RFC 8292). No customer data rides along. 404 and 410 mean the subscription is gone: it is turned
// off in a system change. Results are counts only; no endpoint is ever returned or logged.
import type { Db, PushSubscriptionRow } from "../db/db.ts";
import type { Env } from "../env.ts";
import { UserError } from "../services/errors.ts";
import { utf8 } from "./bytes.ts";
import { encryptPayload } from "./encrypt.ts";
import { listLivePush, markPushGone } from "./subscriptions.ts";
import { type VapidKeys, vapidHeaders, vapidKeys } from "./vapid.ts";

export const BRIEF_PAYLOAD = '{"kind":"brief"}';

/** A day: a phone that is off overnight still gets the morning's notice; after that it is stale. */
const TTL_SECONDS = "86400";

export type PushCounts = { sent: number; gone: number; failed: number; skipped?: "no_keys" };

type Outcome = "sent" | "gone" | "failed";

async function pushOne(sub: PushSubscriptionRow, keys: VapidKeys, now: Date): Promise<Outcome> {
  try {
    const body = await encryptPayload(utf8(BRIEF_PAYLOAD), sub);
    const response = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        ...(await vapidHeaders(sub.endpoint, keys, now)),
        TTL: TTL_SECONDS,
        Urgency: "normal",
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
      },
      body,
    });
    await response.body?.cancel();
    if (response.status === 404 || response.status === 410) return "gone";
    return response.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

/** One push to every subscription that is on. Never throws for a single device's failure. */
export async function sendBriefPush(db: Db, env: Env, now: Date): Promise<PushCounts> {
  const counts: PushCounts = { sent: 0, gone: 0, failed: 0 };
  const keys = vapidKeys(env);
  if (keys === null) return { ...counts, skipped: "no_keys" };
  for (const sub of await listLivePush(db)) {
    const outcome = await pushOne(sub, keys, now);
    if (outcome === "gone") {
      try {
        await markPushGone({ db, now, actor: "system", tool: "push_send" }, sub.id);
      } catch (error) {
        // Turned off or changed by the owner a moment ago: it is not sent to again either way.
        if (!(error instanceof UserError)) throw error;
      }
    }
    counts[outcome] += 1;
  }
  return counts;
}
