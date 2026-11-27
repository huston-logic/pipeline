// The project page's facts (run 12, ruling 8): each chosen fact key as a label and a value, in order. A custom field
// over 80 characters goes to the Notes disclosure instead of the grid.
import type { ProjectDetail } from "../services/project-read.ts";
import { formatDuration, formatMoney } from "../services/time-format.ts";
import { PROJECT_FACT_LABELS } from "../services/view-spec.ts";
import { contactLink, dealLink, labelled, type Pair } from "./parts.ts";
import { dateOr } from "./project-parts.ts";

export const LONG_FACT = 80;

const fieldText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

/** A fact's label: the built-in name, or the custom field's own label. */
export const factLabel = (key: string, fieldLabels: Map<string, string>): string =>
  key.startsWith("fields.") ? (fieldLabels.get(key.slice("fields.".length)) ?? key) : (PROJECT_FACT_LABELS[key] ?? key);

function valueOf(key: string, project: ProjectDetail, tz: string): { value: Pair["value"]; long: boolean } | null {
  const outside = new Set<string>(project.untrusted_fields);
  switch (key) {
    case "person":
      return {
        value: project.contactId === null || project.contactName === null ? "Internal" : contactLink(project.contactId, project.contactName, outside.has("contactName")),
        long: false,
      };
    case "deal":
      return project.dealId === null || project.dealTitle === null ? null : { value: dealLink(project.dealId, project.dealTitle, outside.has("dealTitle")), long: false };
    case "start":
      return { value: dateOr(project.startAt, tz), long: false };
    case "target":
      return { value: dateOr(project.targetAt, tz), long: false };
    case "open_tasks":
      return { value: String(project.openTaskCount), long: false };
    case "time": {
      const { time } = project;
      if (time === null) return null;
      const amount = time.billableMinutes > 0 ? `, ${formatMoney(time.amountCents / 100)}` : "";
      return { value: `${formatDuration(time.minutes)}${amount}`, long: false };
    }
  }
  if (!key.startsWith("fields.")) return null;
  const stored = project.fields[key.slice("fields.".length)];
  if (stored === undefined || stored === null || stored === "") return null;
  const text = fieldText(stored);
  return { value: labelled(text, false), long: [...text].length > LONG_FACT };
}

/** The facts in the chosen order: short ones for the grid, long custom fields for behind Notes. */
export function factPairs(keys: readonly string[], project: ProjectDetail, fieldLabels: Map<string, string>, tz: string): { shown: Pair[]; long: Pair[] } {
  const shown: Pair[] = [];
  const long: Pair[] = [];
  for (const key of keys) {
    if (key === "status") continue; // drawn as the tag beside the name, not as a pair
    const fact = valueOf(key, project, tz);
    if (fact !== null) (fact.long ? long : shown).push({ name: factLabel(key, fieldLabels), value: fact.value });
  }
  return { shown, long };
}
