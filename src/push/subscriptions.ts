// Push subscriptions (decision 0030): one row per browser that turned notifications on. Turning on, turning off and
// "gone" (the push service refused it) are audited changes, so each shows in Changes and can be undone. Summaries name
// a subscription by id only: the endpoint is never put in a summary, an error or a log.
import type { Db, PushSubscriptionRow } from "../db/db.ts";
import { newId } from "../ids.ts";
import { type ChangeResult, commitChange, type Ctx, updatedRow } from "../services/change.ts";
import { capitalize } from "../services/describe.ts";
import { UserError } from "../services/errors.ts";
import { pushLabel } from "../services/labels.ts";
import { base64UrlBytes } from "./bytes.ts";

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

/** The subscriptions notifications go to, oldest first. */
export async function listLivePush(db: Db): Promise<PushSubscriptionRow[]> {
  const found = await db.prepare("SELECT * FROM push_subscriptions WHERE gone_at IS NULL ORDER BY created_at, id").all<PushSubscriptionRow>();
  return found.results;
}

/**
 * Turns notifications on for one browser. Null when that endpoint is already on (no change). An endpoint that was
 * turned off comes back on as the same row, with the browser's current keys.
 */
export async function subscribePush(ctx: Ctx, raw: PushInput): Promise<ChangeResult | null> {
  const input = checkInput(raw);
  const known = await byEndpoint(ctx.db, input.endpoint);
  if (known !== null && known.gone_at === null) return null;
  const at = ctx.now.toISOString();
  if (known !== null) {
    const after = updatedRow(known, { p256dh: input.p256dh, auth: input.auth, gone_at: null }, ctx.now);
    return commitChange(ctx, {
      target: { table: "push_subscriptions", id: known.id },
      summary: `Turned on ${pushLabel(known.id)}`,
      changes: [{ table: "push_subscriptions", id: known.id, before: known, after }],
    });
  }
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

/** The push service said the subscription is gone (404 or 410). Null when it is already off. */
export async function markPushGone(ctx: Ctx, id: string): Promise<ChangeResult | null> {
  const row = await byId(ctx.db, id);
  if (row === null || row.gone_at !== null) return null;
  return turnOff(ctx, row, `Turned off ${pushLabel(row.id)}: the push service no longer accepts them`);
}
