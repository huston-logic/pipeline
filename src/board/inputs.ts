// Form fields for the board's record forms (docs/STYLE-GUIDE.md §7.20, decision 0018): a visible label, "(required)"
// in words, an optional hint, a per-field error tied in with aria-describedby and aria-invalid, and the "From outside"
// label beside the label when the value shown came from outside. Values are escaped by `html` like everything else.
import { type Html, html } from "./html.ts";
import { hidden } from "./forms.ts";
import { count, OUTSIDE_LABEL } from "./parts.ts";

export type FieldKindName = "text" | "email" | "tel" | "number" | "textarea" | "date" | "choice" | "when";

export type FieldProps = {
  id: string;
  /** The form name; a "when" field posts `<name>.date` and `<name>.time`. */
  name: string;
  label: string;
  kind: FieldKindName;
  /** As the form shows it. A "when" value is "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm", or "". */
  value: string;
  required?: boolean;
  hint?: string;
  error?: string;
  /** The value shown came from outside (a website form or an import). */
  outside?: boolean;
  /** The fingerprint of the value the form was drawn with (edit forms only). */
  was?: string;
  choices?: string[];
  /** A choice of fixed options with their own labels, and no blank option (the activity type). */
  options?: { value: string; label: string }[];
  /** A choice of options in labelled groups, after a blank option called None (a sub-status under its status). */
  groups?: OptionGroup[];
  maxlength?: number;
};

export type FieldError = { id?: string; message: string };

export type OptionGroup = { label: string; options: { value: string; label: string }[] };

export const WAS_PREFIX = "was.";

const describedBy = (ids: string[]): Html | "" =>
  ids.length === 0 ? "" : html` aria-describedby="${ids.join(" ")}"`;

/** The From outside label, with an id so the control's aria-describedby reads it with the control. */
const outsideOf = (props: FieldProps): Html | "" =>
  props.outside ? html` <span class="outside" id="${props.id}-outside">${OUTSIDE_LABEL}</span>` : "";

function labelFor(props: FieldProps): Html {
  const required = props.required ? html` <span class="field-required">(required)</span>` : "";
  return html`<label for="${props.id}">${props.label}${required}</label>${outsideOf(props)}`;
}

const hintOf = (props: FieldProps) =>
  props.hint === undefined ? "" : html`<p class="field-hint" id="${props.id}-hint">${props.hint}</p>`;

const errorOf = (props: FieldProps) =>
  props.error === undefined
    ? ""
    : html`<p class="field-error" id="${props.id}-error"><span class="visually-hidden">Error: </span>${props.error}</p>`;

function described(props: FieldProps): string[] {
  return [
    props.outside ? `${props.id}-outside` : null,
    props.hint === undefined ? null : `${props.id}-hint`,
    props.error === undefined ? null : `${props.id}-error`,
  ].filter(
    (id): id is string => id !== null,
  );
}

function control(props: FieldProps): Html {
  const aria = html`${describedBy(described(props))}${props.error === undefined ? "" : html` aria-invalid="true"`}`;
  const required = props.required ? html` required` : "";
  const max = props.maxlength === undefined ? "" : html` maxlength="${props.maxlength}"`;
  switch (props.kind) {
    case "textarea":
      return html`<textarea id="${props.id}" name="${props.name}" rows="4"${required}${max}${aria}>${props.value}</textarea>`;
    case "choice": {
      if (props.groups !== undefined) {
        const option = (o: { value: string; label: string }) => html`<option value="${o.value}"${o.value === props.value ? " selected" : ""}>${o.label}</option>\n`;
        return html`<select id="${props.id}" name="${props.name}"${required}${aria}>
<option value=""${props.value === "" ? " selected" : ""}>None</option>
${props.groups.map((group) => html`<optgroup label="${group.label}">\n${group.options.map(option)}</optgroup>\n`)}</select>`;
      }
      if (props.options !== undefined) {
        return html`<select id="${props.id}" name="${props.name}"${required}${aria}>
${props.options.map((option) => html`<option value="${option.value}"${option.value === props.value ? " selected" : ""}>${option.label}</option>\n`)}</select>`;
      }
      const choices = props.choices ?? [];
      const extra = props.value !== "" && !choices.includes(props.value) ? [props.value] : [];
      return html`<select id="${props.id}" name="${props.name}"${required}${aria}>
<option value="">Not set</option>
${[...choices, ...extra].map((choice) => html`<option value="${choice}"${choice === props.value ? " selected" : ""}>${choice}</option>`)}
</select>`;
    }
    case "date":
      return html`<input id="${props.id}" name="${props.name}" type="date" value="${props.value}"${required}${aria}>`;
    default: {
      const type = props.kind === "number" || props.kind === "when" ? "text" : props.kind;
      const keypad = props.kind === "number" ? html` inputmode="decimal"` : "";
      return html`<input id="${props.id}" name="${props.name}" type="${type}" value="${props.value}" autocomplete="off"${keypad}${required}${max}${aria}>`;
    }
  }
}

const wasField = (props: FieldProps) => (props.was === undefined ? "" : hidden(`${WAS_PREFIX}${props.name}`, props.was));

/** A date and an optional time, in the owner's timezone, as one group. */
function whenField(props: FieldProps): Html {
  const [date = "", time = ""] = props.value.split("T");
  const aria = html`${describedBy(described(props))}${props.error === undefined ? "" : html` aria-invalid="true"`}`;
  const required = props.required ? html` required` : "";
  return html`<fieldset class="field field-when${props.error === undefined ? "" : " field-invalid"}">
<legend>${props.label}${props.required ? html` <span class="field-required">(required)</span>` : ""}${outsideOf(props)}</legend>
${hintOf(props)}${errorOf(props)}<div class="when-row">
<div class="when-part">
<label for="${props.id}-date">Date</label>
<input id="${props.id}-date" name="${props.name}.date" type="date" value="${date}"${required}${aria}>
</div>
<div class="when-part">
<label for="${props.id}-time">Time</label>
<input id="${props.id}-time" name="${props.name}.time" type="time" value="${time}"${aria}>
</div>
</div>
${wasField(props)}</fieldset>`;
}

export function field(props: FieldProps): Html {
  if (props.kind === "when") return whenField(props);
  return html`<div class="field${props.error === undefined ? "" : " field-invalid"}">
${labelFor(props)}
${hintOf(props)}${errorOf(props)}${control(props)}
${wasField(props)}</div>`;
}

/** One checkbox that posts `value` when ticked and nothing when not, with its label beside it (the label is the tap
 * area too). */
export function checkbox(props: { id: string; name: string; label: string; value: string; checked: boolean; hint?: string }): Html {
  const described = props.hint === undefined ? "" : html` aria-describedby="${props.id}-hint"`;
  return html`<div class="check">
<input id="${props.id}" name="${props.name}" type="checkbox" value="${props.value}"${props.checked ? " checked" : ""}${described}>
<label for="${props.id}">${props.label}</label>
</div>${props.hint === undefined ? "" : html`
<p class="field-hint check-hint" id="${props.id}-hint">${props.hint}</p>`}`;
}

/** At the top of a refused form: every problem, each linked to its field when it has one. */
export function errorSummary(errors: FieldError[]): Html | "" {
  if (errors.length === 0) return "";
  return html`<div class="error-summary" role="alert" aria-labelledby="error-summary-heading" tabindex="-1" autofocus>
<h2 id="error-summary-heading">${count(errors.length, "thing to fix", "things to fix")}</h2>
<ul>${errors.map((error) => html`<li>${error.id === undefined ? error.message : html`<a href="#${error.id}">${error.message}</a>`}</li>`)}</ul>
</div>`;
}
