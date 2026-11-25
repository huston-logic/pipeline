// The fields of the project forms, New project and Edit project (decision 0055), as record-form specs (decision 0018): the
// same specs draw the form and read the post. Dates are a date plus an optional time, read in the owner's timezone.
import type { Db, FieldDefRow } from "../db/db.ts";
import { projectStatusRows } from "../services/memo.ts";
import { line, projectFieldSpecs, type Spec } from "./record-form.ts";

export const PROJECT_PREFIX = "project";
export const newProjectOfContactPath = (contactId: string): string => `/contacts/${encodeURIComponent(contactId)}/projects/new`;
export const newProjectOfDealPath = (dealId: string): string => `/deals/${encodeURIComponent(dealId)}/projects/new`;
export const addProjectOfContactPath = (contactId: string): string => `/contacts/${encodeURIComponent(contactId)}/projects`;
export const addProjectOfDealPath = (dealId: string): string => `/deals/${encodeURIComponent(dealId)}/projects`;
export const projectSavePath = (id: string): string => `/projects/${encodeURIComponent(id)}`;

export const newInternalProjectPath = "/projects/new";

/** The tick box that moves a deal's open tasks onto the new project. */
export const MOVE_TASKS = "move_tasks";
/** The tick box that completes all of a deal's open tasks; it wins over the move box. */
export const COMPLETE_TASKS = "complete_tasks";

/** The live statuses, plus the project's own status when it has been archived since (marked, so it can stay as it is). */
export async function statusChoices(db: Db, current?: string): Promise<{ key: string; label: string }[]> {
  const live = await projectStatusRows(db);
  if (current === undefined || live.some((s) => s.key === current)) return live;
  const own = (await projectStatusRows(db, { includeArchived: true })).find((s) => s.key === current);
  return own === undefined ? live : [...live, { key: own.key, label: `${own.label} (archived)` }];
}

export function projectSpecs(
  statuses: { key: string; label: string }[],
  options: { nameHint?: string; defs?: FieldDefRow[] } = {},
): Spec[] {
  return [
    line("name", "Name", "text", "deal", {
      column: "name",
      required: true,
      requiredMessage: "Name the project in a few words.",
      ...(options.nameHint === undefined ? {} : { hint: options.nameHint }),
    }),
    line("status", "Status", "choice", "deal", { column: "status_key", options: statuses.map((s) => ({ value: s.key, label: s.label })) }),
    line("start", "Start", "when", "deal", { column: "start_at", prop: "startAt", hint: "The time is optional." }),
    line("target", "Target", "when", "deal", { column: "target_at", prop: "targetAt", hint: "The time is optional." }),
    line("notes", "Notes", "textarea", "deal"),
    ...projectFieldSpecs(options.defs ?? []),
  ];
}
