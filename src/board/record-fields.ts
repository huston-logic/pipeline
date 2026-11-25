// Drawing a record form's fields from their specs (decision 0018), and turning the form's errors into an error summary
// whose links reach each field.
import { type Html, html } from "./html.ts";
import { errorSummary, field, type FieldError } from "./inputs.ts";
import type { FormError, Shown, Spec } from "./record-form.ts";

/** "lead" and "cf.role" become "lead-cf-role": an id that is safe in markup and in a fragment link. */
export const fieldId = (prefix: string, name: string): string => `${prefix}-${name.replace(/[^A-Za-z0-9_-]/g, "-")}`;

/** Where an error link takes focus: the date of a date and time pair, else the control itself. */
const focusId = (prefix: string, spec: Spec | undefined, name: string) =>
  spec?.kind === "when" ? `${fieldId(prefix, name)}-date` : fieldId(prefix, name);

export function specField(spec: Spec, shown: Shown | undefined, prefix: string): Html {
  return field({
    id: fieldId(prefix, spec.name),
    name: spec.name,
    label: spec.label,
    kind: spec.kind,
    value: shown?.value ?? "",
    required: spec.required,
    hint: spec.hint,
    error: shown?.error,
    outside: shown?.outside,
    was: shown?.was,
    choices: spec.choices,
    options: spec.options,
    groups: spec.groups,
    blank: spec.blank,
    maxlength: spec.maxlength,
  });
}

export const specFields = (specs: Spec[], shown: Map<string, Shown>, prefix: string): Html =>
  html`${specs.map((spec) => specField(spec, shown.get(spec.name), prefix))}`;

export function formErrorSummary(errors: FormError[], specs: Spec[], prefix: string): Html | "" {
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const items: FieldError[] = errors.map((error) =>
    error.name === undefined ? { message: error.message } : { id: focusId(prefix, byName.get(error.name), error.name), message: error.message },
  );
  return errorSummary(items);
}

/** Did any field show a value that came from outside? */
export const anyOutside = (shown: Map<string, Shown>): boolean => [...shown.values()].some((item) => item.outside);
