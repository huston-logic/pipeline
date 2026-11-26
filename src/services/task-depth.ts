// How deep tasks nest: three levels (level 1 has no parent). Older deeper rows stay as they are and still read.
import { type Source, taskById } from "./lookup.ts";

export const MAX_TASK_LEVEL = 3;
export const TOO_DEEP = "Sub-tasks go three levels deep. Add this one under a task higher up.";

/** A task's level: 1 with no parent, else its parent's plus one. A parent loop in bad data ends the walk. */
export async function taskLevel(src: Source, taskId: string): Promise<number> {
  const seen = new Set<string>();
  let level = 1;
  let task = await taskById(src, taskId);
  while (task?.parent_id != null && !seen.has(task.id)) {
    seen.add(task.id);
    level += 1;
    task = await taskById(src, task.parent_id);
  }
  return level;
}

/** Each list item's level inside its list: 1 with no `under`, else the named item's plus one (call after `checkTree`). */
export function listLevels(items: readonly { under?: number | undefined }[]): number[] {
  const levels: number[] = [];
  for (const item of items) levels.push(item.under === undefined ? 1 : (levels[item.under - 1] ?? 0) + 1);
  return levels;
}
