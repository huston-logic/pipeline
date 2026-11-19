// Phone actions on the deal and contact pages (decision 0021): Call, Text and Email through the phone's own apps, then
// one tap to log it. A phone or email (often outside text) becomes a tel:, sms: or mailto: target only after the strict
// checks below; anything else gets no button. The link text is fixed; the card's own rows show the value, labelled.
import { type FormContext, hidden, postForm } from "./forms.ts";
import { type Html, html } from "./html.ts";
import { logAction } from "./log-form.ts";
import type { Subject } from "./task-forms.ts";

/** The number as a dial string: a leading + and 7 to 15 ASCII digits once spaces, dashes, dots and brackets are gone. */
export function dialable(phone: string | null): string | null {
  if (phone === null) return null;
  const cleaned = phone.replace(/[ ().-]/g, "");
  return /^\+?[0-9]{7,15}$/.test(cleaned) ? cleaned : null;
}

const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
const EMAIL = new RegExp(`^[A-Za-z0-9._+-]{1,64}@${LABEL}(?:\\.${LABEL})+$`);

/** The address as it is when it matches the strict pattern (no query, no encoding, nothing but an address), else null. */
export function mailable(email: string | null): string | null {
  if (email === null || email.length > 254) return null;
  return EMAIL.test(email) ? email : null;
}

export type ReachContact = { id: string; phone: string | null; email: string | null; untrusted_fields: readonly string[] };

type Channel = { key: "call" | "text" | "email"; href: string; link: string; type: string; summary: string; log: string };

const blank = (value: string | null) => value === null || value.trim() === "";

const logId = (key: Channel["key"]) => `reach-log-${key}`;

function logButton(channel: Channel, subject: Subject, form: FormContext): Html {
  return postForm(
    "reach-log-form",
    logAction(subject),
    form,
    html`${hidden("type", channel.type)}${hidden("summary", channel.summary)}<button class="button button-quiet reach-log-button" id="${logId(channel.key)}" type="submit">${channel.log}</button>`,
  );
}

/** "Called, texted or emailed?", or the part that applies. */
function hint(channels: Channel[]): string {
  const keys = new Set(channels.map((channel) => channel.key));
  if (keys.has("call") && keys.has("email")) return "Called, texted or emailed? Log it in one tap.";
  if (keys.has("call")) return "Called or texted? Log it in one tap.";
  return "Emailed? Log it in one tap.";
}

/**
 * Call, Text and Email for the contact's usable phone and email, then a one-tap Log form for each, posting to the
 * subject's log route (the deal on the deal page, the contact on the contact page). Nothing when neither is on file.
 */
export function reachActions(contact: ReachContact, subject: Subject, form: FormContext): Html | "" {
  const phone = dialable(contact.phone);
  const email = mailable(contact.email);
  const channels: Channel[] = [];
  if (phone !== null) {
    channels.push({ key: "call", href: `tel:${phone}`, link: "Call", type: "call", summary: "Called.", log: "Log the call" });
    channels.push({ key: "text", href: `sms:${phone}`, link: "Text", type: "note", summary: "Sent a text message.", log: "Log the text" });
  }
  if (email !== null) {
    channels.push({ key: "email", href: `mailto:${email}`, link: "Email", type: "email", summary: "Sent an email.", log: "Log the email" });
  }
  const notes = [
    !blank(contact.phone) && phone === null &&
      "The phone number can't be dialled as written, so there is no Call or Text button. Edit the contact to fix it.",
    !blank(contact.email) && email === null &&
      "The email address isn't one this page can link to, so there is no Email button. Edit the contact to fix it.",
  ].filter((note): note is string => typeof note === "string");
  if (channels.length === 0 && notes.length === 0) return "";
  const noteLines = notes.map((note) => html`<p class="reach-note">${note}</p>`);
  if (channels.length === 0) return html`<div class="reach">${noteLines}</div>`;
  return html`<div class="reach">
<div class="reach-buttons">${channels.map(
    (channel) => html`<a class="button reach-button" href="${channel.href}" data-log="${logId(channel.key)}">${channel.link}</a>`,
  )}</div>
${noteLines}<div class="reach-log">
<p class="reach-log-hint">${hint(channels)}</p>
<div class="reach-log-buttons">${channels.map((channel) => logButton(channel, subject, form))}</div>
</div>
</div>`;
}
