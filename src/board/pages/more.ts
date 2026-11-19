// /more: the pages that don't fit the phone's tab bar. A real page, so it works without JavaScript.
import { html } from "../html.ts";
import { icon } from "../icons.ts";
import { type Look, renderPage } from "../layout.ts";
import { moreItems } from "../routes.ts";

export function morePage(look: Look): string {
  return renderPage({
    title: "More",
    description: "Your rules, the change log and the export download.",
    current: "/more",
    look,
    body: html`<h1>More</h1>
<ul class="cards more-list">${moreItems.map(
      (item) => html`<li><a class="card card-link" href="${item.href}"><span class="tile">${icon(item.icon)}</span><span class="card-link-text"><span class="card-title">${item.label}</span>
<span class="card-desc">${item.description}</span></span></a></li>`,
    )}</ul>`,
  });
}
