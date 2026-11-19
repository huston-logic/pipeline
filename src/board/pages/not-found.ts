import { html } from "../html.ts";
import { type Look, renderPage } from "../layout.ts";

/** Also the static out/404.html, so it works without a look (no sign-in, no settings). */
export function notFoundPage(look?: Look): string {
  return renderPage({
    title: "Page not found",
    description: "There is no board page at this address.",
    look,
    body: html`<h1>Page not found</h1>
<p class="lede">There is no board page at this address.</p>
<p><a class="button" href="/">Go to Today</a></p>`,
  });
}

/** Shown when reading the data failed. It names no internals; the Worker logs a fixed event name. */
export function serverErrorPage(): string {
  return renderPage({
    title: "Something went wrong",
    description: "The board could not be drawn because of a problem on the server.",
    body: html`<h1>Something went wrong</h1>
<p class="lede">The board could not read your data just now. Nothing was changed. Reload the page to try again.</p>
<p><a class="button" href="/">Go to Today</a></p>`,
  });
}
