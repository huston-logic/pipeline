// The owner's current labels for person statuses and their sub-statuses (decision 0041), read once per answer. Keys
// never change; labels may, so every place that shows a status or a lead status to the owner (MCP answers, change
// summaries, the board) reads them here. A key with no row falls back to the fixed label (LEAD_STATUS_LABELS, or the
// seeded status labels), then to the key itself. Labels are the owner's own text, never outside text.
import { LEAD_STATUS_LABELS, type LeadStatus } from "./lead-status.ts";
import { personStatusRows, type Reader, readerOf, subStatusRows } from "./memo.ts";
import { LEAD, SEEDED_STATUSES } from "./person-move.ts";

export interface StatusLabels {
  /** A person status's label. */
  status(key: string): string;
  /** A sub-status's label, or null for none. */
  sub(status: string, key: string | null): string | null;
  /** A lead status's label: Lead's sub-status label for the five, the fixed "Qualified" for qualified. */
  lead(status: LeadStatus): string;
  /** "Contact", or "Contact (Client)" with a sub-status. */
  both(status: string, sub: string | null): string;
}

/** The labels as a lookup, from rows of (status key, sub-status key or null, label). */
export function labelsFrom(rows: readonly { status_key: string; sub_key: string | null; label: string }[]): StatusLabels {
  const statuses = new Map<string, string>();
  const subs = new Map<string, string>();
  for (const row of rows) {
    if (row.sub_key === null) statuses.set(row.status_key, row.label);
    else subs.set(`${row.status_key}.${row.sub_key}`, row.label);
  }
  const status = (key: string) => statuses.get(key) ?? SEEDED_STATUSES.find((entry) => entry.key === key)?.label ?? key;
  const sub = (statusKey: string, key: string | null) => {
    if (key === null) return null;
    const found = subs.get(`${statusKey}.${key}`);
    if (found !== undefined) return found;
    return statusKey === LEAD && Object.hasOwn(LEAD_STATUS_LABELS, key) ? LEAD_STATUS_LABELS[key as LeadStatus] : key;
  };
  return {
    status,
    sub,
    lead: (key) => (key === "qualified" ? LEAD_STATUS_LABELS.qualified : (sub(LEAD, key) ?? LEAD_STATUS_LABELS[key])),
    both: (key, subKey) => {
      const subLabel = sub(key, subKey);
      return subLabel === null ? status(key) : `${status(key)} (${subLabel})`;
    },
  };
}

/** Every status's and sub-status's label, archived ones included, in one query. */
export async function statusLabels(src: Reader): Promise<StatusLabels> {
  const { db, memo } = readerOf(src);
  if (memo !== undefined) {
    const [statuses, subs] = [await personStatusRows(src), await subStatusRows(src)];
    return labelsFrom([
      ...statuses.map((row) => ({ status_key: row.key, sub_key: null, label: row.label })),
      ...subs.map((row) => ({ status_key: row.status_key, sub_key: row.key, label: row.label })),
    ]);
  }
  const found = await db
    .prepare(
      `SELECT key AS status_key, NULL AS sub_key, label FROM person_statuses
       UNION ALL SELECT status_key, key AS sub_key, label FROM person_substatuses`,
    )
    .all<{ status_key: string; sub_key: string | null; label: string }>();
  return labelsFrom(found.results);
}
