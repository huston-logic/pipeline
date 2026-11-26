// Checks shared by the write services. Task 4's schemas check shapes; these check meaning, in plain English.
import { parseWhen } from "../time.ts";
import { UserError } from "./errors.ts";
import type { FieldValues } from "./lookup.ts";

/** Trimmed text, or null when empty or not given. */
export function clean(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text === "" ? null : text;
}

export const TASK_DESCRIPTION_MAX = 10_000;

/** A task's description: trimmed, line breaks kept, null when empty; at most 10,000 characters. */
export function taskDescription(value: string | null | undefined): string | null {
  const text = clean(value);
  if (text !== null && [...text].length > TASK_DESCRIPTION_MAX) throw new UserError("A description holds at most 10,000 characters.");
  return text;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function checkEmail(email: string): string {
  if (!EMAIL.test(email)) throw new UserError(`"${email}" doesn't look like an email address. Give one like name@example.com.`);
  return email;
}

export function checkValue(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new UserError(`A deal value must be a number of 0 or more (got ${value}). Leave it out if it isn't known.`);
  }
  return value;
}

/** A when-input as a UTC ISO string, null to clear it. */
export function whenOrNull(value: string | null, tz: string): string | null {
  const text = clean(value);
  return text === null ? null : parseWhen(text, tz).toISOString();
}

export function withoutNulls(fields: FieldValues): FieldValues {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null));
}
