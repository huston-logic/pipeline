// The fields of the template forms (decision 0024, run 10 area 4) as record-form specs (decision 0018): New template,
// the template's own name and description, a task's title, days after the start and work type.
import { line, type Spec } from "./record-form.ts";

export const TEMPLATES_PATH = "/templates";
export const TEMPLATE_PREFIX = "template";
export const TASK_PREFIX = "template-task";
export const templateHref = (id: string): string => `/templates/${encodeURIComponent(id)}`;
export const templateTaskEditPath = (templateId: string, taskId: string): string => `${templateHref(templateId)}/tasks/${encodeURIComponent(taskId)}/edit`;
/** The posts that name one template task. */
export const templateTaskPost = (taskId: string, what = ""): string => `/template-tasks/${encodeURIComponent(taskId)}${what}`;

export const templateSpecs = (): Spec[] => [
  line("name", "Name", "text", "project", { column: "name", required: true, requiredMessage: "Name the template in a few words." }),
  line("description", "Description", "textarea", "project", { column: "description" }),
];

/** The task fields; the work type only while time tracking is on (`workTypes` is null when it is off). */
export function templateTaskSpecs(workTypes: { id: string; name: string }[] | null): Spec[] {
  return [
    line("title", "Task", "text", "project", { column: "title", required: true, requiredMessage: "Say in a few words what to do." }),
    line("dueDays", "Days after start", "number", "project", { column: "due_days", prop: "dueDays", min0: true, hint: "Optional. 0 is the start day." }),
    ...(workTypes === null
      ? []
      : [
          line("workType", "Work type", "choice", "project", {
            column: "work_type_id",
            prop: "workType",
            blank: "No work type",
            groups: [{ label: "", options: workTypes.map((type) => ({ value: type.id, label: type.name })) }],
          }),
        ]),
  ];
}
