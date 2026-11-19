// /contacts: every contact that is not archived, by name, as a card. Task R2 adds search, sorting and contact pages.
import type { Db } from "../../db/db.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { type ContactListItem, listContacts } from "../../services/read.ts";
import { type Html, html } from "../html.ts";
import { type Look, renderPage } from "../layout.ts";
import { count, dealLink, empty, labelled, pairs, when } from "../parts.ts";

function contactCard(contact: ContactListItem): Html {
  const outside = new Set<string>(contact.untrusted_fields);
  const deals = contact.openDeals;
  return html`<li class="card">
<div class="card-head">
<h2 class="card-title">${labelled(contact.name, outside.has("name"))}</h2>
</div>
${pairs([
  contact.business !== null && contact.business !== "" && { name: "Company", value: labelled(contact.business, outside.has("business")) },
  { name: "Open deals", value: deals.length === 0 ? "None" : String(deals.length) },
  {
    name: "Last activity",
    value:
      contact.lastActivityAt === null || contact.lastActivityAtLocal === null
        ? "None logged yet"
        : when(contact.lastActivityAt, contact.lastActivityAtLocal),
  },
])}
${
  deals.length === 0
    ? ""
    : html`<ul class="card-links">${deals.map((deal) => html`<li>${dealLink(deal.id, deal.title, deal.untrusted_fields.includes("title"))}</li>`)}</ul>`
}
</li>`;
}

export async function contactsPage(db: Db, _now: Date, look: Look): Promise<string> {
  const tz = await ownerTimezone(db);
  const contacts = await listContacts(db, tz);
  return renderPage({
    title: "Contacts",
    description: "Everyone in your pipeline, by name, with their company, open deals and last activity.",
    current: "/contacts",
    look,
    body: html`<h1>Contacts</h1>
${
  contacts.length === 0
    ? empty("No contacts yet.", "People from your website form, and the ones you add by talking to your AI app, show up here.")
    : html`<p class="lede">${count(contacts.length, "contact")}, sorted by name.</p>
<ul class="cards">${contacts.map(contactCard)}</ul>`
}`,
  });
}
