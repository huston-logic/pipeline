// /pipeline: open deals by stage, one section per open stage with a card per deal. Task R3 makes it a kanban.
import type { Db } from "../../db/db.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { type DealItem, pipelineSummary, type PipelineSummary, type StageSummary } from "../../services/read.ts";
import { type Html, html } from "../html.ts";
import { type Look, renderPage } from "../layout.ts";
import { count, dealLink, empty, formatNumber, labelled, pairs, tag, when } from "../parts.ts";

const has = (fields: readonly string[], key: string) => fields.includes(key);

/** "2 deals", "1 deal, value 1,500". */
export function stageCountText(stage: Pick<StageSummary, "count" | "value">): string {
  return `${count(stage.count, "deal")}${stage.value > 0 ? `, value ${formatNumber(stage.value)}` : ""}`;
}

export function summaryLine(summary: PipelineSummary): string {
  if (summary.total === 0) {
    return "No deals yet. Leads from your website form, and the ones you add by talking to your AI app, show up here.";
  }
  const { open, closed } = summary;
  const value = open.value > 0 ? `, total value ${formatNumber(open.value)}` : "";
  return `${count(open.count, "open deal")}${value}. Closed: ${closed.won} won, ${closed.lost} lost, ${closed.not_now} not now.`;
}

function dealCard(deal: DealItem): Html {
  return html`<li class="card">
<div class="card-head">
<h3 class="card-title">${dealLink(deal.id, deal.title, has(deal.untrusted_fields, "title"))}</h3>
${deal.overdue ? tag("Overdue", true) : ""}
</div>
${pairs([
  { name: "Contact", value: labelled(deal.contactName, has(deal.untrusted_fields, "contactName")) },
  deal.value !== null && { name: "Value", value: formatNumber(deal.value) },
  deal.nextStep !== null && { name: "Next step", value: deal.nextStep },
  deal.nextAt !== null && deal.nextAtLocal !== null && { name: "Next date", value: when(deal.nextAt, deal.nextAtLocal) },
])}
</li>`;
}

function stageSection(stage: StageSummary, index: number): Html {
  const id = `stage-${index + 1}`;
  return html`<section class="stage" aria-labelledby="${id}">
<div class="stage-head">
<h2 id="${id}">${stage.label}</h2>
<p class="stage-count">${stageCountText(stage)}</p>
</div>
${stage.deals.length === 0 ? html`<p class="stage-empty">No open deals in this stage.</p>` : html`<ul class="cards">${stage.deals.map(dealCard)}</ul>`}
</section>`;
}

export async function pipelinePage(db: Db, now: Date, look: Look): Promise<string> {
  const tz = await ownerTimezone(db);
  const summary = await pipelineSummary(db, now, tz);
  return renderPage({
    title: "Pipeline",
    description: "Your open deals by stage, with each deal's contact, value and next date.",
    current: "/pipeline",
    look,
    body: html`<h1>Pipeline</h1>
<p class="lede">${summaryLine(summary)}</p>
${summary.stages.length === 0 ? empty("There are no open stages.", "Ask your AI app to add one.") : summary.stages.map(stageSection)}`,
  });
}
