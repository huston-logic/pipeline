// Task forms (decision 0018): Done and Snooze on every task card (Today, the deal page, the contact page), and Add a
// task on the deal and contact pages. Plain forms that work without JavaScript; a task's name in a control's hidden
// words is its title, or its id when the title came from outside.
import { isTrusted } from "../services/labels.ts";
import { type FormContext, postForm } from "./forms.ts";
import { type Html, html } from "./html.ts";
import { field } from "./inputs.ts";
import { contactHref, dealHref, projectHref } from "./parts.ts";
import { line, type Shown, type Spec } from "./record-form.ts";
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
  )}
<p class="field-hint">${SNOOZE_HINT}</p>
${postForm(
  "snooze-until",
  snoozeAction(task.id),
  form,
  html`${field({ id, name: "until", label: "Or until", kind: "when", value: state.until ?? "", hint: "The time is optional: 9:00 AM if blank.", error: state.error })}
<button class="button button-small" type="submit">Snooze${hiddenName(name)}</button>`,
  { novalidate: true },
)}`;
}

/** Done (one tap) and a Snooze disclosure, at the foot of a task card. */
export function taskActions(task: TaskRef, form: FormContext): Html {
  const name = taskName(task);
  return html`<div class="task-actions">
${postForm(
  "task-done",
  completeAction(task.id),
  form,
  html`<button class="button button-quiet button-small" type="submit">Done${hiddenName(name)}</button>`,
)}
${startTimerForm({ kind: "task", id: task.id }, form, name)}
<details class="task-snooze">
<summary>Snooze${hiddenName(name)}</summary>
${snoozeForms(task, form)}
</details>
</div>`;
}

export type Subject = { kind: "deal" | "contact" | "project"; id: string };

export const subjectHref = (subject: Subject): string =>
  subject.kind === "deal" ? dealHref(subject.id) : subject.kind === "project" ? projectHref(subject.id) : contactHref(subject.id);
export const addTaskAction = (subject: Subject): string => `${subjectHref(subject)}/tasks`;

export const taskSpecs = (): Spec[] => [
  line("title", "What to do", "text", "deal", { required: true, requiredMessage: "Say in a few words what to do." }),
  line("due", "Due", "when", "deal", { prop: "dueAt", hint: "Optional. The time is optional too." }),
];

/** Add a task, closed under a disclosure on a record page, or open on its own when a post was refused. */
export function addTaskForm(subject: Subject, form: FormContext, state?: FormState): Html {
  const prefix = `task-${subject.id}`;
  const specs = taskSpecs();
  const inner = postForm(
    "inline-form",
    addTaskAction(subject),
    form,
    html`${specFields(specs, state?.shown ?? new Map(), prefix)}
<button class="button button-small" type="submit">Add the task</button>`,
    { novalidate: true },
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
  line("title", "Add a to-do", "text", "deal", { required: true, requiredMessage: "Say in a few words what to do." }),
  line("due", "Due (optional)", "date", "deal", { prop: "dueAt" }),
];

/** The form at the top of Today, or drawn again with what was posted and the errors when a post was refused. */
export function quickAddForm(form: FormContext, state?: FormState): Html {
  const shown = state?.shown ?? new Map<string, Shown>();
  const inner = html`${specFields(quickSpecs(), shown, QUICK_PREFIX)}<button class="button" type="submit">Add to-do</button>`;
  return postForm("quick-add", QUICK_ADD_ACTION, form, inner, { novalidate: true });
}

/** A refused quick add: the error summary, then the form again inside a card. */
export function refusedQuickAdd(form: FormContext, state: FormState): Html {
  return html`${formErrorSummary(state.errors, quickSpecs(), QUICK_PREFIX)}<div class="card refused-form">${quickAddForm(form, state)}</div>`;
}

export const addTaskFieldId = (subject: Subject): string => fieldId(`task-${subject.id}`, "title");
