// Today's task list (decision 0047): which sort and filter the address asks for, and the two lists the tasks fall into.
// Pure: it reads no record text into an address, and an unknown value is the default.

export const TASK_SORTS = ["due", "newest", "subject"] as const;
export const TASK_SHOWS = ["all", "linked", "standalone"] as const;

export type TaskSort = (typeof TASK_SORTS)[number];
export type TaskShow = (typeof TASK_SHOWS)[number];
export type TaskView = { sort: TaskSort; show: TaskShow };

/** What the list needs to know about a task. `contactName` is the person, the deal's person for a task on a deal. */
export interface ListedTask {
  id: string;
  dueAt: string | null;
  createdAt: string;
  dealId: string | null;
  contactId: string | null;
  contactName: string | null;
}

const oneOf = <T extends string>(allowed: readonly T[], value: string | null, fallback: T): T =>
  allowed.find((item) => item === value) ?? fallback;

/** The sort and filter an address asks for (`sort=due|newest|subject`, `show=all|linked|standalone`). */
export function taskView(query: URLSearchParams): TaskView {
  return { sort: oneOf(TASK_SORTS, query.get("sort"), "due"), show: oneOf(TASK_SHOWS, query.get("show"), "all") };
}

export const isStandalone = (task: Pick<ListedTask, "dealId" | "contactId">): boolean => task.dealId === null && task.contactId === null;

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
// Dated tasks come before undated ones; within the dated, the soonest first (overdue ones are simply the earliest).
const byDue = (a: ListedTask, b: ListedTask) =>
  a.dueAt === b.dueAt ? 0 : a.dueAt === null ? 1 : b.dueAt === null ? -1 : byText(a.dueAt, b.dueAt);
const bySubject = (a: ListedTask, b: ListedTask) => {
  if (a.contactName === null || b.contactName === null) return a.contactName === b.contactName ? 0 : a.contactName === null ? 1 : -1;
  return byText(a.contactName.toLowerCase(), b.contactName.toLowerCase());
};

const COMPARE: Record<TaskSort, (a: ListedTask, b: ListedTask) => number> = {
  due: (a, b) => byDue(a, b) || byText(a.createdAt, b.createdAt),
  newest: (a, b) => byText(b.createdAt, a.createdAt),
  subject: (a, b) => bySubject(a, b) || byDue(a, b) || byText(a.createdAt, b.createdAt),
};

/** The filtered, sorted tasks in two lists: To do (has a due date) and Needs a due date (has none). */
export function arrangeTasks<T extends ListedTask>(tasks: readonly T[], view: TaskView): { todo: T[]; undated: T[] } {
  const shown = tasks.filter((task) => view.show === "all" || isStandalone(task) === (view.show === "standalone"));
  const sorted = [...shown].sort((a, b) => COMPARE[view.sort](a, b) || byText(a.id, b.id));
  return { todo: sorted.filter((t) => t.dueAt !== null), undated: sorted.filter((t) => t.dueAt === null) };
}
