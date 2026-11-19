// The "Move to" form on a deal (decisions 0014, 0017): a plain form that works without JavaScript, by keyboard and
// with a screen reader. /board.js only sets its select and submits it when a card is dropped on a stage.
import type { StageRow } from "../db/db.ts";
import { dealHref } from "./parts.ts";
import { type FormContext, postForm } from "./forms.ts";
import { type Html, html } from "./html.ts";

/** A deal as the form needs it. `name` is safe to show: the title, or "deal dl_…" when the title came from outside. */
export type MoveDeal = { id: string; name: string; stageKey: string };

export type MoveOptions = {
  /** The stage the select shows: the deal's own, or the one the owner picked on a refused move. */
  selected?: string;
  /** On cards and list rows the form sits closed under a "Move to another stage" disclosure, so a card stays short. */
  collapsed?: boolean;
};

/** The title when the owner or the AI wrote it, otherwise the deal's id, so outside text never names a control. */
export const safeDealName = (id: string, title: string, outside: boolean): string => (outside ? `deal ${id}` : title);

export const moveAction = (dealId: string): string => `${dealHref(dealId)}/move`;

function option(stage: StageRow, deal: MoveDeal, selected: string): Html {
  const current = stage.key === deal.stageKey ? " (current)" : "";
  return html`<option value="${stage.key}"${stage.key === selected ? " selected" : ""}>${stage.label}${current}</option>`;
}

/** Open stages first, then the closed ones (Won, Lost, Not now) in their own group: moving there asks first. */
export function moveForm(deal: MoveDeal, stages: StageRow[], form: FormContext, options: MoveOptions = {}): Html {
  const { selected = deal.stageKey, collapsed = false } = options;
  const id = `move-${deal.id}`;
  const open = stages.filter((stage) => stage.kind === "open");
  const closed = stages.filter((stage) => stage.kind !== "open");
  // A deal in an archived stage (or a refused choice that is no stage) must never show another stage as chosen.
  const choose = stages.some((stage) => stage.key === selected) ? "" : html`<option value="" selected>Choose a stage</option>\n`;
  const body = postForm(
    "move",
    moveAction(deal.id),
    form,
    html`<label class="move-label${collapsed ? " visually-hidden" : ""}" for="${id}">Move to<span class="visually-hidden"> (${deal.name})</span></label>
<div class="move-row">
<select id="${id}" name="stage">
${choose}${open.map((stage) => option(stage, deal, selected))}
${closed.length === 0 ? "" : html`<optgroup label="Close the deal">${closed.map((stage) => option(stage, deal, selected))}</optgroup>`}
</select>
<button class="button button-small" type="submit">Move<span class="visually-hidden"> ${deal.name}</span></button>
</div>`,
  );
  if (!collapsed) return body;
  return html`<details class="move-details">
<summary>Move to another stage<span class="visually-hidden">: ${deal.name}</span></summary>
${body}
</details>`;
}
