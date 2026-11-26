// The project page's task tree (decision 0057): nested lists to three levels, each row with its due date, "N of M done",
// and the controls. Outside titles are labelled; a task's name in a control's hidden words is its title or its id.
import type { TaskNode } from "../services/project-read.ts";
import { formatLocal } from "../time.ts";
import { type FormContext, postForm } from "./forms.ts";
import { type Html, html } from "./html.ts";
import { count, labelled, tag, when } from "./parts.ts";
import { specFields } from "./record-fields.ts";
import { descriptionLine, taskActions, taskName, taskSpecs } from "./task-forms.ts";

export const MAX_LEVEL = 3;

export const subTaskAction = (id: string): string => `/tasks/${encodeURIComponent(id)}/subtasks`;
export const moveAction = (id: string): string => `/tasks/${encodeURIComponent(id)}/move`;

/** How many levels lie below a task. */
const levelsBelow = (node: TaskNode): number => node.children.reduce((most, child) => Math.max(most, 1 + levelsBelow(child)), 0);

const hiddenName = (name: string) => html`<span class="visually-hidden">: ${name}</span>`;

function moveForm(node: TaskNode, first: boolean, last: boolean, form: FormContext): Html | "" {
  if (first && last) return "";
  const name = taskName(node);
  return postForm(
    "task-move",
    moveAction(node.id),
    form,
    html`${first ? "" : html`<button class="button button-quiet button-small" type="submit" name="dir" value="up">Move up${hiddenName(name)}</button>`}
${last ? "" : html`<button class="button button-quiet button-small" type="submit" name="dir" value="down">Move down${hiddenName(name)}</button>`}`,
  );
}

function subTaskForm(node: TaskNode, form: FormContext): Html {
  return postForm(
    "inline-form",
    subTaskAction(node.id),
    form,
    html`<fieldset class="field field-when">
<legend>Add a sub-task</legend>
${specFields(taskSpecs(), new Map(), `subtask-${node.id}`)}
<button class="button button-small" type="submit">Add sub-task${hiddenName(taskName(node))}</button>
</fieldset>`,
    { novalidate: true },
  );
}

function changeControls(node: TaskNode, level: number, first: boolean, last: boolean, form: FormContext): Html | "" {
  const move = moveForm(node, first, last, form);
  const add = level < MAX_LEVEL ? subTaskForm(node, form) : "";
  if (move === "" && add === "") return "";
  return html`<details class="task-more">
<summary>Change${hiddenName(taskName(node))}</summary>
${move}
${add}
</details>`;
}

function row(node: TaskNode, level: number, first: boolean, last: boolean, now: Date, tz: string, form: FormContext): Html {
  const done = node.doneAt !== null;
  const snoozed = !done && node.snoozedUntil !== null && node.snoozedUntil > now.toISOString() ? node.snoozedUntil : null;
  const total = node.subTasks.open + node.subTasks.done;
  const deeper = levelsBelow(node);
  return html`<li class="task-node">
<div class="task-row">
<p class="row-text">${labelled(node.title, node.untrusted_fields.includes("title"))} ${done ? tag("Done") : ""}${snoozed === null ? "" : html` ${tag("Snoozed")}`}</p>
<p class="row-head">${
    node.doneAt !== null
      ? html`Done ${when(node.doneAt, formatLocal(node.doneAt, tz))}`
      : node.dueAt !== null && node.dueAtLocal !== null
        ? html`Due ${when(node.dueAt, node.dueAtLocal)}`
        : "No due date"
  }${total > 0 ? html` · ${node.subTasks.done} of ${total} done` : ""}</p>
${level === MAX_LEVEL && deeper > 0 ? html`<p class="field-hint">Has ${count(deeper, "more level")} below. Your AI app can show them.</p>` : ""}
${descriptionLine(node)}
${done ? "" : taskActions(node, form, tz)}
${done ? "" : changeControls(node, level, first, last, form)}
</div>
${level < MAX_LEVEL ? taskList(node.children, level + 1, now, tz, form) : ""}
</li>`;
}

/** One level's nested list; a level-1 call starts the tree. */
export function taskList(nodes: TaskNode[], level: number, now: Date, tz: string, form: FormContext): Html | "" {
  if (nodes.length === 0) return "";
  return html`<ul class="task-tree">${nodes.map((node, index) => row(node, level, index === 0, index === nodes.length - 1, now, tz, form))}</ul>`;
}
