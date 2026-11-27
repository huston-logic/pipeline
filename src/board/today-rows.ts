// Today's two rows that are not a task (run 12, style guide §5 and §7.24): a project, folded into one row, and a deal
// whose next step is due. Both wear the task row's markup, so a list of them lines up; a deal has an empty Done cell, a project
// a chevron drawn by CSS that marks it as a group. Outside
// text is labelled and never a link's text; the row's text is plain, because the whole line opens the disclosure.
import type { DealItem } from "../services/read.ts";
import { PROJECT_TASK_LIMIT, type TodayProject } from "../services/today.ts";
import { dueText } from "../time.ts";
import type { FormContext } from "./forms.ts";
import { type Html, html } from "./html.ts";
import { count, dealHref, labelled, projectHref } from "./parts.ts";
import { taskList } from "./project-tree.ts";
import { dueCell, type RowOptions } from "./task-row.ts";

const emptyCell = html`<span class="task-done-cell" aria-hidden="true"></span>`;

/** A deal due: the deal's title, when its next step is due, the person; open, the next step and a link to the deal. */
export function dealRow(deal: DealItem, opts: RowOptions): Html {
  const due = dueCell({ dueAt: deal.nextAt, dueAtLocal: deal.nextAt === null ? null : dueText(deal.nextAt, opts.tz), doneAt: null, snoozedUntil: null }, opts);
  return html`<li class="task-row next-step-row" data-task-row id="d-${deal.id}">
${emptyCell}
<details class="task-open" id="open-d-${deal.id}">
<summary><span class="task-title">${labelled(deal.title, deal.untrusted_fields.includes("title"))}</span> ${due} <span class="task-belongs"><span class="visually-hidden">, for </span>${labelled(deal.contactName, deal.untrusted_fields.includes("contactName"))}</span></summary>
<div class="task-open-body">
<p>Next step: ${deal.nextStep ?? "Not written down"}</p>
<p class="task-links"><a href="${dealHref(deal.id)}">Open the deal</a></p>
</div>
</details>
</li>`;
}

/** A project: its name, its soonest due, "N tasks, M overdue"; open, the top-level tasks as rows and a link to the project. */
export async function projectRow(project: TodayProject, opts: RowOptions, form: FormContext): Promise<Html> {
  const due = dueCell({ dueAt: project.soonest, dueAtLocal: project.soonestLocal, doneAt: null, snoozedUntil: null }, opts);
  return html`<li class="task-row project-row" data-task-row id="p-${project.id}">
<details class="task-open" id="open-p-${project.id}">
<summary><span class="task-title">${labelled(project.name, project.untrusted_fields.includes("name"))}</span> ${due} <span class="task-belongs"><span class="visually-hidden">, </span>${count(project.topLevel, "task")}, ${project.overdue} overdue</span></summary>
<div class="task-open-body project-tasks">
${await taskList(project.tasks, 1, opts.now, opts.tz, form)}
${project.truncated ? html`<p class="field-hint task-more-note">Showing the first ${PROJECT_TASK_LIMIT} tasks of your projects. Open the project to see the rest.</p>` : ""}
<p class="task-links"><a href="${projectHref(project.id)}">Open the project</a></p>
</div>
</details>
</li>`;
}
