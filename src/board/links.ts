// Plain-text task descriptions with web addresses made into links. Only http and https addresses are ever linked, and
// only when the text is the owner's (text from outside is shown as plain text). Built with the `html` tag only.
import { type Html, html } from "./html.ts";

const ADDRESS = /https?:\/\/\S+/gi;
const SCHEME = /^https?:\/\//i;
const TRAILING = /[.,;:!?)]$/;

/** The text with each http(s) address a new-tab link when `trusted`; everything else is escaped text. */
export function linkify(text: string, trusted: boolean): Html {
  if (!trusted) return html`${text}`;
  const parts: Html[] = [];
  let last = 0;
  for (const match of text.matchAll(ADDRESS)) {
    const start = match.index ?? 0;
    const found = match[0];
    const address = found.replace(TRAILING, "");
    if (address.replace(SCHEME, "") === "") continue;
    parts.push(html`${text.slice(last, start)}<a href="${address}" target="_blank" rel="noopener noreferrer">${address}</a>`);
    last = start + address.length;
  }
  parts.push(html`${text.slice(last)}`);
  return html`${parts}`;
}
