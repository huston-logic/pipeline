import type { BriefItem } from "../../brief/compose.ts";
import type { Db } from "../../db/db.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import {
  type BriefView,
  type DealItem,
  latestBrief,
  pipelineSummary,
  type PipelineSummary,
  type StageSummary,
  type TaskItem,
  whatsDue,
  type WhatsDue,
} from "../../services/read.ts";
import { type Html, html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { count, dealLink, empty, fact, formatNumber, labelled, meta, when } from "../parts.ts";
import { briefDate, briefLine, sendStatusText } from "./brief.ts";

const EXCERPT_ITEMS = 4;

const has = (fields: readonly string[], key: string) => fields.includes(key);

function taskItem(task: TaskItem): Html {
  const outside = task.untrusted_fields;
  const subject =
    task.dealId !== null && task.dealTitle !== null
      ? fact("Deal", dealLink(task.dealId, task.dealTitle, has(outside, "dealTitle")))
      : task.contactName !== null
        ? fact("Contact", labelled(task.contactName, has(outside, "contactName")))
        : null;
  return html`<li>
<p class="item-title">${labelled(task.title, has(outside, "title"))}</p>
${meta([task.dueAt !== null && task.dueAtLocal !== null && fact("Due", when(task.dueAt, task.dueAtLocal)), subject])}
</li>`;
}

function nextStepItem(deal: DealItem): Html {
  return html`<li>
<p class="item-title">${dealLink(deal.id, deal.title, has(deal.untrusted_fields, "title"))}</p>
${meta([
  fact("Next step", deal.nextStep ?? "not written down"),
  deal.nextAt !== null && deal.nextAtLocal !== null && fact("Due", when(deal.nextAt, deal.nextAtLocal)),
])}
</li>`;
}

function dueGroup(heading: string, tasks: TaskItem[], deals: DealItem[]): Html | "" {
  if (tasks.length + deals.length === 0) return "";
  return html`<h3>${heading}</h3>
<ul class="items">${tasks.map(taskItem)}${deals.map(nextStepItem)}</ul>`;
}

function dueSection(due: WhatsDue): Html {
  const total = due.overdueTasks.length + due.todayTasks.length + due.overdueDeals.length + due.todayDeals.length;
  return html`<section class="due" aria-labelledby="due-heading">
<h2 id="due-heading">Due today</h2>
${
  total === 0
    ? empty("Nothing is due today or overdue.")
    : html`${dueGroup("Overdue", due.overdueTasks, due.overdueDeals)}${dueGroup("Today", due.todayTasks, due.todayDeals)}`
}
</section>`;
}

function stageDeal(deal: DealItem): Html {
  return html`<li>
<p class="item-title">${dealLink(deal.id, deal.title, has(deal.untrusted_fields, "title"))}</p>
${meta([
  fact("Contact", labelled(deal.contactName, has(deal.untrusted_fields, "contactName"))),
  deal.value !== null && fact("Value", formatNumber(deal.value)),
  deal.nextStep !== null && fact("Next step", deal.nextStep),
  deal.nextAt !== null &&
    deal.nextAtLocal !== null &&
    fact("Next date", html`${when(deal.nextAt, deal.nextAtLocal)}${deal.overdue ? html` <span class="flag">Overdue</span>` : ""}`),
])}
</li>`;
}

function stageSection(stage: StageSummary, index: number): Html {
  const id = `stage-${index + 1}`;
  const value = stage.value > 0 ? `, value ${formatNumber(stage.value)}` : "";
  return html`<section class="stage" aria-labelledby="${id}">
<div class="stage-head">
<h3 id="${id}">${stage.label}</h3>
<p class="stage-count">${count(stage.count, "deal")}${value}</p>
</div>
${stage.deals.length === 0 ? empty("No open deals in this stage.") : html`<ul class="items">${stage.deals.map(stageDeal)}</ul>`}
</section>`;
}

function summaryLine(summary: PipelineSummary): string {
  if (summary.total === 0) {
    return "No deals yet. Leads from your website form, and the ones you add by talking to your AI app, show up here.";
  }
  const { open, closed } = summary;
  const value = open.value > 0 ? `, total value ${formatNumber(open.value)}` : "";
  return `${count(open.count, "open deal")}${value}. Closed: ${closed.won} won, ${closed.lost} lost, ${closed.not_now} not now.`;
}

function stagesSection(summary: PipelineSummary): Html {
  return html`<section aria-labelledby="stages-heading">
<h2 id="stages-heading">Deals by stage</h2>
${summary.stages.length === 0 ? empty("There are no open stages. Ask your AI app to add one.") : summary.stages.map(stageSection)}
</section>`;
}

function excerptItem(item: BriefItem): Html {
  return html`<li>${labelled(briefLine(item), item.untrusted)}</li>`;
}

function briefSection(brief: BriefView | null): Html {
  if (brief === null) {
    return html`<section class="brief-excerpt" aria-labelledby="brief-heading">
<h2 id="brief-heading">Latest brief</h2>
${empty("No brief yet. The first one is composed at your brief hour and shows up here.")}
</section>`;
  }
  const shown = brief.items.slice(0, EXCERPT_ITEMS);
  const more = brief.items.length - shown.length;
  return html`<section class="brief-excerpt" aria-labelledby="brief-heading">
<h2 id="brief-heading">Latest brief</h2>
<p>For ${briefDate(brief.localDate)}. ${sendStatusText(brief)}</p>
${shown.length === 0 ? empty("Nothing was due that day.") : html`<ul class="items compact">${shown.map(excerptItem)}</ul>`}
<p><a href="/brief">${more > 0 ? `Read the whole brief (${count(more, "more line")})` : "Read the whole brief"}</a></p>
</section>`;
}

export async function homePage(db: Db, now: Date): Promise<string> {
  const tz = await ownerTimezone(db);
  const [summary, due, brief] = await Promise.all([pipelineSummary(db, now, tz), whatsDue(db, now, tz), latestBrief(db)]);
  return renderPage({
    title: "Pipeline",
    description: "Your sales pipeline: deals by stage, follow-ups due today and the latest daily brief.",
    current: "/",
    body: html`<h1>Pipeline</h1>
<p class="lede">${summaryLine(summary)}</p>
${dueSection(due)}
<div class="home-columns">
${stagesSection(summary)}
${briefSection(brief)}
</div>`,
  });
}
