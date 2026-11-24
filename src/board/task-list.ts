// Today's task list (decision 0047): which sort and filter the address asks for. Pure: it reads no record text into an
// address, and an unknown value is the default. The lists themselves are filtered and sorted in SQL (openTaskLists).
import { TASK_SHOWS, TASK_SORTS, type TaskShow, type TaskSort, type TaskView } from "../services/read.ts";

export { TASK_SHOWS, TASK_SORTS, type TaskShow, type TaskSort, type TaskView };

const oneOf = <T extends string>(allowed: readonly T[], value: string | null, fallback: T): T =>
  allowed.find((item) => item === value) ?? fallback;

/** The sort and filter an address asks for (`sort=due|newest|subject`, `show=all|linked|standalone`). */
export function taskView(query: URLSearchParams): TaskView {
  return { sort: oneOf(TASK_SORTS, query.get("sort"), "due"), show: oneOf(TASK_SHOWS, query.get("show"), "all") };
}

export const isStandalone = (task: { dealId: string | null; contactId: string | null }): boolean => task.dealId === null && task.contactId === null;
