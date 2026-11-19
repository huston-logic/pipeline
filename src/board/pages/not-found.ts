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
