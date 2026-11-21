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

/** How long one push service may take to answer before that device counts as failed. */
export const PUSH_TIMEOUT_MS = 10_000;

export type PushOptions = { timeoutMs?: number };

async function pushOne(sub: PushSubscriptionRow, keys: VapidKeys, now: Date, timeoutMs: number): Promise<Outcome> {
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
      // A push service answers directly; a redirect (3xx) counts as a failure and is never followed.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    if (response.status === 404 || response.status === 410) return "gone";
    return response.status >= 200 && response.status < 300 ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

/** One push to every subscription that is on, all at once. Never throws for a single device's failure. */
export async function sendBriefPush(db: Db, env: Env, now: Date, options: PushOptions = {}): Promise<PushCounts> {
  const counts: PushCounts = { sent: 0, gone: 0, failed: 0 };
  const keys = vapidKeys(env);
  if (keys === null) return { ...counts, skipped: "no_keys" };
  const subs = await listLivePush(db);
  const settled = await Promise.allSettled(subs.map((sub) => pushOne(sub, keys, now, options.timeoutMs ?? PUSH_TIMEOUT_MS)));
  for (const [i, sub] of subs.entries()) {
    const result = settled[i];
    const outcome: Outcome = result?.status === "fulfilled" ? result.value : "failed";
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
