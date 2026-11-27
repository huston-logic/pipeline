// /companies: the People tab's Companies view. Contacts grouped by company (their `business`, compared ignoring case and
// spaces), each with its people, open deals and open value; "No company" last. A company name from outside is
// labelled and never becomes a link or part of a URL (decision 0016).
import { ownerTimezone } from "../../services/lookup.ts";
import { type CompanyGroup, listCompanies } from "../../services/read.ts";
import { type Html, html } from "../html.ts";
import type { PageContext } from "../context.ts";
import { renderPage } from "../layout.ts";
import { contactLink, count, dealLink, empty, formatNumber, labelled } from "../parts.ts";
import { peopleSwitch } from "../people-switch.ts";

/** "2 open deals, value 17,900", "1 open deal", "No open deals". */
function openLine(group: CompanyGroup): string {
  if (group.openDealCount === 0) return "No open deals";
  const value = group.openValue > 0 ? `, value ${formatNumber(group.openValue)}` : "";
  return `${count(group.openDealCount, "open deal")}${value}`;
}

function companyCard(group: CompanyGroup): Html {
  const title = group.name === null ? "No account" :labelled(group.name, group.nameOutside);
  return html`<li class="card">
<h2 class="card-title">${title}</h2>
<p class="card-sub">${openLine(group)}</p>
<h3 class="card-sub-head">People</h3>
<ul class="card-links">${group.contacts.map((c) => html`<li>${contactLink(c.id, c.name, c.untrusted_fields.includes("name"))}</li>`)}</ul>
${
  group.openDeals.length === 0
    ? ""
    : html`<h3 class="card-sub-head">Open deals</h3>
<ul class="card-links">${group.openDeals.map(
        (deal) =>
          html`<li>${dealLink(deal.id, deal.title, deal.untrusted_fields.includes("title"))} <span class="card-link-meta">${deal.stageLabel}</span></li>`,
      )}</ul>`
}
</li>`;
}

export async function companiesPage(ctx: PageContext): Promise<string> {
  const { db, now } = ctx;
  const tz = await ownerTimezone(db);
  const { companies, noCompany } = await listCompanies(db, now, tz);
  const groups = noCompany === null ? companies : [...companies, noCompany];
  const people = groups.reduce((sum, group) => sum + group.contacts.length, 0);
  const body =
    companies.length === 0
      ? html`${empty("No accounts yet.", "A contact's account shows up here once it is set, by your website form or by talking to your AI app.")}
${noCompany === null ? "" : html`<ul class="cards cards-wide">${companyCard(noCompany)}</ul>`}`
      : html`<p class="lede">${count(companies.length, "account", "accounts")}, ${count(people, "person", "people")}.</p>
<ul class="cards cards-wide">${groups.map(companyCard)}</ul>`;
  return renderPage({
    title: "Accounts",
    description: "Your contacts grouped by account, with each account's people, open deals and open value.",
    current: "/companies",
    frame: ctx,
    body: html`<h1>Accounts</h1>
${await peopleSwitch(ctx.db, "companies")}
${body}`,
  });
}
