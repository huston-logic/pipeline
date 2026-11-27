// The shared task row (run 12, docs/STYLE-GUIDE.md §7.24): one line while closed, the actions under a disclosure, the
// sub-tasks under another. Every list of tasks that is not Today's draws its rows here. Outside text is labelled and
// never a link's text; the row's text is plain, because the whole line opens the disclosure.
// A row's forms are sent inside a <noscript>: with scripts off the browser draws them as they are; with scripts on they
// are one text node, never read, and when the row opens public/live.js fetches the same forms from /tasks/<id>/actions
// (pages/task-actions.ts), so a list of a hundred rows loads light.
import { dayBoundsUtc, formatLocal, localDate } from "../time.ts";
import { type FormContext, postForm } from "./forms.ts";
import { type Html, html } from "./html.ts";
import { count, contactHref, dealHref, labelled, projectHref, when } from "./parts.ts";
import { specFields } from "./record-fields.ts";
import { completeAction, descriptionLine, taskActions, taskName, taskSpecs, type TaskRef } from "./task-forms.ts";

export const MAX_LEVEL = 3;
/** A title longer than this is cut on one line at 40rem and up, so the open content shows it in full. */
const FULL_TITLE_OVER = 40;

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
  /** "owner", or the id of the rule that made the task. */
  source?: string;
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
const dayOf = (iso: string, tz: string): string => {
  const text = formatLocal(iso, tz);
  const comma = text.indexOf(",");
  return comma === -1 ? text : text.slice(0, comma);
};

/** The future time a task is snoozed to, or null. */
function snoozedTo(task: Pick<RowTask, "doneAt" | "snoozedUntil">, now: Date): string | null {
  const done = task.doneAt !== undefined && task.doneAt !== null;
  return !done && task.snoozedUntil !== undefined && task.snoozedUntil !== null && task.snoozedUntil > now.toISOString() ? task.snoozedUntil : null;
}

export function dueCell(task: Pick<RowTask, "dueAt" | "dueAtLocal" | "doneAt" | "snoozedUntil">, opts: RowOptions): Html {
  if (task.doneAt !== undefined && task.doneAt !== null) {
    return html`<span class="task-due">Done ${when(task.doneAt, dayOf(task.doneAt, opts.tz))}</span>`;
  }
  const snoozed = snoozedTo(task, opts.now);
  if (snoozed !== null) return html`<span class="task-due">Snoozed to ${when(snoozed, dayOf(snoozed, opts.tz))}</span>`;
  if (task.dueAt === null || task.dueAtLocal === null) return html`<span class="task-due"></span>`;
  const startOfToday = dayBoundsUtc(localDate(opts.now, opts.tz), opts.tz).start.toISOString();
  const late = task.dueAt < startOfToday ? html` <span class="task-late">Overdue</span>` : "";
  return html`<span class="task-due"><span class="visually-hidden">Due </span>${when(task.dueAt, task.dueAtLocal)}${late}</span>`;
}

/** Who or what the task is for (its project, deal or person), labelled when it came from outside; null for none. */
function belongsOf(task: RowTask): Html | null {
  const named: [string | null | undefined, string][] = [
    [task.projectName, "projectName"],
    [task.dealTitle, "dealTitle"],
    [task.contactName, "contactName"],
  ];
  const found = named.find(([value]) => value !== undefined && value !== null && value !== "");
  if (found === undefined || found[0] === undefined || found[0] === null) return null;
  return labelled(found[0], outsideIn(task, found[1]));
}

function belongsCell(task: RowTask): Html {
  const who = belongsOf(task);
  return who === null ? html`<span class="task-belongs"></span>` : html`<span class="task-belongs"><span class="visually-hidden">, for </span>${who}</span>`;
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
    return html`<span class="task-done-box task-done-static">${box}<span class="visually-hidden">Done: ${name}</span></span>`;
  }
  return postForm(
    "task-done",
    completeAction(task.id),
    form,
    html`<button class="task-done-box" id="done-${task.id}" type="submit">${box}<span class="visually-hidden">Done: ${name}</span></button>`,
    { live: after === undefined ? {} : { after } },
  );
}

/** An open row's actions (Start timer, Snooze, Edit, and on a project tree Add a sub-task and Move): its <noscript> and /tasks/<id>/actions both draw them here. */
export function rowActions(task: RowTask, form: FormContext, tz: string): Promise<Html> {
  const canAdd = task.onProject && task.level < MAX_LEVEL;
  const extra = html`${canAdd ? subTaskForm(task, form) : ""}${task.onProject ? moveForm(task, form) : ""}`;
  return taskActions(task, form, tz, { withDone: false, extra });
}

/**
 * Where public/live.js reads an opened row's actions, with how the row was drawn: `tree` is its level in a project tree
 * (0 when it is not in one), `up` and `down` that it has siblings to move past. Built from the id and the row's place only.
 */
export function actionsHref(task: RowTask): string {
  const query = new URLSearchParams({ tree: task.onProject ? String(task.level) : "0" });
  if (task.onProject && task.hasSiblingsBefore === true) query.set("up", "1");
  if (task.onProject && task.hasSiblingsAfter === true) query.set("down", "1");
  return `/tasks/${encodeURIComponent(task.id)}/actions?${query}`;
}

async function openContent(task: RowTask, opts: RowOptions, form: FormContext): Promise<Html> {
  const done = task.doneAt !== undefined && task.doneAt !== null;
  const snoozed = snoozedTo(task, opts.now);
  const long = task.title.length > FULL_TITLE_OVER;
  const byRule = task.source !== undefined && task.source !== "owner";
  const who = opts.showBelongs ? belongsOf(task) : null;
  return html`<div class="task-open-body"${done ? "" : html` data-actions="${actionsHref(task)}"`}>
${long ? html`<p class="task-fulltitle">${labelled(task.title, outsideIn(task, "title"))}</p>` : ""}
${who === null ? "" : html`<p class="task-for">For ${who}</p>`}
${snoozed === null ? "" : html`<p class="task-note">Snoozed until ${when(snoozed, formatLocal(snoozed, opts.tz))}</p>`}
${byRule ? html`<p class="task-note">Added by rule ${task.source}</p>` : ""}
${descriptionLine(task)}
${linksLine(task)}
${done ? "" : html`<noscript>${await rowActions(task, form, opts.tz)}</noscript>`}
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
  const classes = `task-row${opts.showBelongs ? "" : " no-belongs"}`;
  const deeper = task.level === MAX_LEVEL && (task.deeper ?? 0) > 0 ? html`<p class="field-hint task-deeper">Has ${count(task.deeper ?? 0, "more level")} below. Your AI app can show them.</p>` : "";
  return html`<li class="${classes}" data-task-row id="t-${task.id}">
${doneBox(task, form, after)}
<details class="task-open" id="open-${task.id}">
<summary><span class="task-title">${labelled(task.title, outsideIn(task, "title"))}</span> ${dueCell(task, opts)} ${opts.showBelongs ? belongsCell(task) : ""}</summary>
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
  const subs = rows.some((row) => row.level < MAX_LEVEL && (row.children?.length ?? 0) > 0);
  return html`<ul class="task-rows${nested ? " task-rows-nested" : ""}${subs ? " has-subs" : ""}">${drawn}</ul>`;
}
