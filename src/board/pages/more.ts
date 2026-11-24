// /more: the pages that don't fit the phone's tab bar. A real page, so it works without JavaScript.
import { html } from "../html.ts";
import { icon } from "../icons.ts";
import type { PageContext } from "../context.ts";
import { renderPage } from "../layout.ts";
import { moreItemsFor } from "../routes.ts";

export async function morePage(ctx: PageContext): Promise<string> {
  const items = moreItemsFor(ctx.timeTracking === true);
  return renderPage({
    title: "More",
    description: "Your rules, the change log, the export download, the import, phone notifications and the email logging address.",
    current: "/more",
    frame: ctx,
    body: html`<h1>More</h1>
<ul class="cards more-list">${items.map(
      (item) => html`<li><a class="card card-link" href="${item.href}"><span class="tile">${icon(item.icon)}</span><span class="card-link-text"><span class="card-title">${item.label}</span>
<span class="card-desc">${item.description}</span></span></a></li>`,
    )}</ul>`,
  });
}
