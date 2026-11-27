// Today's rows (run 12, ruling 9; builds on decision 0047): the open, awake to-dos, one row per project and the deals
// whose next step is due, grouped by the owner's day. One D1 batch, whatever the number of tasks. Which to-dos qualify
// is `openTaskLists`' rule: every open task that is not snoozed past now.
import type { Db } from "../db/db.ts";
import { dayBoundsUtc, localDate } from "../time.ts";
import { untrustedFields } from "./labels.ts";
import type { TaskNode } from "./project-read.ts";
import {
  type DealItem,
  type DealJoin,
  type OpenTask,
  TASK_FILTER,
  TASK_ORDER,
  TASK_SELECT,
  type TaskJoin,
  toDealItem,
  toTaskItem,
} from "./read.ts";

export type TodayView = { sort: "due" | "newest" | "subject"; show: "all" | "linked" | "standalone" };

/** At most this many loose task rows are shown in all (dated first); the cut is said (`cut`). */
export const TODAY_TASK_LIMIT = 200;
/** At most this many tasks of projects are read for the project rows. */
export const PROJECT_TASK_LIMIT = 500;

export interface TodayProject {
  id: string;
  name: string;
  untrusted_fields: "name"[];
  /** The person the project's tasks are for (the first one found); null for an internal project. */
  contactName: string | null;
  /** Top-level tasks that are open or have an open sub-task (ruling 9). */
  topLevel: number;
  /** Open, awake tasks at any depth due before today started. */
  overdue: number;
  /** The soonest due among the open, awake tasks, and how it reads; null when none has a date. */
  soonest: string | null;
  soonestLocal: string | null;
  /** The top-level tasks counted by `topLevel`, in position order, each with its whole subtree. */
  tasks: TaskNode[];
  /** When the newest of its tasks was made, for the newest-first sort. */
  createdAt: string;
  /** The read of projects' tasks was cut at `PROJECT_TASK_LIMIT`, so this tree may lack its deepest tasks. */
  truncated: boolean;
}

export type TodayItem =
  | { kind: "task"; task: OpenTask }
  | { kind: "project"; project: TodayProject }
  | { kind: "deal"; deal: DealItem };

export interface TodayGroups {
  overdue: TodayItem[];
  today: TodayItem[];
  upcoming: TodayItem[];
  undated: TodayItem[];
  /** Set when there were more loose tasks than rows: how many are shown of how many in all. */
  cut: { shown: number; total: number } | null;
}

const isOpen = (node: TaskNode): boolean => node.doneAt === null;

/** The projects' rows from their tasks (parents first, siblings in position order). */
function projectItems(found: TaskJoin[], now: Date, tz: string, startIso: string, truncated: boolean): TodayProject[] {
  const byProject = new Map<string, { row: TaskJoin; nodes: Map<string, TaskNode>; top: TaskNode[]; createdAt: string }>();
  for (const row of found) {
    if (row.project_ref === null) continue;
    const entry = byProject.get(row.project_ref) ?? { row, nodes: new Map<string, TaskNode>(), top: [] as TaskNode[], createdAt: "" };
    byProject.set(row.project_ref, entry);
    if (row.created_at > entry.createdAt) entry.createdAt = row.created_at;
    const node: TaskNode = { ...toTaskItem(row, tz), doneAt: row.done_at, children: [] };
    entry.nodes.set(node.id, node);
    if (node.parentId === null) entry.top.push(node);
    else entry.nodes.get(node.parentId)?.children.push(node);
  }
  const awake = (node: TaskNode) => isOpen(node) && (node.snoozedUntil === null || node.snoozedUntil <= now.toISOString());
  // Counted: open and awake, or with an open, awake task anywhere below it (ruling 9; a snoozed one is not a to-do now).
  const hasLive = (node: TaskNode): boolean => awake(node) || node.children.some(hasLive);
  const projects: TodayProject[] = [];
  for (const [id, { row, nodes, top, createdAt }] of byProject) {
    const live = [...nodes.values()].filter(awake);
    if (live.length === 0) continue;
    const dated = live.filter((node) => node.dueAt !== null).sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
    const tasks = top.filter(hasLive);
    projects.push({
      id,
      name: row.project_name ?? id,
      untrusted_fields: untrustedFields({ untrusted_fields: row.project_untrusted }).has("name") ? ["name"] : [],
      contactName: [...nodes.values()].find((node) => node.contactName !== null)?.contactName ?? null,
      topLevel: tasks.length,
      overdue: live.filter((node) => node.dueAt !== null && node.dueAt < startIso).length,
      soonest: dated[0]?.dueAt ?? null,
      soonestLocal: dated[0]?.dueAtLocal ?? null,
      tasks,
      createdAt,
      truncated,
    });
  }
  return projects;
}

type Keyed = { item: TodayItem; due: string | null; created: string; who: string | null; title: string; id: string };

function keyed(item: TodayItem): Keyed {
  switch (item.kind) {
    case "task":
      return { item, due: item.task.dueAt, created: item.task.createdAt, who: item.task.contactName, title: item.task.title, id: item.task.id };
    case "project":
      return { item, due: item.project.soonest, created: item.project.createdAt, who: item.project.contactName, title: item.project.name, id: item.project.id };
    case "deal":
      return { item, due: item.deal.nextAt, created: item.deal.stageEnteredAt, who: item.deal.contactName, title: item.deal.title, id: item.deal.id };
  }
}

/** A missing value sorts last. */
const nullsLast = (a: string | null, b: string | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1);
const lower = (text: string | null): string | null => (text === null ? null : text.toLowerCase());
const byDue = (a: Keyed, b: Keyed) => nullsLast(a.due, b.due) || nullsLast(lower(a.title), lower(b.title)) || nullsLast(a.id, b.id);

const ORDER: Record<TodayView["sort"], (a: Keyed, b: Keyed) => number> = {
  due: byDue,
  newest: (a, b) => nullsLast(b.created, a.created) || nullsLast(a.id, b.id),
  subject: (a, b) => nullsLast(lower(a.who), lower(b.who)) || byDue(a, b),
};

/** Open, awake tasks, the projects they are on folded into one row each, and the deals due, grouped by the owner's day. */
export async function todayRows(db: Db, now: Date, tz: string, view: TodayView): Promise<TodayGroups> {
  const { start, end } = dayBoundsUtc(localDate(now, tz), tz);
  const [startIso, endIso, nowIso] = [start.toISOString(), end.toISOString(), now.toISOString()];
  const awake = (alias: string) => `${alias}.done_at IS NULL AND (${alias}.snoozed_until IS NULL OR ${alias}.snoozed_until <= ?)`;
  // A task on a project (while projects are on) is part of its project's row; every other open task is a row.
  const loose = `${awake("t")}${TASK_FILTER[view.show]} AND (t.project_id IS NULL OR (SELECT projects FROM settings LIMIT 1) <> 1)`;
  // The dated and the undated are cut apart, so a long undated list never pushes the overdue ones out (decision 0047).
  const list = (dated: boolean) =>
    db
      .prepare(`${TASK_SELECT} WHERE ${loose} AND t.due_at IS ${dated ? "NOT " : ""}NULL ORDER BY ${TASK_ORDER[view.sort]} LIMIT ?`)
      .bind(nowIso, TODAY_TASK_LIMIT);
  const statements = [list(true), list(false), db.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE ${loose}`).bind(nowIso)];
  if (view.show !== "standalone") {
    statements.push(
      db
        .prepare(
          `${TASK_SELECT} WHERE p.id IS NOT NULL AND t.project_id IN
             (SELECT k.project_id FROM tasks k WHERE ${awake("k")} AND k.project_id IS NOT NULL)
           AND (t.done_at IS NULL OR EXISTS (
             WITH RECURSIVE kids(id, n) AS (
               SELECT c.id, 1 FROM tasks c WHERE c.parent_id = t.id
               UNION SELECT x.id, kids.n + 1 FROM tasks x JOIN kids ON x.parent_id = kids.id WHERE kids.n < 50)
             SELECT 1 FROM kids JOIN tasks o ON o.id = kids.id WHERE o.done_at IS NULL))
           ORDER BY depth, t.position, t.created_at, t.id LIMIT ?`,
        )
        .bind(nowIso, PROJECT_TASK_LIMIT + 1),
      db
        .prepare(
          `SELECT d.*, c.name AS contact_name, c.untrusted_fields AS contact_untrusted, s.label AS stage_label
           FROM deals d JOIN contacts c ON c.id = d.contact_id JOIN stages s ON s.key = d.stage_key
           WHERE d.archived = 0 AND d.status = 'open' AND d.next_at < ? ORDER BY d.next_at, d.id`,
        )
        .bind(endIso),
    );
  }
  const [datedRows, undatedRows, counted, projectRows, dealRows] = await db.batch(statements);
  // At most TODAY_TASK_LIMIT rows in all: the dated first, the undated fill what is left.
  const dated = datedRows?.results ?? [];
  const tasks = [...dated, ...(undatedRows?.results ?? []).slice(0, Math.max(0, TODAY_TASK_LIMIT - dated.length))].map(
    (row): TodayItem => ({ kind: "task", task: { ...toTaskItem(row as TaskJoin, tz), createdAt: (row as TaskJoin).created_at } }),
  );
  const projectFound = (projectRows?.results ?? []) as TaskJoin[];
  const cutProjects = projectFound.length > PROJECT_TASK_LIMIT;
  const projects = projectItems(projectFound.slice(0, PROJECT_TASK_LIMIT), now, tz, startIso, cutProjects).map((project): TodayItem => ({ kind: "project", project }));
  const deals = ((dealRows?.results ?? []) as DealJoin[]).map((row): TodayItem => ({ kind: "deal", deal: toDealItem(row, now, tz) }));
  const total = ((counted?.results ?? []) as { n: number }[])[0]?.n ?? 0;

  const groups: TodayGroups = { overdue: [], today: [], upcoming: [], undated: [], cut: total > tasks.length ? { shown: tasks.length, total } : null };
  for (const item of [...tasks, ...projects, ...deals]) {
    const due = keyed(item).due;
    const group = due === null ? groups.undated : due < startIso ? groups.overdue : due < endIso ? groups.today : groups.upcoming;
    group.push(item);
  }
  for (const group of [groups.overdue, groups.today, groups.upcoming, groups.undated]) {
    const sorted = group.map(keyed).sort(ORDER[view.sort]);
    group.splice(0, group.length, ...sorted.map((entry) => entry.item));
  }
  return groups;
}
