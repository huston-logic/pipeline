import { html } from "../html.ts";
import { renderPage } from "../layout.ts";

export function notFoundPage(): string {
  return renderPage({
    title: "Page not found · Pipeline",
    description: "There is no board page at this address.",
    body: html`<h1>Page not found</h1>
<p>There is no board page at this address.</p>
<p><a href="/">Go to the board</a></p>`,
  });
}

/** Shown when reading the data failed. It names no internals; the Worker logs a fixed event name. */
export function serverErrorPage(): string {
  return renderPage({
    title: "Something went wrong · Pipeline",
    description: "The board could not be drawn because of a problem on the server.",
    body: html`<h1>Something went wrong</h1>
<p>The board could not read your data just now. Nothing was changed. Reload the page to try again.</p>
<p><a href="/">Go to the board</a></p>`,
  });
}
