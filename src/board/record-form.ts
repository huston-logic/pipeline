// The fields of the board's record forms (new lead, new deal, edit contact, edit deal; decision 0018): which fields
// each form has, how a stored value is shown, how a posted value is read, and, for an edit, which fields the owner
// actually changed. Custom fields come from field_defs, one input per active field, by its type.
import type { FieldDefRow, FieldEntity } from "../db/db.ts";
import { parseObject, parseStringArray } from "../services/lookup.ts";
import { untrustedFields } from "../services/labels.ts";
import { localWhen, parseWhen } from "../time.ts";
import { compareField, type FieldKind, fingerprint, normalize } from "./edit-state.ts";
import type { FieldKindName } from "./inputs.ts";
import { WAS_PREFIX } from "./inputs.ts";

export type Spec = {
  /** The form name, also the key of the field's fingerprint (`was.<name>`). */
  name: string;
  label: string;
  kind: FieldKindName;
  group: "contact" | "deal";
  required?: boolean;
  requiredMessage?: string;
  hint?: string;
  choices?: string[];
  /** Fixed options with their own labels (the activity type). */
  options?: { value: string; label: string }[];
  maxlength: number;
  /** A number that must be 0 or more (a deal's value). */
  min0?: boolean;
  /** Where the stored value is: a column of the row, or a custom field's key. */
  column?: string;
  custom?: string;
  /** The service input's property; custom fields go in `bag` under their key. */
  prop: string;
  bag?: "fields" | "contactFields";
  /** The row's untrusted_fields entry for this value. */
  outsideKey: string;
};

/** A field as the form draws it. */
export type Shown = { value: string; was?: string; outside: boolean; error?: string };

export type FormError = { name?: string; message: string };

export type Parsed = { ok: true; value: string | number | null } | { ok: false; message: string };

export type Collected = { input: Record<string, unknown>; errors: FormError[]; shown: Map<string, Shown>; conflicts: string[] };

const LINE_MAX = 500;
const TEXT_MAX = 10_000;
const KINDS: Record<FieldDefRow["type"], FieldKindName> = { text: "text", number: "number", date: "date", choice: "choice" };

function customSpecs(defs: FieldDefRow[], entity: FieldEntity, bag: "fields" | "contactFields"): Spec[] {
  return defs
    .filter((def) => def.entity === entity && def.archived === 0)
    .map((def) => ({
      name: `${entity === "contact" ? "cf" : "df"}.${def.key}`,
      label: def.label,
      kind: KINDS[def.type],
      group: entity,
      choices: def.type === "choice" && def.choices !== null ? parseStringArray(def.choices) : undefined,
      maxlength: LINE_MAX,
      custom: def.key,
      prop: def.key,
      bag,
      outsideKey: `fields.${def.key}`,
    }));
}

/** A field stored in a column of the same name (or none), sent as the service property of that name. */
export const line = (name: string, label: string, kind: FieldKindName, group: Spec["group"], extra: Partial<Spec> = {}): Spec => ({
  name,
  label,
  kind,
  group,
  maxlength: kind === "textarea" ? TEXT_MAX : LINE_MAX,
  column: name,
  prop: name,
  outsideKey: name,
  ...extra,
});

/** A contact's details and custom contact fields; `notes` is the contact's own notes (left off a new lead). */
export function contactSpecs(defs: FieldDefRow[], options: { notes?: boolean; bag?: "fields" | "contactFields" } = {}): Spec[] {
  const { notes = true, bag = "fields" } = options;
  return [
    line("name", "Name", "text", "contact", { required: true, requiredMessage: "Give the person's name." }),
    line("email", "Email", "email", "contact"),
    line("phone", "Phone", "tel", "contact"),
    line("business", "Company", "text", "contact"),
    line("source", "Source", "text", "contact", { hint: "Where they came from, for example a referral." }),
    ...(notes ? [line("notes", "Notes", "textarea", "contact")] : []),
    ...customSpecs(defs, "contact", bag),
  ];
}

/** A deal's title, value, next step and date, custom deal fields, and for a new deal a note to log on it. */
export function dealSpecs(defs: FieldDefRow[], options: { titleRequired: boolean; notes: boolean; titleProp?: string }): Spec[] {
  const title = options.titleRequired
    ? { required: true, requiredMessage: "Give the deal a title." }
    : { hint: "Leave blank to name it after the person." };
  return [
    line("title", "Deal title", "text", "deal", { prop: options.titleProp ?? "title", ...title }),
    line("value", "Value", "number", "deal", { min0: true, hint: "A number, for example 1500." }),
    line("next_step", "Next step", "text", "deal", { prop: "nextStep", hint: "For example, send the quote." }),
    line("next_at", "Next date", "when", "deal", { prop: "nextAt", hint: "The time is optional." }),
    ...(options.notes
      ? [line("notes", "Notes", "textarea", "deal", { column: undefined, hint: "Saved as a note on the deal." })]
      : []),
    ...customSpecs(defs, "deal", "fields"),
  ];
}

/** The new-lead form: the person, then their first deal. */
export function leadSpecs(defs: FieldDefRow[]): Spec[] {
  return [
    ...contactSpecs(defs, { notes: false, bag: "contactFields" }),
    ...dealSpecs(defs, { titleRequired: false, notes: true, titleProp: "dealTitle" }),
  ];
}

const kindOf = (spec: Spec): FieldKind => (spec.kind === "textarea" ? "text" : "line");

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
}

type StoredRow = Record<string, unknown> & { fields: string; untrusted_fields: string };

/** Each field's stored value as the form shows it: the next date in the owner's time, numbers as written. */
export function shownOf(specs: Spec[], row: StoredRow, tz: string): Map<string, string> {
  const fields = parseObject(row.fields);
  return new Map(
    specs.map((spec) => {
      if (spec.custom !== undefined) return [spec.name, asText(fields[spec.custom])];
      const value = spec.column === undefined ? null : row[spec.column];
      if (spec.kind === "when") return [spec.name, typeof value === "string" ? localWhen(value, tz) : ""];
      return [spec.name, asText(value)];
    }),
  );
}

/**
 * What a browser sends back for this field when the owner leaves it alone. A date input can't hold a value that isn't a
 * date (an import's "next spring"), so it sends ""; the fingerprint is of that, so leaving it alone is not a change.
 * (Selects always hold the stored value: an unknown one is added as an option.)
 */
function untouchedValue(spec: Spec, stored: string): string {
  if (spec.kind === "date") return realDate(stored) ? stored : "";
  if (spec.kind === "when") return stored === "" || realDate(stored.slice(0, 10)) ? stored : "";
  return stored;
}

/** Both values, read the way the service would store them, are the same ("1,500" and "1500"). */
function sameStored(spec: Spec, posted: string, stored: string): boolean {
  const a = parseValue(spec, posted);
  const b = parseValue({ ...spec, required: false }, stored);
  return a.ok && b.ok && a.value === b.value;
}

/** An edit form as first drawn: stored values, their fingerprints, and which came from outside. */
export async function editShown(specs: Spec[], row: StoredRow, tz: string): Promise<Map<string, Shown>> {
  const values = shownOf(specs, row, tz);
  const outside = untrustedFields(row);
  const shown = new Map<string, Shown>();
  for (const spec of specs) {
    const value = values.get(spec.name) ?? "";
    shown.set(spec.name, { value, was: await fingerprint(untouchedValue(spec, value), kindOf(spec)), outside: outside.has(spec.outsideKey) });
  }
  return shown;
}

/** The posted value, or null when the form didn't send the field. A "when" field joins its date and time. */
export function postedValue(form: URLSearchParams, spec: Spec): string | null {
  if (spec.kind !== "when") return form.get(spec.name);
  const date = form.get(`${spec.name}.date`);
  const time = form.get(`${spec.name}.time`);
  if (date === null && time === null) return null;
  const t = (time ?? "").trim();
  return t === "" ? (date ?? "").trim() : `${(date ?? "").trim()}T${t}`;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NUMBER = /^-?\d+(?:\.\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function realDate(text: string): boolean {
  if (!DATE.test(text)) return false;
  const [y, m, d] = text.split("-").map(Number);
  const at = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
  return at.getUTCFullYear() === y && at.getUTCMonth() === (m ?? 1) - 1 && at.getUTCDate() === d;
}

const fail = (message: string): Parsed => ({ ok: false, message });

/** A posted value as the service takes it; "" is null (not set, or cleared). */
export function parseValue(spec: Spec, posted: string): Parsed {
  const text = normalize(posted, kindOf(spec));
  if (text === "") return spec.required ? fail(spec.requiredMessage ?? `Give the ${spec.label.toLowerCase()}.`) : { ok: true, value: null };
  if (text.length > spec.maxlength) return fail(`Keep this to ${spec.maxlength.toLocaleString("en-US")} characters or fewer.`);
  switch (spec.kind) {
    case "email":
      return EMAIL.test(text) ? { ok: true, value: text } : fail("Give an email address like name@example.com.");
    case "number": {
      const plain = text.replace(/[,\s]/g, "");
      const n = Number(plain);
      if (spec.min0) {
        return NUMBER.test(plain) && n >= 0 ? { ok: true, value: n } : fail("Give a number of 0 or more.");
      }
      return NUMBER.test(plain) && Number.isFinite(n) ? { ok: true, value: n } : fail("Give a number, for example 1500.");
    }
    case "date":
      return realDate(text) ? { ok: true, value: text } : fail("Give a real date.");
    case "when": {
      if (text.startsWith("T")) return fail("Give a date for this time, or clear the time.");
      if (!realDate(text.slice(0, 10))) return fail("Give a real date.");
      try {
        parseWhen(text, "UTC");
      } catch {
        return fail("Give a real date and time.");
      }
      return { ok: true, value: text };
    }
    case "choice":
      return (spec.options?.map((option) => option.value) ?? spec.choices ?? []).includes(text) ? { ok: true, value: text } : fail("Choose one of the options.");
    default:
      return { ok: true, value: text };
  }
}

function put(input: Record<string, unknown>, spec: Spec, value: string | number | null): void {
  if (spec.bag === undefined) {
    input[spec.prop] = value;
    return;
  }
  const bag = (input[spec.bag] ??= {}) as Record<string, unknown>;
  bag[spec.prop] = value;
}

/** A new record's input: every field that was filled in, or the errors. */
export function collectNew(specs: Spec[], form: URLSearchParams): Collected {
  const input: Record<string, unknown> = {};
  const errors: FormError[] = [];
  const shown = new Map<string, Shown>();
  for (const spec of specs) {
    const posted = postedValue(form, spec) ?? "";
    const parsed = parseValue(spec, posted);
    const item: Shown = { value: posted, outside: false };
    if (!parsed.ok) {
      item.error = parsed.message;
      errors.push({ name: spec.name, message: parsed.message });
    } else if (parsed.value !== null) {
      put(input, spec, parsed.value);
    }
    shown.set(spec.name, item);
  }
  return { input, errors, shown, conflicts: [] };
}

/**
 * An edit's patch: only the fields the owner changed (null clears one). A field the owner left alone is never
 * written, so its stored value, and whether it came from outside, stay as they are. A field both the owner and another
 * writer changed is a conflict: nothing is saved, and the form is drawn again with the stored value.
 */
export async function collectEdit(specs: Spec[], form: URLSearchParams, row: StoredRow, tz: string): Promise<Collected> {
  const current = shownOf(specs, row, tz);
  const outside = untrustedFields(row);
  const input: Record<string, unknown> = {};
  const errors: FormError[] = [];
  const conflicts: string[] = [];
  const shown = new Map<string, Shown>();
  for (const spec of specs) {
    const stored = current.get(spec.name) ?? "";
    const untouched = untouchedValue(spec, stored);
    const posted = postedValue(form, spec);
    const was = form.get(`${WAS_PREFIX}${spec.name}`);
    const compared = await compareField(posted, was, untouched, kindOf(spec));
    // A change is a new fingerprint AND a different value once read the way the service stores it.
    const outcome = compared !== "unchanged" && posted !== null && sameStored(spec, posted, stored) ? "unchanged" : compared;
    const keep: Shown = { value: stored, was: await fingerprint(untouched, kindOf(spec)), outside: outside.has(spec.outsideKey) };
    if (outcome === "unchanged" || posted === null) {
      shown.set(spec.name, keep);
      continue;
    }
    if (outcome === "conflict") {
      const message = `${spec.label} was changed while you were editing. The form now shows the saved value; change it again if you need to.`;
      conflicts.push(spec.name);
      errors.push({ name: spec.name, message });
      shown.set(spec.name, { ...keep, error: message });
      continue;
    }
    const parsed = parseValue(spec, posted);
    const item: Shown = { value: posted, was: was ?? keep.was, outside: false };
    if (parsed.ok) {
      put(input, spec, parsed.value);
    } else {
      item.error = parsed.message;
      errors.push({ name: spec.name, message: parsed.message });
    }
    shown.set(spec.name, item);
  }
  return { input, errors, shown, conflicts };
}
