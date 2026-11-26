// Task forms (decision 0018): Done and Snooze on every task card (Today, the deal page, the contact page), and Add a
// task on the deal and contact pages. Plain forms that work without JavaScript; a task's name in a control's hidden
// words is its title, or its id when the title came from outside.
import { isTrusted } from "../services/labels.ts";
import { type FormContext, postForm } from "./forms.ts";
import { type Html, html } from "./html.ts";
import { field } from "./inputs.ts";
import { linkify } from "./links.ts";
import { contactHref, dealHref, outsideLabel, projectHref } from "./parts.ts";
import { editShown, line, type Shown, type Spec } from "./record-form.ts";
import { fieldId, formErrorSummary, specFields } from "./record-fields.ts";
import type { FormState } from "./pages/record-page.ts";
import { startTimerForm } from "./timer-start.ts";

export type TaskRef = { id: string; title: string; untrusted_fields: readonly string[] | string };

/** What the task's controls are called: its title, or "task tk_…" when the title came from outside. */
export function taskName(task: TaskRef): string {
  const fields = typeof task.untrusted_fields === "string" ? task.untrusted_fields : JSON.stringify(task.untrusted_fields);
  return isTrusted({ untrusted_fields: fields }, "title") ? task.title : `task ${task.id}`;
}

const taskPath = (id: string) => `/tasks/${encodeURIComponent(id)}`;
export const completeAction = (id: string): string => `${taskPath(id)}/complete`;
export const snoozeAction = (id: string): string => `${taskPath(id)}/snooze`;

const hiddenName = (name: string) => html`<span class="visually-hidden">: ${name}</span>`;

export const SNOOZE_HINT = "Tomorrow morning is 9:00 AM tomorrow. Next week is Monday at 9:00 AM.";

/** The presets in one form, and a date and time in another, so Enter in the date field never picks a preset. */
export function snoozeForms(task: TaskRef, form: FormContext, state: { until?: string; error?: string } = {}): Html {
  const name = taskName(task);
  const id = `snooze-${task.id}`;
  return html`${postForm(
    "snooze-presets",
    snoozeAction(task.id),
    form,
    html`<button class="button button-quiet button-small" type="submit" name="preset" value="tomorrow">Tomorrow morning${hiddenName(name)}</button>
<button class="button button-quiet button-small" type="submit" name="preset" value="next_week">Next week${hiddenName(name)}</button>`,
    { live: {} },
  )}
<p class="field-hint">${SNOOZE_HINT}</p>
${postForm(
  "snooze-until",
  snoozeAction(task.id),
  form,
  html`${field({ id, name: "until", label: "Or until", kind: "when", value: state.until ?? "", hint: "The time is optional: 9:00 AM if blank.", error: state.error })}
<button class="button button-small" type="submit">Snooze${hiddenName(name)}</button>`,
  { novalidate: true, live: {} },
)}`;
}

export type EditableTask = TaskRef & { dueAt: string | null; description: string | null };

const TITLE_REQUIRED = "Give the task a title.";
const titleSpec = (): Spec => line("title", "Title", "text", "deal", { required: true, requiredMessage: TITLE_REQUIRED });
const dueSpec = (): Spec => line("due", "Due", "when", "deal", { column: "due_at", prop: "dueAt", hint: "Optional. The time is optional too." });
const descriptionSpec = (): Spec => line("description", "Description", "textarea", "deal");

/** The fields of the task edit form: the same three as Add task. */
export const taskEditSpecs = (): Spec[] => [titleSpec(), dueSpec(), descriptionSpec()];

export const editAction = (id: string): string => `${taskPath(id)}/edit`;

const outsideKeys = (fields: readonly string[] | string): string => (typeof fields === "string" ? fields : JSON.stringify(fields));

/** A task's description as a paragraph: links only in the owner's own text, labelled when it came from outside. */
export function descriptionLine(task: { description: string | null; untrusted_fields: readonly string[] | string }): Html | "" {
  if (task.description === null || task.description === "") return "";
  const trusted = isTrusted({ untrusted_fields: outsideKeys(task.untrusted_fields) }, "description");
  return trusted
    ? html`<p class="task-description">${linkify(task.description, true)}</p>`
    : html`<p class="task-description">${outsideLabel()} ${linkify(task.description, false)}</p>`;
}

/** Edit, closed under a disclosure on a task card, or open in a card when a post was refused (values kept). */
export async function taskEditForm(task: EditableTask, form: FormContext, tz: string, state?: FormState): Promise<Html> {
  const specs = taskEditSpecs();
  const prefix = `task-edit-${task.id}`;
  const stored = { title: task.title, due_at: task.dueAt, description: task.description, fields: "{}", untrusted_fields: outsideKeys(task.untrusted_fields) };
  const shown = state?.shown ?? (await editShown(specs, stored, tz));
  const name = taskName(task);
  const inner = postForm(
    "inline-form",
    editAction(task.id),
    form,
    html`${specFields(specs, shown, prefix)}
<button class="button button-small" type="submit">Save${hiddenName(name)}</button>`,
    { novalidate: true, live: {} },
  );
  if (state !== undefined) return html`${formErrorSummary(state.errors, specs, prefix)}<div class="card refused-form">${inner}</div>`;
  return html`<details class="task-edit">
<summary>Edit${hiddenName(name)}</summary>
${inner}
</details>`;
}

/** Done (one tap), Snooze and Edit disclosures, at the foot of a task card. */
export async function taskActions(task: EditableTask, form: FormContext, tz: string): Promise<Html> {
  const name = taskName(task);
  return html`<div class="task-actions">
${postForm(
  "task-done",
  completeAction(task.id),
  form,
  html`<button class="button button-quiet button-small" type="submit">Done${hiddenName(name)}</button>`,
  { live: {} },
)}
${startTimerForm({ kind: "task", id: task.id }, form, name)}
<details class="task-snooze">
<summary>Snooze${hiddenName(name)}</summary>
${snoozeForms(task, form)}
</details>
${await taskEditForm(task, form, tz)}
</div>`;
}

export type Subject = { kind: "deal" | "contact" | "project"; id: string };

export const subjectHref = (subject: Subject): string =>
  subject.kind === "deal" ? dealHref(subject.id) : subject.kind === "project" ? projectHref(subject.id) : contactHref(subject.id);
export const addTaskAction = (subject: Subject): string => `${subjectHref(subject)}/tasks`;

export const taskSpecs = (): Spec[] => taskEditSpecs();

/** Add a task, closed under a disclosure on a record page, or open on its own when a post was refused. */
export function addTaskForm(subject: Subject, form: FormContext, state?: FormState): Html {
  const prefix = `task-${subject.id}`;
  const specs = taskSpecs();
  const inner = postForm(
    "inline-form",
    addTaskAction(subject),
    form,
    html`${specFields(specs, state?.shown ?? new Map(), prefix)}
<button class="button button-small" type="submit">Add task</button>`,
    { novalidate: true, live: {} },
  );
  if (state !== undefined) return html`${formErrorSummary(state.errors, specs, prefix)}<div class="card refused-form">${inner}</div>`;
  return html`<details class="add-details">
<summary>Add a task</summary>
${inner}
</details>`;
}

export const QUICK_ADD_ACTION = "/tasks/quick";
const QUICK_PREFIX = "quick";

/** Quick add on Today (decision 0047): a to-do with no person or deal, and an optional due date. */
export const quickSpecs = (): Spec[] => [
  titleSpec(),
  line("due", "Due", "date", "deal", { prop: "dueAt" }),
];

/** The form at the top of Today, or drawn again with what was posted and the errors when a post was refused. */
export function quickAddForm(form: FormContext, state?: FormState): Html {
  const shown = state?.shown ?? new Map<string, Shown>();
  const inner = html`${specFields(quickSpecs(), shown, QUICK_PREFIX)}<button class="button" type="submit">Add</button>`;
  return postForm("quick-add", QUICK_ADD_ACTION, form, inner, { novalidate: true, live: { after: fieldId(QUICK_PREFIX, "title") } });
}

/** A refused quick add: the error summary, then the form again inside a card. */
export function refusedQuickAdd(form: FormContext, state: FormState): Html {
  return html`${formErrorSummary(state.errors, quickSpecs(), QUICK_PREFIX)}<div class="card refused-form">${quickAddForm(form, state)}</div>`;
}

export const addTaskFieldId = (subject: Subject): string => fieldId(`task-${subject.id}`, "title");
