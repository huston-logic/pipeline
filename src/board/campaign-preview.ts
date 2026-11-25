// A campaign email drawn in board markup for the review page (decision 0053). The CSP forbids framing the real HTML, so
// this reads the same parsed body (parseBody) and merges the first name the way renderEmail does. The unsubscribe line is
// plain text here: the link only exists in a sent email, with its own token.
import { type Block, type Inline, isHttpsUrl, parseBody } from "../campaigns/body.ts";
import { mergeFirstName } from "../campaigns/render.ts";
import type { CampaignStepRow } from "../db/db.ts";
import { type Html, html } from "./html.ts";

const EXTERNAL = html` target="_blank" rel="noopener noreferrer"`;

export type PreviewFrame = { business: string; postal: string | null; firstName: string };

function inline(part: Inline, firstName: string): Html {
  if (part.kind === "text") return html`${mergeFirstName(part.text, firstName)}`;
  return html`<a href="${part.href}"${EXTERNAL}>${mergeFirstName(part.text, firstName)}</a>`;
}

function paragraph(block: Block, firstName: string): Html {
  const rows = block.lines.map((line) => line.map((part) => inline(part, firstName)));
  return html`<p>${rows.flatMap((row, i) => (i === 0 ? [row] : [html`<br>`, row]))}</p>`;
}

const lines = (text: string): string[] => text.replace(/\r\n?/g, "\n").split("\n");

/** The email's body, button and footer for one person's merged first name. */
export function campaignPreview(step: CampaignStepRow, frame: PreviewFrame): Html {
  const button =
    step.button_label !== null && step.button_url !== null && isHttpsUrl(step.button_url)
      ? html`<p><a class="button" href="${step.button_url}"${EXTERNAL}>${step.button_label}</a></p>`
      : "";
  const postal = frame.postal === null ? "" : frame.postal;
  return html`<div class="email-preview">
${parseBody(step.body).map((block) => paragraph(block, frame.firstName))}
${button}
<p class="email-preview-footer">${frame.business}${lines(postal).filter((line) => line !== "").map((line) => html`<br>${line}`)}<br>Unsubscribe from these emails</p>
</div>`;
}
