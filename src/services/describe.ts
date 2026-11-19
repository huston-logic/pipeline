// Small pieces of the one-line summaries the owner reads.
import { formatLocal } from "../time.ts";
import type { ChangeTable, Row } from "./change.ts";
import { oneLine } from "./change.ts";

/** One line, at most `max` characters, with "…" when cut. */
export function short(text: string, max = 80): string {
  const line = oneLine(text);
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** "a", "a and b", "a, b and c". */
export function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export const withArticle = (word: string) => `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;

export const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const text = (value: unknown) => short(String(value ?? ""), 60);

/** How a summary names a row: contact Pat Example, deal "Website refresh", the call "Intro call.", ... */
export function rowLabel(table: ChangeTable, row: Row): string {
  switch (table) {
    case "contacts":
      return `contact ${text(row.name)}`;
    case "deals":
      return `deal "${text(row.title)}"`;
    case "tasks":
      return `task "${text(row.title)}"`;
    case "activities":
      return `the ${String(row.type).replace("_", " ")} "${text(row.summary)}"`;
    case "stages":
      return `stage ${text(row.label)}`;
    case "field_defs":
      return `field ${text(row.label)}`;
    case "rules":
      return `rule "${text(row.description)}"`;
    case "rule_firings":
      return "a rule firing";
    case "rulebook":
      return `rulebook "${text(row.name)}"`;
    case "settings":
      return "the settings";
  }
}

const COLUMN_LABELS: Record<string, string> = {
  next_at: "next date",
  next_step: "next step",
  fields: "custom fields",
  stage_key: "stage",
  due_at: "due date",
  done_at: "done date",
  snoozed_until: "snooze",
};

export const columnLabel = (column: string) => COLUMN_LABELS[column] ?? column.replaceAll("_", " ");

/** "custom fields (budget, size)" for the keys whose values differ between two JSON objects. */
export function fieldsLabel(before: Record<string, unknown>, after: Record<string, unknown>): string {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  return keys.length > 0 ? `custom fields (${keys.join(", ")})` : "custom fields";
}

/** "; next: Call, Thu Nov 19, 2:00 PM", or "" when there is no next step. */
export function nextPart(step: string | null, at: string | null, tz: string): string {
  const parts = [step, at === null ? null : formatLocal(at, tz)].filter((part) => part !== null);
  return parts.length > 0 ? `; next: ${parts.join(", ")}` : "";
}
