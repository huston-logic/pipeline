// The project page's task tree (decision 0057): the shared task row (task-row.ts) nested to three levels, with
// Add a sub-task and Move up and down on each row. Nodes become rows here; the markup is the row's.
import type { TaskNode } from "../services/project-read.ts";
import type { FormContext } from "./forms.ts";
import type { Html } from "./html.ts";
import { MAX_LEVEL, type RowTask, taskRows } from "./task-row.ts";

export { MAX_LEVEL };

/** How many levels lie below a task. */
const levelsBelow = (node: TaskNode): number => node.children.reduce((most, child) => Math.max(most, 1 + levelsBelow(child)), 0);

function toRow(node: TaskNode, level: 1 | 2 | 3, index: number, total: number): RowTask {
  const next = level < MAX_LEVEL ? ((level + 1) as 2 | 3) : null;
  return {
    ...node,
    projectId: null,
    projectName: null,
    contactId: null,
    dealId: null,
    level,
    onProject: true,
    hasSiblingsBefore: index > 0,
    hasSiblingsAfter: index < total - 1,
    deeper: levelsBelow(node),
    children: next === null ? [] : node.children.map((child, i) => toRow(child, next, i, node.children.length)),
  };
}

/** One level's rows in a white panel; a level-1 call starts the tree. */
export async function taskList(nodes: TaskNode[], level: 1 | 2 | 3, now: Date, tz: string, form: FormContext): Promise<Html | ""> {
  if (nodes.length === 0) return "";
  return taskRows(
    nodes.map((node, index) => toRow(node, level, index, nodes.length)),
    { now, tz, showBelongs: false },
    form,
  );
}
