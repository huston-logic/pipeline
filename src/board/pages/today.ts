// Today (/): the open to-dos as a list (decision 0047), the deals due, then the pipeline at a glance and the latest brief (style guide §5).
import { type BriefItem, headerDate } from "../../brief/compose.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { countOpenProposals } from "../../services/proposals.ts";
import {
  type BriefView,
  type DealItem,
  latestBrief,
  type OpenTask,
  type OpenTaskLists,
  openTaskLists,
  pipelineSummary,
  type PipelineSummary,
  whatsDue,
  type WhatsDue,
} from "../../services/read.ts";
import { dayBoundsUtc, localDate } from "../../time.ts";
import { type Html, html } from "../html.ts";
import type { PageContext } from "../context.ts";
import { renderPage } from "../layout.ts";
import type { FormContext } from "../forms.ts";
import { count, dealLink, formatNumber, empty, labelled, addButtons, pairs, projectLink, section, tag, when } from "../parts.ts";
import { isStandalone, TASK_SHOWS, TASK_SORTS, type TaskShow, type TaskSort, type TaskView, taskView } from "../task-list.ts";
import { descriptionLine, quickAddForm, taskActions } from "../task-forms.ts";
import { briefDate, briefLine, sendStatusText } from "./brief.ts";
import { stageCountText, summaryLine } from "./pipeline.ts";

const EXCERPT_ITEMS = 4;

/** Each of the two task lists shows this many rows, sorted first in SQL, so the soonest and overdue are never cut (0047). */
export const TASK_LIST_LIMIT = 50;

const has = (fields: readonly string[], key: string) => fields.includes(key);

async function taskCard(task: OpenTask, overdue: boolean, form: FormContext, tz: string): Promise<Html> {
  const outside = task.untrusted_fields;
  return html`<li class="card">
<div class="card-head">
<h3 class="card-title">${labelled(task.title, has(outside, "title"))}</h3>
${overdue ? tag("Overdue", true) : ""}
</div>
${pairs([
  task.dueAt !== null && task.dueAtLocal !== null && { name: "Due", value: when(task.dueAt, task.dueAtLocal) },
  task.projectId !== null &&
    task.projectName !== null && { name: "Project", value: projectLink(task.projectId, task.projectName, has(outside, "projectName")) },
  task.parentId !== null && { name: "Under", value: task.parentTitle ?? "a task" },
  task.dealId !== null &&
    task.dealTitle !== null && { name: "Deal", value: dealLink(task.dealId, task.dealTitle, has(outside, "dealTitle")) },
  task.dealId === null &&
    task.contactName !== null && { name: "Contact", value: labelled(task.contactName, has(outside, "contactName")) },
  isStandalone(task) && { name: "For", value: "No person or deal" },
])}
${descriptionLine(task)}
${await taskActions(task, form, tz)}
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

const SORT_LABELS: Record<TaskSort, string> = { due: "Due date", newest: "Newest first", subject: "Person" };
const SHOW_LABELS: Record<TaskShow, string> = { all: "All", linked: "With a person or deal", standalone: "No person or deal" };

function choice<T extends string>(id: string, name: string, label: string, values: readonly T[], labels: Record<T, string>, chosen: T): Html {
  return html`<div class="field">
<label for="${id}">${label}</label>
<select id="${id}" name="${name}">
${values.map((value) => html`<option value="${value}"${value === chosen ? " selected" : ""}>${labels[value]}</option>\n`)}</select>
</div>`;
}

const SORT_NOTE: Record<TaskSort, string> = { due: "", newest: "newest first", subject: "by person" };
const SHOW_NOTE: Record<TaskShow, string> = { all: "", linked: "with a person or deal", standalone: "with no person or deal" };

/** The sort and filter in words, for a title and description that differ from the usual Today's (empty when usual). */
const viewNote = (view: TaskView): string => [SORT_NOTE[view.sort], SHOW_NOTE[view.show]].filter((part) => part !== "").join(", ");

/** Sort and filter as a plain GET form (decision 0047): the address carries only these two keys. */
function taskTools(view: TaskView): Html {
  return html`<form class="search search-filters todo-filter" action="/" method="get" aria-label="Sort and filter to-dos">
${choice("todo-sort", "sort", "Sort by", TASK_SORTS, SORT_LABELS, view.sort)}
${choice("todo-show", "show", "Show", TASK_SHOWS, SHOW_LABELS, view.show)}
<button class="button" type="submit">Show to-dos</button>
</form>`;
}

async function taskSections(lists: OpenTaskLists, startOfToday: string, form: FormContext, tz: string): Promise<Html> {
  const { todo, undated, totals } = lists;
  if (todo.length + undated.length === 0) return empty("Nothing to do.", "Add a to-do above, or add a task on a deal or contact page.");
  const list = async (items: OpenTask[], total: number) => {
    const cards = await Promise.all(items.map((t) => taskCard(t, t.dueAt !== null && t.dueAt < startOfToday, form, tz)));
    return html`<ul class="cards">${cards}</ul>
${total > items.length ? html`<p class="stage-more">Showing ${formatNumber(items.length)} of ${formatNumber(total)} to-dos.</p>` : ""}`;
  };
  return html`${todo.length > 0 ? section("todo-heading", "To do", await list(todo, totals.todo)) : ""}
${undated.length > 0 ? section("undated-heading", "Needs a due date", await list(undated, totals.undated)) : ""}`;
}

function dealCards(deals: DealItem[], overdue: boolean): Html {
  return html`<ul class="cards">${deals.map((d) => nextStepCard(d, overdue))}</ul>`;
}

/** The deals whose next step is overdue or due today; nothing at all when there are none. */
function dueDeals(due: WhatsDue): Html | "" {
  if (due.overdueDeals.length + due.todayDeals.length === 0) return "";
  return html`${due.overdueDeals.length > 0 ? section("overdue-heading", "Overdue", dealCards(due.overdueDeals, true)) : ""}
${due.todayDeals.length > 0 ? section("due-heading", "Due today", dealCards(due.todayDeals, false)) : ""}`;
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
  const view = taskView(ctx.query);
  const [summary, due, brief, tasks, waiting] = await Promise.all([
    pipelineSummary(db, now, tz),
    whatsDue(db, now, tz),
    latestBrief(db),
    openTaskLists(db, now, tz, view, TASK_LIST_LIMIT),
    countOpenProposals(db, now),
  ]);
  const date = localDate(now, tz);
  const note = viewNote(view);
  const description = "Your open to-dos, the deals due, your open deals by stage and the latest daily brief";
  return renderPage({
    title: note === "" ? "Today" : `Today, ${note}`,
    description: note === "" ? `${description}.` : `${description}. To-dos ${note}.`,
    current: "/",
    frame: ctx,
    body: html`<div class="page-head">
<h1>Today</h1>
<p class="page-date"><time datetime="${date}">${headerDate(date)}</time></p>
</div>
<div data-region="today-head">
<p class="lede">${summaryLine(summary)}</p>
${waiting === 0 ? "" : html`<p class="pending-note"><a class="button button-quiet" href="/pending">${count(waiting, "change")} from your AI app ${waiting === 1 ? "is" : "are"} waiting. Review ${waiting === 1 ? "it" : "them"}.</a></p>`}
</div>
${addButtons("today", ["deal", "lead", "import"])}
<div class="today-columns">
<div class="today-due" data-region="today-list">
${quickAddForm(ctx)}
${taskTools(view)}
${await taskSections(tasks, dayBoundsUtc(date, tz).start.toISOString(), ctx, tz)}
${dueDeals(due)}
</div>
<div class="today-glance">
${pipelineGlance(summary)}
${briefExcerpt(brief)}
</div>
</div>`,
  });
}
