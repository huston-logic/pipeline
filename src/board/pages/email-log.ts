// /email-log: the copy's email logging address to copy, and how to use it (decision 0031). Shown only behind the board
// sign-in, in a read-only field: never in a link, the title or the description.
import { html } from "../html.ts";
import type { PageContext } from "../context.ts";
import { renderPage } from "../layout.ts";

export const EMAIL_LOG_PATH = "/email-log";

const FIELD = "log-address";

function addressCard(address: string) {
  return html`<p class="lede">To log an email, add this address in Bcc when you write to a lead or contact.</p>
<div class="card copy-card">
<div class="field">
<label for="${FIELD}">Log address</label>
<input id="${FIELD}" type="text" value="${address}" readonly spellcheck="false" autocapitalize="off" autocomplete="off">
</div>
<div class="copy-tools">
<button class="button button-quiet button-small" type="button" data-copy="${FIELD}" data-copy-status="${FIELD}-status" data-copy-fail="Couldn't copy. Select the address and copy it yourself." hidden>Copy address</button>
<p class="copy-status" id="${FIELD}-status" aria-live="polite"></p>
</div>
</div>
<p class="section-note">Only mail you send from your own address is logged; replies from others are not.</p>`;
}

export async function emailLogPage(ctx: PageContext, address: string | null): Promise<string> {
  return renderPage({
    title: "Email logging",
    description: "The address to add in Bcc so an email you send to a lead or contact is logged on their timeline.",
    current: EMAIL_LOG_PATH,
    frame: ctx,
    script: address !== null,
    body: html`<h1>Email logging</h1>
${address === null ? html`<p class="lede">Email logging isn't set up for this copy.</p>` : addressCard(address)}`,
  });
}
