// Today (/): one dense list of rows grouped by when (run 12, style guide §5): Overdue, Today, Upcoming and No due date,
// each to-do, project and deal due a row (decision 0047, ruling 9), under a head with the summary and the stage counts.
import { headerDate } from "../../brief/compose.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { countOpenProposals } from "../../services/proposals.ts";
import { pipelineSummary, type PipelineSummary } from "../../services/read.ts";
import { type TodayGroups, type TodayItem, todayRows } from "../../services/today.ts";
import { localDate } from "../../time.ts";
import { type Html, html } from "../html.ts";
import type { PageContext } from "../context.ts";
import { renderPage } from "../layout.ts";
import { addButtons, count, empty, formatNumber, section } from "../parts.ts";
import { TASK_SHOWS, TASK_SORTS, type TaskShow, type TaskSort, type TaskView, taskView } from "../task-list.ts";
import { quickAddForm } from "../task-forms.ts";
import { type RowOptions, taskRow } from "../task-row.ts";
import { dealRow, projectRow } from "../today-rows.ts";
import { summaryLine } from "./pipeline.ts";

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

/**
 * Sort and filter as a plain GET form (decision 0047): the address carries only these two keys. Open on a laptop; the
 * script closes it on a phone and, when it runs, applies a choice at once and hides the button.
 */
function taskTools(view: TaskView): Html {
  return html`<details class="today-tools" open data-close-narrow>
<summary>Sort and filter</summary>
<form class="today-filter" action="/" method="get" aria-label="Sort and filter to-dos" data-autosubmit>
${choice("todo-sort", "sort", "Sort", TASK_SORTS, SORT_LABELS, view.sort)}
${choice("todo-show", "show", "Show", TASK_SHOWS, SHOW_LABELS, view.show)}
<button class="button button-small" type="submit" data-autosubmit-hide>Show to-dos</button>
</form>
</details>`;
}

const GROUPS = [
  { key: "overdue", heading: "Overdue" },
  { key: "today", heading: "Today" },
  { key: "upcoming", heading: "Upcoming" },
  { key: "undated", heading: "No due date" },
] as const;

/** Each group's rows, in order. A task's Done sends focus to the next task row's Done box, across groups. */
async function groupSections(groups: TodayGroups, ctx: PageContext, tz: string): Promise<Html> {
  const opts: RowOptions = { now: ctx.now, tz, showBelongs: true };
  const all = GROUPS.flatMap(({ key }) => groups[key]);
  const nextDone = (item: TodayItem): string | undefined => {
    for (const later of all.slice(all.indexOf(item) + 1)) if (later.kind === "task") return `done-${later.task.id}`;
    return undefined;
  };
  const row = (item: TodayItem): Promise<Html> | Html => {
    if (item.kind === "deal") return dealRow(item.deal, opts);
    if (item.kind === "project") return projectRow(item.project, opts, ctx);
    return taskRow({ ...item.task, level: 1, onProject: false }, opts, ctx, nextDone(item));
  };
  const sections = await Promise.all(
    GROUPS.filter(({ key }) => groups[key].length > 0).map(async ({ key, heading }) => {
      const rows = await Promise.all(groups[key].map(row));
      return section(`today-${key}`, heading, html`<ul class="task-rows">${rows}</ul>`, "today-group");
    }),
  );
  const cut = groups.cut === null ? "" : html`<p class="stage-more">Showing ${formatNumber(groups.cut.shown)} of ${formatNumber(groups.cut.total)} to-dos.</p>`;
  return html`${sections}${cut}`;
}

/** Open deals by stage, a label and its count each, every label a link to its column. */
function stageCounts(summary: PipelineSummary): Html | "" {
  if (summary.stages.length === 0) return "";
  return html`<dl class="stage-counts" aria-label="Open deals by stage">${summary.stages.map(
    (stage, i) => html`<div><dt><a href="/pipeline#stage-${i + 1}">${stage.label}</a></dt><dd>${stage.count}</dd></div>`,
  )}</dl>`;
}

/** One short line: the open deals and their value (the closed ones are on the Pipeline page). */
function openLine(summary: PipelineSummary): string {
  if (summary.total === 0) return summaryLine(summary);
  const value = summary.open.value > 0 ? `, total value ${formatNumber(summary.open.value)}` : "";
  return `${count(summary.open.count, "open deal")}${value}.`;
}

export async function todayPage(ctx: PageContext): Promise<string> {
  const { db, now } = ctx;
  const tz = await ownerTimezone(db);
  const view = taskView(ctx.query);
  const [summary, groups, waiting] = await Promise.all([pipelineSummary(db, now, tz), todayRows(db, now, tz, view), countOpenProposals(db, now)]);
  const date = localDate(now, tz);
  const note = viewNote(view);
  const description = "Your open to-dos grouped by when they are due, the deals due and your open deals by stage";
  const nothing = GROUPS.every(({ key }) => groups[key].length === 0);
  return renderPage({
    title: note === "" ? "Today" : `Today, ${note}`,
    description: note === "" ? `${description}.` : `${description}. To-dos ${note}.`,
    current: "/",
    frame: ctx,
    body: html`<div class="today-head" data-region="today-head">
<div class="today-intro">
<div class="page-head">
<h1>Today</h1>
<p class="page-date"><time datetime="${date}">${headerDate(date)}</time></p>
</div>
<p class="today-summary">${openLine(summary)}</p>
${waiting === 0 ? "" : html`<p class="pending-note"><a href="/pending">${count(waiting, "change")} from your AI app ${waiting === 1 ? "is" : "are"} waiting. Review ${waiting === 1 ? "it" : "them"}.</a></p>`}
${addButtons("today", ["deal", "lead", "import"], true)}
</div>
${stageCounts(summary)}
</div>
<div data-region="today-list">
${quickAddForm(ctx)}
${taskTools(view)}
${nothing ? empty("Nothing to do.", "Add a to-do above, or add a task on a deal or contact page.") : await groupSections(groups, ctx, tz)}
</div>`,
  });
}
