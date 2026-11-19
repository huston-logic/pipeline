// Small pieces every board page uses. Outside text (a form, an import) is always escaped by `html`, carries the
// visible "From outside" label (text, never color alone) and is never the text or target of a link.
import { type Html, html } from "./html.ts";

export const OUTSIDE_LABEL = "From outside";

export const outsideLabel = (): Html => html`<span class="outside">${OUTSIDE_LABEL}</span>`;

/** A value, with the label in front when it came from outside. */
export function labelled(value: string, outside: boolean): Html {
  return outside ? html`${outsideLabel()} <span class="outside-value">${value}</span>` : html`${value}`;
}

export const dealHref = (id: string) => `/deals/${encodeURIComponent(id)}`;

/** A link to the deal page. Its text is the title only when the title did not come from outside. */
export function dealLink(id: string, title: string, outside: boolean): Html {
  if (!outside) return html`<a href="${dealHref(id)}">${title}</a>`;
  return html`<a href="${dealHref(id)}">Deal ${id}</a> ${outsideLabel()} <span class="outside-value">${title}</span>`;
}

export const contactHref = (id: string) => `/contacts/${encodeURIComponent(id)}`;

/** A link to the contact page. Its text is the name only when the name did not come from outside. */
export function contactLink(id: string, name: string, outside: boolean): Html {
  if (!outside) return html`<a href="${contactHref(id)}">${name}</a>`;
  return html`<a href="${contactHref(id)}">Contact ${id}</a> ${outsideLabel()} <span class="outside-value">${name}</span>`;
}

export const when = (iso: string, local: string): Html => html`<time datetime="${iso}">${local}</time>`;

/** "1 deal", "3 deals". */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const numbers = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** Deal values have no currency in v1, so they are plain numbers: "1,500". */
export const formatNumber = (n: number) => numbers.format(n);

/** An empty state: what is missing, then one line on how things get here. The help line never promises a button the
 * page doesn't have. */
export const empty = (text: string, help?: string): Html =>
  html`<div class="empty"><p class="empty-title">${text}</p>${help === undefined ? "" : html`<p>${help}</p>`}</div>`;

/** A neutral tag ("Active", a stage) or a warning one ("Overdue", "Paused"); the words carry the meaning. */
export const tag = (text: string, warn = false): Html => html`<span class="tag${warn ? " tag-warn" : ""}">${text}</span>`;

export type Pair = { name: string; value: Html | string };

/** Facts as label/value pairs. Rows that are null, false or undefined are left out. */
export function pairs(rows: (Pair | null | false | undefined)[]): Html | "" {
  const shown = rows.filter((row): row is Pair => typeof row === "object" && row !== null);
  if (shown.length === 0) return "";
  return html`<dl class="pairs">${shown.map((row) => html`<div><dt>${row.name}</dt><dd>${row.value}</dd></div>`)}</dl>`;
}

/** A section with an h2 and the id its aria-labelledby needs. */
export function section(id: string, heading: Html | string, body: Html | "", className = ""): Html {
  return html`<section${className === "" ? "" : html` class="${className}"`} aria-labelledby="${id}">
<h2 id="${id}">${heading}</h2>
${body}
</section>`;
}
