// The campaign-email block on a person's page and the page that asks before an unsubscribe is lifted (decision 0053).
// Only an unsubscribe can be allowed again; a bounce or a spam complaint shows its reason and no button.
import { suppressionOf } from "../campaigns/audience.ts";
import { campaignEmailOf, liveUnsubscribes } from "../campaigns/suppressions.ts";
import type { ContactRow, Db } from "../db/db.ts";
import { getContact, getSettings } from "../db/queries.ts";
import { capital } from "../campaigns/drafts.ts";
import { contactName } from "../services/labels.ts";
import { formatLocal } from "../time.ts";
import type { PageContext } from "./context.ts";
import { hidden, postForm } from "./forms.ts";
import { type Html, html } from "./html.ts";
import { renderPage } from "./layout.ts";
import { section, when } from "./parts.ts";

export const campaignAllowPath = (id: string): string => `/contacts/${encodeURIComponent(id)}/campaign-emails/allow`;
const contactPath = (id: string): string => `/contacts/${encodeURIComponent(id)}`;

/** The "Campaign emails" section for a person a live suppression stops, or "" (also while campaigns are off). */
export async function campaignEmailsSection(ctx: PageContext, contact: ContactRow, tz: string): Promise<Html | ""> {
  if (!ctx.campaigns) return "";
  const block = await suppressionOf(ctx.db, { email: campaignEmailOf(contact), contactId: contact.id });
  if (block === null) return "";
  const date = when(block.created_at, formatLocal(block.created_at, tz));
  const line =
    block.reason === "unsubscribed"
      ? html`<p>Unsubscribed from campaign emails on ${date}.</p>
<p class="card-actions"><a href="${campaignAllowPath(contact.id)}">Allow campaign emails again</a></p>`
      : block.reason === "bounced"
        ? html`<p>Campaign emails stopped on ${date}: the address bounced.</p>`
        : html`<p>Campaign emails stopped on ${date}: they marked one as spam.</p>`;
  return section("campaign-emails-heading", "Campaign emails", html`<div class="card">${line}</div>`);
}

/** The person, when campaigns are on and an unsubscribe applies to them: what the confirm page and its post need. */
export async function allowable(db: Db, id: string): Promise<ContactRow | null> {
  if ((await getSettings(db)).campaigns !== 1) return null;
  const contact = await getContact(db, id);
  if (contact === null || (await liveUnsubscribes(db, contact)).length === 0) return null;
  return contact;
}

/** GET /contacts/<id>/campaign-emails/allow: asks first. 404 unless there is an unsubscribe to lift. */
export async function campaignAllowPage(ctx: PageContext, id: string): Promise<string | null> {
  const contact = await allowable(ctx.db, id);
  if (contact === null) return null;
  return confirmPage(ctx, contact);
}

export function confirmPage(ctx: Pick<PageContext, "csrf" | "look" | "campaigns">, contact: ContactRow): string {
  const back = contactPath(contact.id);
  const name = capital(contactName(contact));
  return renderPage({
    title: "Allow campaign emails again?",
    description: "Lifts a person's unsubscribe from campaign emails, so it asks first. Confirm, or go back.",
    current: back,
    frame: { look: ctx.look, campaigns: ctx.campaigns },
    body: html`<h1>Allow campaign emails again?</h1>
<p class="lede">${name} asked not to get campaign emails. Only allow them again if they asked you to.</p>
${postForm(
  "confirm",
  campaignAllowPath(contact.id),
  { csrf: ctx.csrf, here: back },
  html`${hidden("confirm", "yes")}
<div class="confirm-actions">
<button class="button" type="submit">Allow campaign emails</button>
<a class="confirm-cancel" href="${back}">Go back</a>
</div>`,
)}`,
  });
}
