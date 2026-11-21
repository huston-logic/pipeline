// The Notifications page's write routes (decision 0030), listed in the route table in actions.ts so post.ts runs the
// sign-in, origin, body and CSRF checks first (decision 0017). Turn on and both Turn offs are audited owner changes; Send a
// test pushes to every device that is on and comes back with counts only.
import { isPushId } from "../ids.ts";
import { sendBriefPush } from "../push/send.ts";
import { removePush, removePushByEndpoint, subscribePush } from "../push/subscriptions.ts";
import { vapidKeys } from "../push/vapid.ts";
import { UserError } from "../services/errors.ts";
import { type ActionContext, type ActionResult, asOwner, notFound, page, redirect, refusedPage, type Route } from "./action-kit.ts";
import { NO_KEYS, NOTIFICATIONS_PATH } from "./pages/notifications.ts";
import { withChange } from "./return-to.ts";

/** Runs a handler only when this copy has its keys; refused handlers come back as a 422 with the message. */
async function withKeys(ctx: ActionContext, title: string, run: () => Promise<ActionResult>): Promise<ActionResult> {
  try {
    if (vapidKeys(ctx.env) === null) throw new UserError(NO_KEYS);
    return await run();
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    return page(422, refusedPage(ctx, title, error.message, NOTIFICATIONS_PATH, "", NOTIFICATIONS_PATH));
  }
}

/** POST /notifications/on: the subscription push.js made in this browser. */
function turnOn(ctx: ActionContext): Promise<ActionResult> {
  return withKeys(ctx, "Notifications weren't turned on", async () => {
    const field = (name: string) => ctx.form.get(name) ?? "";
    const result = await subscribePush(asOwner(ctx, "push_subscribe"), { endpoint: field("endpoint"), p256dh: field("p256dh"), auth: field("auth") });
    return redirect(result === null ? `${NOTIFICATIONS_PATH}?note=already` : withChange(NOTIFICATIONS_PATH, result.changeId));
  });
}

/** POST /notifications/test: one push to every device that is on. */
function sendTest(ctx: ActionContext): Promise<ActionResult> {
  return withKeys(ctx, "The test wasn't sent", async () => {
    const { sent, gone, failed } = await sendBriefPush(ctx.db, ctx.env, ctx.now);
    return redirect(`${NOTIFICATIONS_PATH}?${new URLSearchParams({ sent: String(sent), gone: String(gone), failed: String(failed) })}`);
  });
}

/** POST /notifications/<id>/off: turn one device off. Works without the keys too, so a device can always be removed. */
async function turnOff(ctx: ActionContext, id: string): Promise<ActionResult> {
  if (!isPushId(id)) return notFound(ctx);
  try {
    const result = await removePush(asOwner(ctx, "push_remove"), id);
    return redirect(withChange(NOTIFICATIONS_PATH, result.changeId));
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    return page(422, refusedPage(ctx, "Notifications weren't turned off", error.message, NOTIFICATIONS_PATH, "", NOTIFICATIONS_PATH));
  }
}

/** POST /notifications/off: Turn off on this phone, by the endpoint push.js read from this browser. */
async function turnOffHere(ctx: ActionContext): Promise<ActionResult> {
  try {
    const result = await removePushByEndpoint(asOwner(ctx, "push_remove"), ctx.form.get("endpoint") ?? "");
    return redirect(withChange(NOTIFICATIONS_PATH, result.changeId));
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    return page(422, refusedPage(ctx, "Notifications weren't turned off", error.message, NOTIFICATIONS_PATH, "", NOTIFICATIONS_PATH));
  }
}

export const PUSH_ROUTES: Route[] = [
  { path: /^\/notifications\/(on)$/, handle: (ctx) => turnOn(ctx) },
  { path: /^\/notifications\/(off)$/, handle: (ctx) => turnOffHere(ctx) },
  { path: /^\/notifications\/(test)$/, handle: (ctx) => sendTest(ctx) },
  { path: /^\/notifications\/([^/]+)\/off$/, handle: turnOff },
];
