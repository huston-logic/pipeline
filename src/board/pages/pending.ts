// /pending (run 10, area 5): the lists of record changes the AI app proposed and the owner has not yet approved, each
// with Approve and Discard, and the setting that says where AI changes are approved. A list's text is what the owner
// was shown when it was made: it holds only safe labels by construction and goes out through the html tag like any text.
import type { ProposalRow } from "../../db/db.ts";
import { getSettings } from "../../db/queries.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { listOpenProposals } from "../../services/proposals.ts";
import { type ShownLine, shownLines } from "../../services/proposal-text.ts";
import { formatLocal } from "../../time.ts";
import type { PageContext } from "../context.ts";
import { type FormContext, postForm } from "../forms.ts";
import { type Html, html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { count, empty, when } from "../parts.ts";

export const PENDING_PATH = "/pending";
export const pendingAction = (id: string, verb: "approve" | "discard") => `${PENDING_PATH}/${encodeURIComponent(id)}/${verb}`;
export const APPROVAL_PATH = "/pending/approval";

const timeOnly = (iso: string, tz: string) => formatLocal(iso, tz).split(", ").at(-1) ?? iso;

/** How many actions the list holds, from the stored JSON array; 0 when it can't be read. */
function actionCount(row: ProposalRow): number {
  try {
    const actions: unknown = JSON.parse(row.actions);
    return Array.isArray(actions) ? actions.length : 0;
  } catch {
    return 0;
  }
}

/** "3:40 PM, 4 changes" for each list, with " (2)" and so on added when two lists would read the same. */
function listNames(rows: ProposalRow[], tz: string): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const base = `${timeOnly(row.created_at, tz)}, ${count(actionCount(row), "change")}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

/** The lines from `at` on that sit at `depth`, each item with the deeper lines under it as a nested list. */
function nested(lines: ShownLine[], at: number, depth: number): { list: Html; next: number } {
  const items: Html[] = [];
  let i = at;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined || line.heading || line.depth < depth) break;
    const inner = lines[i + 1] !== undefined && !lines[i + 1]?.heading && (lines[i + 1]?.depth ?? 0) > depth;
    const below = inner ? nested(lines, i + 1, depth + 1) : null;
    items.push(html`<li>${line.text}${below?.list ?? ""}</li>`);
    i = below?.next ?? i + 1;
  }
  return { list: html`<ul class="${depth === 0 ? "rows" : "sub-rows"}">${items}</ul>`, next: i };
}

/** A stored list as headed groups of items; the AI-directed first line and closing paragraph are left out. */
function listBody(text: string): Html[] {
  const lines = shownLines(text);
  const out: Html[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line?.heading) {
      out.push(html`<h3 class="list-heading">${line.text}</h3>`);
      i += 1;
    }
    const group = nested(lines, i, 0);
    if (group.next === i) i += 1;
    else {
      out.push(group.list);
      i = group.next;
    }
  }
  return out;
}

function proposalCard(row: ProposalRow, name: string, form: FormContext, tz: string): Html {
  return html`<li class="card">
<h2>List from ${name}</h2>
<p class="panel-note">Made ${when(row.created_at, formatLocal(row.created_at, tz))}. Expires ${when(row.expires_at, formatLocal(row.expires_at, tz))}.</p>
${listBody(row.text)}
<div class="confirm-actions">
${postForm("row-form", pendingAction(row.id, "approve"), form, html`<button class="button" type="submit">Approve<span class="visually-hidden"> the list from ${name}</span></button>`)}
${postForm("row-form", pendingAction(row.id, "discard"), form, html`<button class="button button-quiet" type="submit" aria-describedby="discard-${row.id}">Discard<span class="visually-hidden"> the list from ${name}</span></button>`)}
<p class="field-hint" id="discard-${row.id}">Discard throws this list away. It can't be undone, but your AI app can suggest it again.</p>
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
  const names = listNames(rows, tz);
  return renderPage({
    title: "Pending changes",
    description: "Changes your AI app proposed that wait for your yes: approve or discard each list, and choose where AI changes are approved.",
    current: PENDING_PATH,
    frame: ctx,
    body: html`<h1>Pending changes</h1>
<p class="lede">Lists of changes from your AI app. Nothing in a list is saved until you approve it.</p>
${rows.length === 0 ? empty("Nothing is waiting for you.") : html`<ul class="cards">${rows.map((row, i) => proposalCard(row, names[i] ?? "", form, tz))}</ul>`}
<section class="section">
${postForm(
  "approval-form",
  APPROVAL_PATH,
  form,
  html`<fieldset class="field">
<legend>Where AI changes are approved</legend>
${radio("approve-chat", "chat", "In chat", "The AI app asks you, then applies.", !board)}
${radio("approve-board", "board", "On the board only", "You approve here. Nothing your AI app proposes is saved until you do, small changes and changes to your rules included.", board)}
</fieldset>
<button class="button" type="submit">Save</button>`,
)}
</section>`,
  });
}
