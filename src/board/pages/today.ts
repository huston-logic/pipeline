// Today (/): what is overdue and due today, then the pipeline at a glance and the latest brief (style guide §5).
import { type BriefItem, headerDate } from "../../brief/compose.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import {
  type BriefView,
  type DealItem,
  latestBrief,
  pipelineSummary,
  type PipelineSummary,
  type TaskItem,
  whatsDue,
  type WhatsDue,
} from "../../services/read.ts";
import { localDate } from "../../time.ts";
import { type Html, html } from "../html.ts";
import type { PageContext } from "../context.ts";
import { renderPage } from "../layout.ts";
import type { FormContext } from "../forms.ts";
import { count, dealLink, empty, labelled, addButtons, pairs, section, tag, when } from "../parts.ts";
import { taskActions } from "../task-forms.ts";
import { briefDate, briefLine, sendStatusText } from "./brief.ts";
import { stageCountText, summaryLine } from "./pipeline.ts";

const EXCERPT_ITEMS = 4;

const has = (fields: readonly string[], key: string) => fields.includes(key);

function taskCard(task: TaskItem, overdue: boolean, form: FormContext): Html {
  const outside = task.untrusted_fields;
  return html`<li class="card">
<div class="card-head">
<h3 class="card-title">${labelled(task.title, has(outside, "title"))}</h3>
${overdue ? tag("Overdue", true) : ""}
</div>
${pairs([
  task.dueAt !== null && task.dueAtLocal !== null && { name: "Due", value: when(task.dueAt, task.dueAtLocal) },
  task.dealId !== null &&
    task.dealTitle !== null && { name: "Deal", value: dealLink(task.dealId, task.dealTitle, has(outside, "dealTitle")) },
  task.dealId === null &&
    task.contactName !== null && { name: "Contact", value: labelled(task.contactName, has(outside, "contactName")) },
])}
${taskActions(task, form)}
</li>`;
}

function nextStepCard(deal: DealItem, overdue: boolean): Html {
  return html`<li class="card">
<div class="card-head">
<h3 class="card-title">${dealLink(deal.id, deal.title, has(deal.untrusted_fields, "title"))}</h3>
${overdue ? tag("Overdue", true) : ""}
</div>
${pairs([
  { name: "Next step", value: deal.nextStep ?? "Not written down" },
  deal.nextAt !== null && deal.nextAtLocal !== null && { name: "Due", value: when(deal.nextAt, deal.nextAtLocal) },
  { name: "Contact", value: labelled(deal.contactName, has(deal.untrusted_fields, "contactName")) },
])}
</li>`;
}

function cards(tasks: TaskItem[], deals: DealItem[], overdue: boolean, form: FormContext): Html {
  return html`<ul class="cards">${tasks.map((t) => taskCard(t, overdue, form))}${deals.map((d) => nextStepCard(d, overdue))}</ul>`;
}

function dueSections(due: WhatsDue, form: FormContext): Html {
  const overdue = due.overdueTasks.length + due.overdueDeals.length;
  const today = due.todayTasks.length + due.todayDeals.length;
  if (overdue + today === 0) {
    return section(
      "due-heading",
      "Due today",
      empty("Nothing due today.", "Add a task on a deal or contact page, or add a deal or a lead."),
    );
  }
  return html`${overdue > 0 ? section("overdue-heading", "Overdue", cards(due.overdueTasks, due.overdueDeals, true, form)) : ""}
${section(
  "due-heading",
  "Due today",
  today > 0 ? cards(due.todayTasks, due.todayDeals, false, form) : html`<p class="section-note">Nothing else is due today.</p>`,
)}`;
}

function pipelineGlance(summary: PipelineSummary): Html {
  const body =
    summary.stages.length === 0
      ? empty("There are no open stages.", "Ask your AI app to add one.")
      : html`<ul class="panel stage-rows">${summary.stages.map(
          (stage, i) =>
            html`<li><a class="stage-row" href="/pipeline#stage-${i + 1}"><span class="stage-row-label">${stage.label}</span> <span class="stage-row-count">${stageCountText(stage)}</span></a></li>`,
        )}</ul>`;
  return section("pipeline-heading", "Pipeline", body);
}

function excerptItem(item: BriefItem): Html {
  return html`<li>${labelled(briefLine(item), item.untrusted)}</li>`;
}

function briefExcerpt(brief: BriefView | null): Html {
  if (brief === null) {
    return section(
      "brief-heading",
      "Latest brief",
      empty("No brief yet.", "The first one is composed at your brief hour and shows up here."),
      "glance",
    );
  }
  const shown = brief.items.slice(0, EXCERPT_ITEMS);
  const more = brief.items.length - shown.length;
  return section(
    "brief-heading",
    "Latest brief",
    html`<div class="panel">
<p class="panel-note">For ${briefDate(brief.localDate)}. ${sendStatusText(brief)}</p>
${shown.length === 0 ? html`<p>Nothing was due that day.</p>` : html`<ul class="rows">${shown.map(excerptItem)}</ul>`}
<p class="panel-foot"><a href="/brief">${more > 0 ? `Read the whole brief (${count(more, "more line")})` : "Read the whole brief"}</a></p>
</div>`,
  );
}

export async function todayPage(ctx: PageContext): Promise<string> {
  const { db, now } = ctx;
  const tz = await ownerTimezone(db);
  const [summary, due, brief] = await Promise.all([pipelineSummary(db, now, tz), whatsDue(db, now, tz), latestBrief(db)]);
  const date = localDate(now, tz);
  return renderPage({
    title: "Today",
    description: "What is overdue and due today, your open deals by stage and the latest daily brief.",
    current: "/",
    frame: ctx,
    body: html`<div class="page-head">
<h1>Today</h1>
<p class="page-date"><time datetime="${date}">${headerDate(date)}</time></p>
</div>
<p class="lede">${summaryLine(summary)}</p>
${addButtons("today", ["deal", "lead", "import"])}
<div class="today-columns">
<div class="today-due">
${dueSections(due, ctx)}
</div>
<div class="today-glance">
${pipelineGlance(summary)}
${briefExcerpt(brief)}
</div>
</div>`,
  });
}
