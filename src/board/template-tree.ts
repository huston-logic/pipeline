// A template's task tree on its page (run 10, area 4): nested lists to three levels, each row with its title, "Day N" and
// work type, and a Change menu of the row's actions. A task's name in a control's hidden words is its title.
import type { TemplateTaskView } from "../services/template-read.ts";
import { type FormContext, postForm } from "./forms.ts";
import { type Html, html } from "./html.ts";
import { count } from "./parts.ts";
import { templateTaskEditPath, templateTaskPost } from "./template-form.ts";

export const MAX_LEVEL = 3;

export type TreeNode = { task: TemplateTaskView; children: TreeNode[] };

/** The flat, tree-ordered list as nested nodes. */
export function treeOf(tasks: TemplateTaskView[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const stack: TreeNode[] = [];
  for (const task of tasks) {
    const node: TreeNode = { task, children: [] };
    stack.length = task.depth;
    (stack[task.depth - 1]?.children ?? roots).push(node);
    stack[task.depth] = node;
  }
  return roots;
}

/** How many levels lie below a node. */
const levelsBelow = (node: TreeNode): number => node.children.reduce((most, child) => Math.max(most, 1 + levelsBelow(child)), 0);

const hiddenName = (name: string) => html`<span class="visually-hidden">: ${name}</span>`;

function moveForm(node: TreeNode, level: number, first: boolean, last: boolean, form: FormContext): Html | "" {
  const name = node.task.title;
  // Under the task above puts this task and everything below it one level deeper: it must still fit in three.
  const canIndent = !first && level + 1 + levelsBelow(node) <= MAX_LEVEL;
  const button = (dir: string, label: string) =>
    html`<button class="button button-quiet button-small" type="submit" name="dir" value="${dir}">${label}${hiddenName(name)}</button>`;
  const buttons = [first ? "" : button("up", "Move up"), last ? "" : button("down", "Move down"), canIndent ? button("in", "Move under the task above") : "", level > 1 ? button("out", "Move out a level") : ""];
  if (buttons.every((one) => one === "")) return "";
  return postForm("task-move", templateTaskPost(node.task.id, "/move"), form, html`${buttons}`);
}

function changeControls(templateId: string, node: TreeNode, level: number, first: boolean, last: boolean, form: FormContext): Html {
  const name = node.task.title;
  return html`<details class="task-more">
<summary>Change${hiddenName(name)}</summary>
<p><a class="button button-quiet button-small" href="${templateTaskEditPath(templateId, node.task.id)}">Edit${hiddenName(name)}</a></p>
${moveForm(node, level, first, last, form)}
${postForm("task-remove", templateTaskPost(node.task.id, "/archive"), form, html`<button class="button button-quiet button-small" type="submit">Remove${hiddenName(name)}</button>`)}
</details>`;
}

function row(templateId: string, node: TreeNode, level: number, first: boolean, last: boolean, opts: TreeOptions): Html {
  const { task } = node;
  const deeper = levelsBelow(node);
  const facts = [task.dueDays === null ? "" : `Day ${task.dueDays}`, opts.timeTracking && task.workType !== null ? task.workType : ""].filter((part) => part !== "");
  return html`<li class="task-node">
<div class="task-row">
<p class="row-text">${task.title}</p>
${facts.length === 0 ? "" : html`<p class="row-head">${facts.join(" · ")}</p>`}
${level === MAX_LEVEL && deeper > 0 ? html`<p class="field-hint">Has ${count(deeper, "more level")} below. Your AI app can show them.</p>` : ""}
${opts.editable ? changeControls(templateId, node, level, first, last, opts.form) : ""}
</div>
${level < MAX_LEVEL ? list(templateId, node.children, level + 1, opts) : ""}
</li>`;
}

export type TreeOptions = { form: FormContext; timeTracking: boolean; editable: boolean };

function list(templateId: string, nodes: TreeNode[], level: number, opts: TreeOptions): Html | "" {
  if (nodes.length === 0) return "";
  return html`<ul class="task-tree">${nodes.map((node, index) => row(templateId, node, level, index === 0, index === nodes.length - 1, opts))}</ul>`;
}

export const templateTaskList = (templateId: string, tasks: TemplateTaskView[], opts: TreeOptions): Html | "" => list(templateId, treeOf(tasks), 1, opts);