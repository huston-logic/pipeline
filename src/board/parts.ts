// Small pieces every board page uses. Outside text (a form, an import) is always escaped by `html`, carries the
// visible "From outside" label (text, never color alone) and is never the text or target of a link.
import { Html, html } from "./html.ts";

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

export const when = (iso: string, local: string): Html => html`<time datetime="${iso}">${local}</time>`;

/** "1 deal", "3 deals". */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const numbers = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** Deal values have no currency in v1, so they are plain numbers: "1,500". */
export const formatNumber = (n: number) => numbers.format(n);

export const empty = (text: string): Html => html`<p class="empty">${text}</p>`;

/** One labelled fact in an item's meta line, for example "Contact: Pat Example". */
export const fact = (name: string, value: Html | string): Html =>
  html`<span class="fact"><span class="fact-name">${name}:</span> ${value}</span>`;

export function meta(parts: (Html | null | false | undefined)[]): Html | "" {
  const shown = parts.filter((part): part is Html => part instanceof Html);
  return shown.length === 0 ? "" : html`<p class="meta">${shown}</p>`;
}
