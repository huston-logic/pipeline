import { html } from "../html.ts";
import { renderPage } from "../layout.ts";

/** The static out/index.html. The Worker draws the real board, so this shows only when the Worker is not running. */
export function offlinePage(): string {
  return renderPage({
    title: "Board",
    description: "The Pipeline board is drawn by its Worker, which is not running.",
    body: html`<h1>Pipeline</h1>
<p class="lede">The board is not running. It is drawn by the Pipeline Worker, so this page shows only when the Worker is off.</p>`,
  });
}
