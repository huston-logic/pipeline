// The Log form on the deal and contact pages (log_activity, decision 0018): a type, what happened, and when (blank is
// now). Task R5 posts to the same route for one-tap logging after a call or a text.
import type { FormContext } from "./forms.ts";
import { postForm } from "./forms.ts";
import { type Html, html } from "./html.ts";
import { line, type Spec } from "./record-form.ts";
import { formErrorSummary, specFields } from "./record-fields.ts";
import type { FormState } from "./pages/record-page.ts";
import { type Subject, subjectHref } from "./task-forms.ts";

export const LOG_TYPES = [
  { value: "note", label: "Note" },
  { value: "call", label: "Call" },
  { value: "email", label: "Email" },
  { value: "meeting", label: "Meeting" },
] as const;

export const logAction = (subject: Subject): string => `${subjectHref(subject)}/log`;

export const logSpecs = (): Spec[] => [
  line("type", "Type", "choice", "deal", { options: LOG_TYPES.map((type) => ({ ...type })) }),
  line("summary", "What happened", "textarea", "deal", { required: true, requiredMessage: "Say in a few words what happened." }),
  line("when", "When", "when", "deal", { prop: "occurredAt", hint: "Leave both blank for now." }),
];

export function logForm(subject: Subject, form: FormContext, state?: FormState): Html {
  const prefix = `log-${subject.id}`;
  const specs = logSpecs();
  const shown = state?.shown ?? new Map([["type", { value: "note", outside: false }]]);
  const inner = postForm(
    "inline-form",
    logAction(subject),
    form,
    html`${specFields(specs, shown, prefix)}
<button class="button button-small" type="submit">Log it</button>`,
    { novalidate: true },
  );
  if (state !== undefined) return html`${formErrorSummary(state.errors, specs, prefix)}<div class="card refused-form">${inner}</div>`;
  return html`<details class="add-details">
<summary>Log a call, email or note</summary>
${inner}
</details>`;
}
