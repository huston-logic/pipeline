// Push subscriptions (decision 0030): one row per browser that turned notifications on. Turning on, turning off and
// "gone" (the push service refused it) are audited changes, so each shows in Changes and can be undone. Summaries name
// a subscription by id only: the endpoint is never put in a summary, an error or a log.
import type { Db, PushSubscriptionRow } from "../db/db.ts";
import { newId } from "../ids.ts";
import { type ChangeResult, commitChange, type Ctx, updatedRow } from "../services/change.ts";
import { capitalize } from "../services/describe.ts";
import { UserError } from "../services/errors.ts";
import { pushLabel } from "../services/labels.ts";
import { base64UrlBytes, utf8 } from "./bytes.ts";

export type PushInput = { endpoint: string; p256dh: string; auth: string };

export const MAX_ENDPOINT_LENGTH = 1000;

const NOT_USABLE = "That isn't a notification subscription this board can use. Turn notifications on again from the Notifications page.";

function checkEndpoint(endpoint: string): string {
  if (endpoint.length === 0 || endpoint.length > MAX_ENDPOINT_LENGTH) throw new UserError(NOT_USABLE);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new UserError(NOT_USABLE);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") throw new UserError(NOT_USABLE);
  return endpoint;
}

function checkInput(input: PushInput): PushInput {
  const point = base64UrlBytes(input.p256dh, 65);
  if (point === null || point[0] !== 0x04 || base64UrlBytes(input.auth, 16) === null) throw new UserError(NOT_USABLE);
  return { endpoint: checkEndpoint(input.endpoint), p256dh: input.p256dh, auth: input.auth };
}

const byEndpoint = (db: Db, endpoint: string) =>
  db.prepare("SELECT * FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).first<PushSubscriptionRow>();

const byId = (db: Db, id: string) => db.prepare("SELECT * FROM push_subscriptions WHERE id = ?").bind(id).first<PushSubscriptionRow>();

/**
 * The endpoint's SHA-256 in hex: what the board page puts on a device's row so push.js, which hashes its own
 * subscription's endpoint the same way, can mark "This phone". One-way, so the page never shows an endpoint.
 */
export async function deviceTag(endpoint: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(endpoint)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The subscriptions notifications go to, oldest first. */
export async function listLivePush(db: Db): Promise<PushSubscriptionRow[]> {
  const found = await db.prepare("SELECT * FROM push_subscriptions WHERE gone_at IS NULL ORDER BY created_at, id").all<PushSubscriptionRow>();
  return found.results;
}

/** More devices than one owner uses; the cap keeps each brief's pushes few and quick. */
export const MAX_LIVE_SUBSCRIPTIONS = 20;

const liveCount = async (db: Db) =>
  (await db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE gone_at IS NULL").first<{ n: number }>())?.n ?? 0;

async function checkRoom(db: Db): Promise<void> {
  if ((await liveCount(db)) >= MAX_LIVE_SUBSCRIPTIONS) {
    throw new UserError(
      `Notifications are on for ${MAX_LIVE_SUBSCRIPTIONS} devices already, the most this board allows. Turn one off on the Notifications page first.`,
    );
  }
}

/**
 * Turns notifications on for one browser. Null when that endpoint is already on with the same keys (no change); new
 * keys for it are stored as a change. An endpoint that was turned off comes back on as the same row, with the
 * browser's current keys. At most MAX_LIVE_SUBSCRIPTIONS devices are on at once.
 */
export async function subscribePush(ctx: Ctx, raw: PushInput): Promise<ChangeResult | null> {
  const input = checkInput(raw);
  const known = await byEndpoint(ctx.db, input.endpoint);
  if (known !== null && known.gone_at === null && known.p256dh === input.p256dh && known.auth === input.auth) return null;
  const at = ctx.now.toISOString();
  if (known !== null) {
    const wasOn = known.gone_at === null;
    if (!wasOn) await checkRoom(ctx.db);
    const after = updatedRow(known, { p256dh: input.p256dh, auth: input.auth, gone_at: null }, ctx.now);
    return commitChange(ctx, {
      target: { table: "push_subscriptions", id: known.id },
      summary: wasOn ? `Updated the keys of ${pushLabel(known.id)}` : `Turned on ${pushLabel(known.id)}`,
      changes: [{ table: "push_subscriptions", id: known.id, before: known, after }],
    });
  }
  await checkRoom(ctx.db);
  const id = newId("ps");
  const row: PushSubscriptionRow = { id, ...input, created_at: at, gone_at: null, version: 1, updated_at: at };
  return commitChange(ctx, {
    target: { table: "push_subscriptions", id },
    summary: `Turned on ${pushLabel(id)}`,
    changes: [{ table: "push_subscriptions", id, before: null, after: row }],
  });
}

async function turnOff(ctx: Ctx, row: PushSubscriptionRow, summary: string): Promise<ChangeResult> {
  const after = updatedRow(row, { gone_at: ctx.now.toISOString() }, ctx.now);
  return commitChange(ctx, {
    target: { table: "push_subscriptions", id: row.id },
    summary,
    changes: [{ table: "push_subscriptions", id: row.id, before: row, after }],
  });
}

/** The owner turns one device off (the board's Turn off). */
export async function removePush(ctx: Ctx, id: string): Promise<ChangeResult> {
  const row = await byId(ctx.db, id);
  if (row === null) throw new UserError("There's no device with that id. Reload the Notifications page and try again.");
  if (row.gone_at !== null) throw new UserError(`${capitalize(pushLabel(row.id))} is already off. Nothing to do.`);
  return turnOff(ctx, row, `Turned off ${pushLabel(row.id)}`);
}

/**
 * The owner turns off the browser they are using (the board's "Turn off on this phone"): found by the endpoint
 * push.js read from that browser, then the same audited change as removePush.
 */
export async function removePushByEndpoint(ctx: Ctx, endpoint: string): Promise<ChangeResult> {
  const row = endpoint === "" ? null : await byEndpoint(ctx.db, endpoint);
  if (row === null || row.gone_at !== null) {
    throw new UserError("Notifications aren't on for this device. Reload the Notifications page to see which devices are on.");
  }
  return turnOff(ctx, row, `Turned off ${pushLabel(row.id)}`);
}

/** The push service said the subscription is gone (404 or 410). Null when it is already off. */
export async function markPushGone(ctx: Ctx, id: string): Promise<ChangeResult | null> {
  const row = await byId(ctx.db, id);
  if (row === null || row.gone_at !== null) return null;
  return turnOff(ctx, row, `Turned off ${pushLabel(row.id)}: the push service no longer accepts them`);
}
