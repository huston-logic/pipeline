// /pipeline: open deals as a kanban, one column per open stage, or with ?view=list as a table of every open deal (cards
// with layout=cards), at most 200 (decision 0043). Every board card has a Move to form; Won, Lost and Not now are move
// targets but not columns (decision 0017). /board.js adds drag and drop on the board view, on top of the forms.
// ?view=<vw id> is a saved deals view (deals-view.ts, decision 0042).
import type { StageRow } from "../../db/db.ts";
import { listStages } from "../../db/queries.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { type DealItem, pipelineSummary, type PipelineSummary, stageCounts, type StageSummary } from "../../services/read.ts";
import { dealsInView, VIEW_ROW_LIMIT } from "../../services/view-read.ts";
import { DEFAULT_COLUMNS, DEFAULT_SORT } from "../../services/view-spec.ts";
import { filterLabels, sortLine } from "../../services/views.ts";
import type { PageContext } from "../context.ts";
import type { FormContext } from "../forms.ts";
import { type Html, html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { moveForm, safeDealName } from "../move.ts";
import { viewSwitch } from "../people-switch.ts";
import { dealsViewPage } from "./deals-view.ts";
import { count, dealLink, empty, formatNumber, labelled, addButtons, pairs, tag, when } from "../parts.ts";
import { layoutDescription, layoutSwitch, layoutTitle, pickLayout } from "../table.ts";
import { countLine } from "../view-parts.ts";
import { dealsList, sortFromQuery, tableSummary } from "../view-table.ts";

/**
 * A board column shows the deals longest in its stage, at most this many, and links to the stage's own list, which
 * shows at most VIEW_ROW_LIMIT (decision 0020): on a big copy, drawing every open deal took the page to the free
 * plan's 10 ms CPU limit.
 */
export const STAGE_CARD_LIMIT = 50;

const stageListHref = (key: string) => `/pipeline?view=list&stage=${encodeURIComponent(key)}`;

/** "Showing 50 of 60, longest in this stage first." and a link to all of them. */
function moreNote(stage: StageSummary, limit: number): Html | "" {
  if (stage.deals.length <= limit) return "";
  const total = formatNumber(stage.deals.length);
  return html`<p class="stage-more">Showing ${formatNumber(limit)} of ${total}, longest in this stage first. <a href="${stageListHref(stage.key)}">Show all ${total} in ${stage.label}</a></p>`;
}

const has = (fields: readonly string[], key: string) => fields.includes(key);

/** "2 deals", "1 deal, value 1,500". */
export function stageCountText(stage: Pick<StageSummary, "count" | "value">): string {
  return `${count(stage.count, "deal")}${stage.value > 0 ? `, value ${formatNumber(stage.value)}` : ""}`;
}

export function summaryLine(summary: PipelineSummary): string {
  if (summary.total === 0) {
    return "No deals yet. Add one with Add a deal, or by talking to your AI app. Inquiries from your website form show up here too.";
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
${stage.deals.length === 0 ? noDeals : html`<ul class="column-cards">${stage.deals.slice(0, STAGE_CARD_LIMIT).map((deal) => dealCard(deal, stages, form))}</ul>`}
${moreNote(stage, STAGE_CARD_LIMIT)}
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

/** /pipeline?view=list: every open deal, or one open stage's, as a table (or cards), at most 200. */
async function listPage(ctx: PageContext): Promise<string> {
  const { db, now, query } = ctx;
  const tz = await ownerTimezone(db);
  const [stages, counts, labels] = await Promise.all([listStages(db), stageCounts(db), filterLabels(db)]);
  const open = stages.filter((stage) => stage.kind === "open");
  // An unknown or closed stage is ignored.
  const only = open.find((stage) => stage.key === query.get("stage"));
  const layout = pickLayout(query, "table");
  const sort = sortFromQuery("deals", query, DEFAULT_SORT.deals);
  const list = await dealsInView(db, now, tz, only === undefined ? {} : { stage: only.key }, sort, VIEW_ROW_LIMIT);
  const name = only === undefined ? "Open deals" : `${only.label} deals`;
  const shows = `${only === undefined ? "Every open deal" : `Open deals in ${only.label}`}; ${sortLine(sort)}.`;
  let body: Html;
  if (open.length === 0) {
    body = empty("There are no open stages.", "Ask your AI app to add one.");
  } else if (list.total === 0) {
    body = html`<p class="lede">${shows}</p>
${empty(only === undefined ? "No open deals yet." : "No open deals in this stage.", "Add one with Add a deal, or by talking to your AI app. Inquiries from your website form show up here too.")}`;
  } else {
    body = html`<p class="lede">${shows} ${countLine(list.items.length, list.total, "deal", "deals")}</p>
${dealsList(list.items, {
  layout,
  path: "/pipeline",
  query,
  sort,
  columns: [...DEFAULT_COLUMNS.deals],
  fields: labels.fields,
  tz,
  name,
  summary: tableSummary(list.items.length, list.total, "deal", "deals", sort),
})}`;
  }
  return renderPage({
    region: true,
    title: layoutTitle(only === undefined ? "Deals list" : `${only.label} deals`, layout, "table"),
    description: layoutDescription(
      only === undefined
        ? "Every open deal, one line each, with its person, stage, value and next step."
        : `Every open deal in ${only.label}, one line each, with its person, value and next step.`,
      layout,
      "table",
    ),
    current: "/pipeline",
    frame: ctx,
    body: html`<h1>Deals</h1>
${await viewSwitch(db, "deals", { kind: "built_in", id: "list" })}
${layoutSwitch("/pipeline", query, layout)}
${addButtons("pipeline", ["deal", "lead", "import"])}
${only === undefined ? "" : html`<p class="search-clear"><a href="/pipeline?view=list">Show every stage</a></p>`}
${body}
${only === undefined ? closedStages(stages, counts) : ""}`,
  });
}

export async function pipelinePage(ctx: PageContext): Promise<string | null> {
  const { db, now } = ctx;
  const asked = ctx.query.get("view") ?? "";
  // A saved deals view (decision 0042): an id that isn't a live deals view is the board's 404.
  if (asked.startsWith("vw_")) return dealsViewPage(ctx, asked);
  if (asked === "list") return listPage(ctx);
  const tz = await ownerTimezone(db);
  const [summary, stages, counts] = await Promise.all([pipelineSummary(db, now, tz), listStages(db), stageCounts(db)]);
  const body =
    summary.stages.length === 0
      ? empty("There are no open stages.", "Ask your AI app to add one.")
      : boardView(summary, stages, counts, ctx);
  return renderPage({
    region: true,
    title: "Deals",
    description: "Your open deals as a board, one column per stage, with each deal's contact, value and next date.",
    current: "/pipeline",
    frame: ctx,
    script: true,
    body: html`<h1>Deals</h1>
${await viewSwitch(db, "deals", { kind: "built_in", id: "board" })}
<p class="lede">${openLine(summary)}</p>
${addButtons("pipeline", ["deal", "lead", "import"])}
${body}`,
  });
}
