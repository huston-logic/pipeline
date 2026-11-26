// The shared task row (run 12, docs/STYLE-GUIDE.md §7.24): one line while closed, the actions under a disclosure, the
// sub-tasks under another. Every list of tasks that is not Today's draws its rows here. Outside text is labelled and
// never a link's text; the row's text is plain, because the whole line opens the disclosure.
import { dayBoundsUtc, formatLocal, localDate } from "../time.ts";
import { type FormContext, postForm } from "./forms.ts";
import { type Html, html } from "./html.ts";
import { count, contactHref, dealHref, labelled, projectHref, when } from "./parts.ts";
import { specFields } from "./record-fields.ts";
import { completeAction, descriptionLine, taskActions, taskName, taskSpecs, type TaskRef } from "./task-forms.ts";

export const MAX_LEVEL = 3;

export type RowTask = TaskRef & {
  dueAt: string | null;
  dueAtLocal: string | null;
  doneAt?: string | null;
  description: string | null;
  snoozedUntil?: string | null;
  dealId?: string | null;
  dealTitle?: string | null;
  contactId?: string | null;
  contactName?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  parentId?: string | null;
  subTasks?: { open: number; done: number };
  children?: RowTask[];
  level: 1 | 2 | 3;
  /** The task is on a project: it may take sub-tasks and be moved among its siblings. */
  onProject: boolean;
  hasSiblingsBefore?: boolean;
  hasSiblingsAfter?: boolean;
  /** How many levels lie below a level 3 task (shown as a hint, never drawn). */
  deeper?: number;
};

export type RowOptions = { now: Date; tz: string; showBelongs: boolean };

export const subTaskAction = (id: string): string => `/tasks/${encodeURIComponent(id)}/subtasks`;
export const moveAction = (id: string): string => `/tasks/${encodeURIComponent(id)}/move`;

const hiddenName = (name: string) => html`<span class="visually-hidden">: ${name}</span>`;

const outsideIn = (task: RowTask, key: string): boolean => (typeof task.untrusted_fields === "string" ? task.untrusted_fields.includes(`"${key}"`) : task.untrusted_fields.includes(key));

function moveForm(task: RowTask, form: FormContext): Html | "" {
  const up = task.hasSiblingsBefore === true;
  const down = task.hasSiblingsAfter === true;
  if (!up && !down) return "";
  const name = taskName(task);
  return postForm(
    "task-move",
    moveAction(task.id),
    form,
    html`${up ? html`<button class="button button-quiet button-small" type="submit" name="dir" value="up">Move up${hiddenName(name)}</button>` : ""}
${down ? html`<button class="button button-quiet button-small" type="submit" name="dir" value="down">Move down${hiddenName(name)}</button>` : ""}`,
    { live: {} },
  );
}

function subTaskForm(task: RowTask, form: FormContext): Html {
  const name = taskName(task);
  return html`<details class="task-subadd" id="subadd-${task.id}">
<summary>Add a sub-task${hiddenName(name)}</summary>
${postForm(
  "inline-form",
  subTaskAction(task.id),
  form,
  html`<fieldset class="field field-when">
<legend>Add a sub-task</legend>
${specFields(taskSpecs(), new Map(), `subtask-${task.id}`)}
<button class="button button-small" type="submit">Add sub-task${hiddenName(name)}</button>
</fieldset>`,
  { novalidate: true, live: {} },
)}
</details>`;
}

/** The due cell: the day (or day and time), "Overdue" beside it in words when it was due before today, or "Done <day>". */
function dueCell(task: RowTask, opts: RowOptions): Html {
  if (task.doneAt !== undefined && task.doneAt !== null) {
    const done = formatLocal(task.doneAt, opts.tz);
    return html`<span class="task-due">Done ${when(task.doneAt, done.slice(0, done.indexOf(",")))}</span>`;
  }
  if (task.dueAt === null || task.dueAtLocal === null) return html`<span class="task-due"></span>`;
  const startOfToday = dayBoundsUtc(localDate(opts.now, opts.tz), opts.tz).start.toISOString();
  const late = task.dueAt < startOfToday ? html` <span class="task-late">Overdue</span>` : "";
  return html`<span class="task-due">${when(task.dueAt, task.dueAtLocal)}${late}</span>`;
}

function belongsCell(task: RowTask): Html {
  const named: [string | null | undefined, string][] = [
    [task.projectName, "projectName"],
    [task.dealTitle, "dealTitle"],
    [task.contactName, "contactName"],
  ];
  const found = named.find(([value]) => value !== undefined && value !== null && value !== "");
  if (found === undefined || found[0] === undefined || found[0] === null) return html`<span class="task-belongs"></span>`;
  return html`<span class="task-belongs">${labelled(found[0], outsideIn(task, found[1]))}</span>`;
}

function linksLine(task: RowTask): Html | "" {
  const links = [
    task.dealId ? html`<a href="${dealHref(task.dealId)}">Open the deal</a>` : "",
    task.contactId ? html`<a href="${contactHref(task.contactId)}">Open the person</a>` : "",
    task.projectId ? html`<a href="${projectHref(task.projectId)}">Open the project</a>` : "",
  ].filter((link) => link !== "");
  return links.length === 0 ? "" : html`<p class="task-links">${links}</p>`;
}

function doneBox(task: RowTask, form: FormContext, after: string | undefined): Html {
  const name = taskName(task);
  const box = html`<span class="task-box" aria-hidden="true"></span>`;
  if (task.doneAt !== undefined && task.doneAt !== null) {
    return html`<span class="task-done-box task-done-static">${box}<span class="visually-hidden">Done</span></span>`;
  }
  return postForm(
    "task-done",
    completeAction(task.id),
    form,
    html`<button class="task-done-box" id="done-${task.id}" type="submit">${box}<span class="visually-hidden">Done: ${name}</span></button>`,
    { live: after === undefined ? {} : { after } },
  );
}

async function openContent(task: RowTask, opts: RowOptions, form: FormContext): Promise<Html> {
  const done = task.doneAt !== undefined && task.doneAt !== null;
  const snoozed = !done && task.snoozedUntil !== undefined && task.snoozedUntil !== null && task.snoozedUntil > opts.now.toISOString() ? task.snoozedUntil : null;
  const canAdd = task.onProject && task.level < MAX_LEVEL;
  const extra = html`${canAdd ? subTaskForm(task, form) : ""}${task.onProject ? moveForm(task, form) : ""}`;
  return html`<div class="task-open-body">
${snoozed === null ? "" : html`<p class="task-note">Snoozed until ${when(snoozed, formatLocal(snoozed, opts.tz))}</p>`}
${descriptionLine(task)}
${linksLine(task)}
${done ? "" : await taskActions(task, form, opts.tz, { withDone: false, extra })}
</div>`;
}

function subsSummary(task: RowTask, children: RowTask[]): Html {
  const open = task.subTasks?.open ?? children.filter((child) => child.doneAt === undefined || child.doneAt === null).length;
  const total = task.subTasks === undefined ? children.length : task.subTasks.open + task.subTasks.done;
  const words = open > 0 ? `${count(open, "open sub-task")}` : count(total, "sub-task");
  return html`${words}${hiddenName(taskName(task))}`;
}

/** One row. `after` is the id of the next row's Done box, where focus goes when this one is done. */
export async function taskRow(task: RowTask, opts: RowOptions, form: FormContext, after?: string): Promise<Html> {
  const children = task.level < MAX_LEVEL ? (task.children ?? []) : [];
  const classes = `task-row${children.length > 0 ? " has-subs" : ""}${opts.showBelongs ? "" : " no-belongs"}`;
  const deeper = task.level === MAX_LEVEL && (task.deeper ?? 0) > 0 ? html`<p class="field-hint task-deeper">Has ${count(task.deeper ?? 0, "more level")} below. Your AI app can show them.</p>` : "";
  return html`<li class="${classes}" data-task-row id="t-${task.id}">
${doneBox(task, form, after)}
<details class="task-open" id="open-${task.id}">
<summary><span class="task-title">${labelled(task.title, outsideIn(task, "title"))}</span>${dueCell(task, opts)}${opts.showBelongs ? belongsCell(task) : ""}</summary>
${await openContent(task, opts, form)}
</details>
${
  children.length === 0
    ? ""
    : html`<details class="task-subs" id="subs-${task.id}">
<summary>${subsSummary(task, children)}</summary>
${await taskRows(children, opts, form)}
</details>`
}
${deeper}
</li>`;
}

/** A list of rows in one white panel; a nested list (level 2 and 3) has no border of its own. */
export async function taskRows(rows: RowTask[], opts: RowOptions, form: FormContext): Promise<Html> {
  const nested = (rows[0]?.level ?? 1) > 1;
  const isOpen = (row: RowTask) => row.doneAt === undefined || row.doneAt === null;
  const drawn = await Promise.all(
    rows.map((row, index) => {
      const next = rows.slice(index + 1).find(isOpen);
      return taskRow(row, opts, form, next === undefined ? undefined : `done-${next.id}`);
    }),
  );
  return html`<ul class="task-rows${nested ? " task-rows-nested" : ""}">${drawn}</ul>`;
}
