// /notifications (decision 0030): turn the brief notification on for this browser, see the devices it goes to, turn
// one off, and send a test. Turning on needs push.js (the browser makes the subscription); without it, or without push
// in this browser, the page says so in one line. Without the copy's VAPID keys it says only that.
import type { PushSubscriptionRow } from "../../db/db.ts";
import { deviceTag, listLivePush } from "../../push/subscriptions.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { formatLocal } from "../../time.ts";
import type { PageContext } from "../context.ts";
import { type FormContext, formBasics, hidden, postForm } from "../forms.ts";
import { type Html, html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { count, when } from "../parts.ts";

export const NOTIFICATIONS_PATH = "/notifications";
export const NO_KEYS = "This copy has no notification keys yet.";
export const pushOffAction = (id: string) => `${NOTIFICATIONS_PATH}/${encodeURIComponent(id)}/off`;
/** Turn off on this phone: the browser's own endpoint, filled in by push.js. */
export const PUSH_OFF_HERE_PATH = `${NOTIFICATIONS_PATH}/off`;

const SMALL_NUMBER = /^\d{1,4}$/;

/** The one line after a write that made no change: a test send's counts, or "already on". Built from fixed words. */
export function pushNote(query: URLSearchParams): string | null {
  if (query.get("note") === "already") return "Notifications are already on for this device.";
  const [sent, gone, failed] = ["sent", "gone", "failed"].map((name) => query.get(name) ?? "");
  if (sent === undefined || gone === undefined || failed === undefined) return null;
  if (![sent, gone, failed].every((value) => SMALL_NUMBER.test(value))) return null;
  const [s, g, f] = [Number(sent), Number(gone), Number(failed)];
  if (s + g + f === 0) return "No device has notifications on, so nothing was sent.";
  const parts = [`Test sent to ${count(s, "device")}.`];
  if (g > 0) {
    parts.push(g === 1 ? "1 device no longer accepts notifications and was turned off." : `${g} devices no longer accept notifications and were turned off.`);
  }
  if (f > 0) parts.push(`${f} couldn't be reached. Try again later.`);
  return parts.join(" ");
}

/**
 * Turn on, and Turn off on this phone. push.js shows one of them: Turn off when this browser's subscription is one
 * the page lists (it fills the endpoint field from the browser itself), Turn on otherwise.
 */
function thisDeviceForms(form: FormContext, publicKey: string): Html {
  return html`<p data-push-unsupported>This browser can't turn notifications on. On an iPhone, add the board to the Home Screen first and open it from there.</p>
<form class="push-on" method="post" action="${NOTIFICATIONS_PATH}/on" data-push-key="${publicKey}" data-push-status="push-status" hidden>${formBasics(form)}${hidden("endpoint", "")}${hidden("p256dh", "")}${hidden("auth", "")}
<button class="button" type="submit">Turn on notifications</button>
</form>
<form class="push-off" method="post" action="${PUSH_OFF_HERE_PATH}" data-push-off hidden>${formBasics(form)}${hidden("endpoint", "")}
<p class="row-text">Notifications are on for this phone.</p>
<button class="button button-quiet" type="submit">Turn off on this phone</button>
</form>
<p class="push-status" id="push-status" role="status"></p>`;
}

/**
 * Each row carries its endpoint's SHA-256 (data-push-device), so push.js can mark the one that is this browser
 * without the page ever showing an endpoint.
 */
async function deviceList(devices: PushSubscriptionRow[], form: FormContext, tz: string): Promise<Html> {
  if (devices.length === 0) return html`<p class="section-note">No device has notifications on yet.</p>`;
  const tags = await Promise.all(devices.map((device) => deviceTag(device.endpoint)));
  const rows = devices.map(
    (device, i) => html`<li data-push-device="${tags[i] ?? ""}">
<p class="row-text">Device ${i + 1}, on since ${when(device.created_at, formatLocal(device.created_at, tz))} <span class="tag" data-push-here hidden>This phone</span></p>
${postForm(
  "row-form",
  pushOffAction(device.id),
  form,
  html`<button class="button button-quiet" type="submit">Turn off<span class="visually-hidden"> notifications on device ${i + 1}</span></button>`,
)}
</li>`,
  );
  return html`<ul class="panel rows push-devices">${rows}</ul>
${postForm("push-test", `${NOTIFICATIONS_PATH}/test`, form, html`<button class="button" type="submit">Send a test</button>`)}`;
}

/** `publicKey` is this copy's VAPID public key (public by design), or null when push isn't set up. */
export async function notificationsPage(ctx: PageContext, publicKey: string | null): Promise<string> {
  const note = pushNote(ctx.query);
  const head = html`<h1>Notifications</h1>
<p class="lede">Get a notification on your phone when the daily brief is ready. It only says the brief is ready.</p>
${note === null ? "" : html`<p class="push-note" role="status">${note}</p>`}`;
  if (publicKey === null) {
    return renderPage({
      title: "Notifications",
      description: "A phone notification when the daily brief is ready.",
      current: NOTIFICATIONS_PATH,
      frame: ctx,
      body: html`${head}
<p class="section-note">${NO_KEYS}</p>`,
    });
  }
  const form: FormContext = { csrf: ctx.csrf, here: NOTIFICATIONS_PATH };
  const devices = await listLivePush(ctx.db);
  return renderPage({
    title: "Notifications",
    description: "A phone notification when the daily brief is ready: turn it on, send a test, or turn a device off.",
    current: NOTIFICATIONS_PATH,
    frame: ctx,
    script: "push",
    body: html`${head}
<section aria-labelledby="this-device">
<h2 id="this-device">This device</h2>
${thisDeviceForms(form, publicKey)}
</section>
<section aria-labelledby="devices">
<h2 id="devices">Devices with notifications on</h2>
${await deviceList(devices, form, await ownerTimezone(ctx.db))}
</section>`,
  });
}
