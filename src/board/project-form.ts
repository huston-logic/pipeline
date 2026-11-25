// The fields of the project forms, New project and Edit project (decision 0055), as record-form specs (decision 0018): the
// same specs draw the form and read the post. Dates are a date plus an optional time, read in the owner's timezone.
import { line, type Spec } from "./record-form.ts";

export const PROJECT_PREFIX = "project";
export const newProjectOfContactPath = (contactId: string): string => `/contacts/${encodeURIComponent(contactId)}/projects/new`;
export const newProjectOfDealPath = (dealId: string): string => `/deals/${encodeURIComponent(dealId)}/projects/new`;
export const addProjectOfContactPath = (contactId: string): string => `/contacts/${encodeURIComponent(contactId)}/projects`;
export const addProjectOfDealPath = (dealId: string): string => `/deals/${encodeURIComponent(dealId)}/projects`;
export const projectSavePath = (id: string): string => `/projects/${encodeURIComponent(id)}`;

/** The tick box that moves a deal's open tasks onto the new project. */
export const MOVE_TASKS = "move_tasks";

export function projectSpecs(statuses: { key: string; label: string }[], options: { nameHint?: string } = {}): Spec[] {
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
  ];
}
