import { html } from "../html.ts";
import { renderPage } from "../layout.ts";

export function homePage(): string {
  return renderPage({
    title: "Pipeline",
    description: "Your sales pipeline: deals by stage, follow-ups due and the daily brief.",
    current: "/",
    body: html`<h1>Pipeline</h1>
<p>Your deals, follow-ups and daily brief will show here once the database is set up.</p>`,
  });
}
