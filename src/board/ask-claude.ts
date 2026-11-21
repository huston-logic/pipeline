// "Ask Claude" on the deal page (decision 0021) and a lead's page (decision 0028): links that open claude.ai with a
// prompt filled in, and the same prompt to copy into any AI app that has the pipeline connected. The prompts are fixed
// sentences around the deal or contact id: no
// name, email, title or other record text goes into the URL or the prompt (privacy, and no outside text as
// instructions). The AI reads the deal itself through the MCP tools. No AI call happens in the product.
import { isContactId, isDealId } from "../ids.ts";
import { type Html, html } from "./html.ts";
import { section } from "./parts.ts";

export const ASK_CLAUDE_URL = "https://claude.ai/new?q=";

export type AskPrompt = { key: "prep" | "follow-up" | "intro"; label: string; prompt: string };

/** The two prompts for a deal, or none when `dealId` can't be a deal id. */
export function askPrompts(dealId: string): AskPrompt[] {
  if (!isDealId(dealId)) return [];
  return [
    {
      key: "prep",
      label: "Prep me for this call",
      prompt: `Use my pipeline tools: read get_deal for ${dealId} and my rulebook, then prep me for my call: who they are, where the deal stands, open tasks, and three questions to ask.`,
    },
    {
      key: "follow-up",
      label: "Draft a follow-up in my voice",
      prompt: `Use my pipeline tools: read my rulebook (voice) and get_deal for ${dealId}, then draft a short follow-up email in my voice. Don't send it; show me the draft.`,
    },
  ];
}

export const askHref = (prompt: string): string => `${ASK_CLAUDE_URL}${encodeURIComponent(prompt)}`;

function askRow({ key, label, prompt }: AskPrompt): Html {
  const id = `ask-${key}`;
  const named = html`<span class="visually-hidden">: ${label}</span>`;
  return html`<li>
<a class="button ask-open" href="${askHref(prompt)}" target="_blank" rel="noopener noreferrer">${label}<span class="visually-hidden"> (opens Claude in a new tab)</span></a>
<div class="ask-tools">
<button class="button button-quiet button-small ask-copy" type="button" data-copy="${id}" data-copy-status="${id}-status" hidden>Copy prompt${named}</button>
<p class="copy-status" id="${id}-status" aria-live="polite"></p>
</div>
<details class="ask-details">
<summary>Show the prompt${named}</summary>
<div class="field">
<label for="${id}">Prompt to copy${named}</label>
<textarea id="${id}" rows="4" readonly>${prompt}</textarea>
</div>
</details>
</li>`;
}

/** The lead page's one prompt (decision 0028), or none when `contactId` can't be a contact id. */
export function leadAskPrompts(contactId: string): AskPrompt[] {
  if (!isContactId(contactId)) return [];
  return [
    {
      key: "intro",
      label: "Draft an intro in my voice",
      prompt: `Draft an intro to contact ${contactId} in my voice. Read my rulebook first, then the contact.`,
    },
  ];
}

function askList(prompts: AskPrompt[], what: string): Html | "" {
  if (prompts.length === 0) return "";
  return section(
    "ask-heading",
    "Ask Claude",
    html`<p class="section-note">Opens Claude in a new tab with the question filled in. It names ${what} only; Claude reads the rest through your pipeline tools. Copy prompt works in any AI app with your pipeline connected.</p>
<ul class="panel rows ask">${prompts.map(askRow)}</ul>`,
  );
}

/** The deal page's Ask Claude section, or nothing when there are no prompts. */
export const askSection = (dealId: string): Html | "" => askList(askPrompts(dealId), "this deal by its id");

/** A lead's Ask Claude section: the intro prompt, naming the person by id only. */
export const leadAskSection = (contactId: string): Html | "" => askList(leadAskPrompts(contactId), "this person by their id");
