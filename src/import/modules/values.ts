// What the import modules share when they read a row (decisions 0029, 0037): custom field values checked with the
// field rules, dates, deal values and emails read without ever quoting the value in a skip reason, and the keys
// people are matched by.
import type { FieldDefRow, FieldEntity } from "../../db/db.ts";
import { validateFieldValues } from "../../services/fields.ts";
import { parseWhen } from "../../time.ts";
import type { MappedField } from "../engine.ts";

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An email as a match key: trimmed, ignoring case. */
export const emailKey = (email: string): string => email.trim().toLowerCase();

/** A name as a match key: trimmed, inner spaces collapsed, ignoring case (like businessKey). */
export const nameKey = (name: string | null): string => (name ?? "").trim().replace(/\s+/g, " ").toLowerCase();

function fieldProblem(def: FieldDefRow): string {
  switch (def.type) {
    case "number":
      return "needs a number";
    case "date":
      return "needs a date like 2026-11-19";
    case "choice":
      return `needs one of: ${(JSON.parse(def.choices ?? "[]") as string[]).join(", ")}`;
    case "text":
      return "is too long";
  }
}

const NUMBER = /^-?\d+(\.\d+)?$/;

export type FieldInput = { def: FieldDefRow; text: string };

/** The live field of `entity` a mapped column fills; the mapping was checked, so anything else is a bug. */
export function fieldInputs(fields: readonly MappedField[], fieldDefs: readonly FieldDefRow[], entity: FieldEntity): FieldInput[] {
  return fields.map(({ key, text }) => {
    const def = fieldDefs.find((candidate) => candidate.entity === entity && candidate.archived === 0 && candidate.key === key);
    if (!def) throw new Error(`The import maps a column to the field "${key}", which isn't a ${entity} field.`);
    return { def, text };
  });
}

/**
 * The values to store, by field key (a number field's digits as a number), or the first problem: named by the
 * field's label (the owner's), never by the file's header or value.
 */
export function checkedFields(list: readonly FieldInput[], entity: FieldEntity): { fields: Record<string, string | number>; problem: string | null } {
  const out: Record<string, string | number> = {};
  for (const { def, text } of list) {
    const value = def.type === "number" && NUMBER.test(text) ? Number(text) : text;
    try {
      validateFieldValues([def], entity, { [def.key]: value });
    } catch {
      return { fields: out, problem: `the "${def.label}" field ${fieldProblem(def)}` };
    }
    out[def.key] = value;
  }
  return { fields: out, problem: null };
}

/** The stored JSON object of custom field values; anything else reads as none. */
export function storedFields(json: string | undefined): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json ?? "{}");
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const isEmptyValue = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "");

/** A time from the file as a UTC ISO string, read like every date input (in the owner's timezone); null when unreadable. */
export function readWhen(text: string, tz: string): string | null {
  try {
    return parseWhen(text, tz).toISOString();
  } catch {
    return null;
  }
}

const AMOUNT = /^[$€£]?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?$/;

/** A deal value: digits with an optional currency sign, thousands commas and decimals; null when it isn't one. */
export function readAmount(text: string): number | null {
  const match = AMOUNT.exec(text.trim());
  if (!match) return null;
  const value = Number(`${(match[1] ?? "").replaceAll(",", "")}${match[2] ?? ""}`);
  return Number.isFinite(value) ? value : null;
}

/** "contact ct_a, ct_b and 2 more": the ids a skip reason may name, never more than three. */
export function idList(noun: string, ids: readonly string[]): string {
  const shown = ids.slice(0, 3);
  const more = ids.length - shown.length;
  return `${noun} ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}
