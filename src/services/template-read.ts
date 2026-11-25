// Reading project templates: the list, and one template's live tasks as a tree.
import type { Db, ProjectTemplateRow, TemplateTaskRow, WorkTypeRow } from "../db/db.ts";
import { templateTasksOf } from "./lookup.ts";
import { requireProjects } from "./settings.ts";
import { findTemplate } from "./templates.ts";

export interface TemplateListItem {
  id: string;
  name: string;
  description: string | null;
  /** Live tasks. */
  taskCount: number;
  archived: boolean;
}

export interface TemplateTaskView {
  id: string;
  title: string;
  /** 0 for a top-level task. */
  depth: number;
  dueDays: number | null;
  workTypeId: string | null;
  workType: string | null;
}

export interface TemplateView {
  id: string;
  name: string;
  description: string | null;
  archived: boolean;
  tasks: TemplateTaskView[];
}

export async function listTemplates(db: Db, options: { includeArchived?: boolean } = {}): Promise<TemplateListItem[]> {
  await requireProjects(db);
  const templates = await db
    .prepare(`SELECT * FROM project_templates ${options.includeArchived === true ? "" : "WHERE archived = 0"} ORDER BY lower(name), id`)
    .all<ProjectTemplateRow>();
  const counts = await db
    .prepare("SELECT template_id, count(*) AS n FROM template_tasks WHERE archived = 0 GROUP BY template_id")
    .all<{ template_id: string; n: number }>();
  const byTemplate = new Map(counts.results.map((row) => [row.template_id, row.n]));
  return templates.results.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    taskCount: byTemplate.get(row.id) ?? 0,
    archived: row.archived === 1,
  }));
}

export async function getTemplate(db: Db, ref: string): Promise<TemplateView> {
  const template = await findTemplate(db, ref);
  const tasks = await templateTasksOf(db, template.id);
  const types = await db.prepare("SELECT * FROM work_types").all<WorkTypeRow>();
  const names = new Map(types.results.map((row) => [row.id, row.name]));
  const depths = new Map<string, number>();
  const views = tasks.map((task: TemplateTaskRow) => {
    const depth = task.parent_id === null ? 0 : (depths.get(task.parent_id) ?? 0) + 1;
    depths.set(task.id, depth);
    return {
      id: task.id,
      title: task.title,
      depth,
      dueDays: task.due_days,
      workTypeId: task.work_type_id,
      workType: task.work_type_id === null ? null : (names.get(task.work_type_id) ?? null),
    };
  });
  return { id: template.id, name: template.name, description: template.description, archived: template.archived === 1, tasks: views };
}
