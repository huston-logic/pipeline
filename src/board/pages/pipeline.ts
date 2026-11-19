// /pipeline: open deals as a kanban, one column per open stage, or with ?view=list as rows grouped by stage. Every
// deal has a Move to form; Won, Lost and Not now are move targets but not columns (decision 0017). /board.js adds drag
// and drop on the board view, on top of the forms.
import type { StageRow } from "../../db/db.ts";
import { listStages } from "../../db/queries.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { type DealItem, pipelineSummary, type PipelineSummary, stageCounts, type StageSummary } from "../../services/read.ts";
import type { PageContext } from "../context.ts";
import type { FormContext } from "../forms.ts";
import { type Html, html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { moveForm, safeDealName } from "../move.ts";
import { count, dealLink, empty, formatNumber, labelled, pairs, tag, when } from "../parts.ts";

type View = "board" | "list";

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

/** The pipeline page's own line: the open deals only, because the closed stages are listed under it. */
function openLine(summary: PipelineSummary): string {
  if (summary.total === 0) return summaryLine(summary);
  const value = summary.open.value > 0 ? `, total value ${formatNumber(summary.open.value)}` : "";
  return `${count(summary.open.count, "open deal")}${value}.`;
}

/** Board / List: two views of the Pipeline tab, like People / Companies. */
function viewSwitch(current: View): Html {
  const item = (view: View, href: string, label: string) =>
    html`<li><a href="${href}"${view === current ? html` aria-current="page"` : ""}>${label}</a></li>`;
  return html`<ul class="view-switch" aria-label="Show the pipeline as">
${item("board", "/pipeline", "Board")}
${item("list", "/pipeline?view=list", "List")}
</ul>`;
}

function facts(deal: DealItem): Html | "" {
  return pairs([
    { name: "Contact", value: labelled(deal.contactName, has(deal.untrusted_fields, "contactName")) },
    deal.value !== null && { name: "Value", value: formatNumber(deal.value) },
    deal.nextAt !== null && deal.nextAtLocal !== null && { name: "Next date", value: when(deal.nextAt, deal.nextAtLocal) },
  ]);
}

function move(deal: DealItem, stages: StageRow[], form: FormContext): Html {
  const name = safeDealName(deal.id, deal.title, has(deal.untrusted_fields, "title"));
  return moveForm({ id: deal.id, name, stageKey: deal.stageKey }, stages, form, { collapsed: true });
}

function dealCard(deal: DealItem, stages: StageRow[], form: FormContext): Html {
  return html`<li class="card deal-card" data-deal="${deal.id}" data-stage="${deal.stageKey}">
<div class="card-head">
<h3 class="card-title">${dealLink(deal.id, deal.title, has(deal.untrusted_fields, "title"))}</h3>
${deal.overdue ? tag("Overdue", true) : ""}
</div>
${facts(deal)}
${move(deal, stages, form)}
</li>`;
}

const stageId = (index: number) => `stage-${index + 1}`;

const noDeals = html`<p class="stage-empty">No open deals in this stage.</p>`;

function column(stage: StageSummary, index: number, stages: StageRow[], form: FormContext): Html {
  const id = stageId(index);
  return html`<section class="column" aria-labelledby="${id}" data-drop-stage="${stage.key}">
<div class="column-head">
<h2 id="${id}">${stage.label}</h2>
<p class="stage-count">${stageCountText(stage)}</p>
</div>
${stage.deals.length === 0 ? noDeals : html`<ul class="column-cards">${stage.deals.map((deal) => dealCard(deal, stages, form))}</ul>`}
</section>`;
}

/** On phones the columns stack, so a list of links jumps to each one. */
function jumpList(summary: PipelineSummary): Html {
  return html`<ul class="stage-jump" aria-label="Jump to a stage">${summary.stages.map(
    (stage, i) => html`<li><a href="#${stageId(i)}">${stage.label} <span class="stage-jump-count">${stage.count}</span></a></li>`,
  )}</ul>`;
}

/** Won, Lost and Not now: counts, and drop areas for /board.js. Moving there is done from a deal's Move to list. */
function closedStages(stages: StageRow[], counts: Map<string, number>): Html | "" {
  const closed = stages.filter((stage) => stage.kind !== "open");
  if (closed.length === 0) return "";
  return html`<section class="closed" aria-labelledby="closed-heading">
<h2 id="closed-heading">Closed</h2>
<ul class="closed-list">${closed.map(
    (stage) =>
      html`<li class="closed-stage" data-drop-stage="${stage.key}"><span class="closed-label">${stage.label}</span> <span class="closed-count">${count(counts.get(stage.key) ?? 0, "deal")}</span></li>`,
  )}</ul>
</section>`;
}

function boardView(summary: PipelineSummary, stages: StageRow[], counts: Map<string, number>, form: FormContext): Html {
  // The closed stages come after the board in reading order; from 40rem the CSS shows them above it, where a dragged
  // card can reach them without scrolling.
  return html`<div class="pipeline-board">
${jumpList(summary)}
<div class="board" role="region" aria-label="Open stages" tabindex="0" data-board>
${summary.stages.map((stage, i) => column(stage, i, stages, form))}
</div>
${closedStages(stages, counts)}
</div>`;
}

function dealRow(deal: DealItem, stages: StageRow[], form: FormContext): Html {
  return html`<li class="deal-row">
<div class="deal-row-main">
<div class="card-head">
<h3 class="card-title">${dealLink(deal.id, deal.title, has(deal.untrusted_fields, "title"))}</h3>
${deal.overdue ? tag("Overdue", true) : ""}
</div>
${facts(deal)}
</div>
${move(deal, stages, form)}
</li>`;
}

function listView(summary: PipelineSummary, stages: StageRow[], counts: Map<string, number>, form: FormContext): Html {
  return html`${summary.stages.map(
  (stage, i) => html`<section class="stage" aria-labelledby="${stageId(i)}">
<div class="stage-head">
<h2 id="${stageId(i)}">${stage.label}</h2>
<p class="stage-count">${stageCountText(stage)}</p>
</div>
${stage.deals.length === 0 ? noDeals : html`<ul class="panel rows deal-rows">${stage.deals.map((deal) => dealRow(deal, stages, form))}</ul>`}
</section>`,
)}
${closedStages(stages, counts)}`;
}

export async function pipelinePage(ctx: PageContext): Promise<string> {
  const { db, now } = ctx;
  const view: View = ctx.query.get("view") === "list" ? "list" : "board";
  const tz = await ownerTimezone(db);
  const [summary, stages, counts] = await Promise.all([pipelineSummary(db, now, tz), listStages(db), stageCounts(db)]);
  const body =
    summary.stages.length === 0
      ? empty("There are no open stages.", "Ask your AI app to add one.")
      : view === "list"
        ? listView(summary, stages, counts, ctx)
        : boardView(summary, stages, counts, ctx);
  return renderPage({
    title: view === "list" ? "Pipeline list" : "Pipeline",
    description:
      view === "list"
        ? "Every open deal as a list grouped by stage, with a Move to control on each."
        : "Your open deals as a board, one column per stage, with each deal's contact, value and next date.",
    current: "/pipeline",
    frame: ctx,
    script: view === "board",
    body: html`<h1>Pipeline</h1>
${viewSwitch(view)}
<p class="lede">${openLine(summary)}</p>
${body}`,
  });
}
