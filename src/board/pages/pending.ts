// /pending (run 10, area 5): the lists of record changes the AI app proposed and the owner has not yet approved, each
// with Approve and Discard, and the setting that says where AI changes are approved. A list's text is what the owner
// was shown when it was made: it holds only safe labels by construction and goes out through the html tag like any text.
import type { ProposalRow } from "../../db/db.ts";
import { getSettings } from "../../db/queries.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { listOpenProposals } from "../../services/proposals.ts";
import { formatLocal } from "../../time.ts";
import type { PageContext } from "../context.ts";
import { type FormContext, postForm } from "../forms.ts";
import { type Html, html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { empty, when } from "../parts.ts";

export const PENDING_PATH = "/pending";
export const pendingAction = (id: string, verb: "approve" | "discard") => `${PENDING_PATH}/${encodeURIComponent(id)}/${verb}`;
export const APPROVAL_PATH = "/pending/approval";

const timeOnly = (iso: string, tz: string) => formatLocal(iso, tz).split(", ").at(-1) ?? iso;

function proposalCard(row: ProposalRow, form: FormContext, tz: string): Html {
  const at = timeOnly(row.created_at, tz);
  const lines = row.text.split("\n").filter((line) => line.trim() !== "");
  return html`<li class="card">
<p class="panel-note">Made ${when(row.created_at, formatLocal(row.created_at, tz))}. Expires ${when(row.expires_at, formatLocal(row.expires_at, tz))}.</p>
<ul class="rows">${lines.map((line) => html`<li>${line}</li>`)}</ul>
<div class="confirm-actions">
${postForm("row-form", pendingAction(row.id, "approve"), form, html`<button class="button" type="submit">Approve<span class="visually-hidden"> the list from ${at}</span></button>`)}
${postForm("row-form", pendingAction(row.id, "discard"), form, html`<button class="button button-quiet" type="submit">Discard<span class="visually-hidden"> the list from ${at}</span></button>`)}
</div>
</li>`;
}

const radio = (id: string, value: string, label: string, hint: string, checked: boolean): Html =>
  html`<div class="check"><input id="${id}" name="approve_in" type="radio" value="${value}" aria-describedby="${id}-hint"${checked ? " checked" : ""}><label for="${id}">${label}</label></div>
<p class="field-hint check-hint" id="${id}-hint">${hint}</p>`;

export async function pendingPage(ctx: PageContext): Promise<string> {
  const [rows, tz, settings] = await Promise.all([listOpenProposals(ctx.db, ctx.now), ownerTimezone(ctx.db), getSettings(ctx.db)]);
  const form: FormContext = { csrf: ctx.csrf, here: PENDING_PATH };
  const board = settings.ai_approval === "board";
  return renderPage({
    title: "Pending changes",
    description: "Changes your AI app proposed that wait for your yes: approve or discard each list, and choose where AI changes are approved.",
    current: PENDING_PATH,
    frame: ctx,
    body: html`<h1>Pending changes</h1>
<p class="lede">Lists of changes from your AI app. Nothing in a list is saved until you approve it.</p>
${rows.length === 0 ? empty("Nothing is waiting for you.") : html`<ul class="cards">${rows.map((row) => proposalCard(row, form, tz))}</ul>`}
<section class="section" aria-labelledby="approval-heading">
<h2 id="approval-heading">Where AI changes are approved</h2>
${postForm(
  "approval-form",
  APPROVAL_PATH,
  form,
  html`<fieldset class="field">
<legend>Where AI changes are approved</legend>
${radio("approve-chat", "chat", "In chat", "The AI app asks you, then applies.", !board)}
${radio("approve-board", "board", "On the board only", "You approve here.", board)}
</fieldset>
<button class="button" type="submit">Save</button>`,
)}
</section>`,
  });
}
