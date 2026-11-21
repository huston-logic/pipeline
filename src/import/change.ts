// The CSV import's one audited change (actor owner, tool "import"): the plan's new contacts and filled-in details,
// built as the same row snapshots, write_guard checks and audit row that commitChange writes, then rendered as a SQL
// file for `wrangler d1 execute --file`. Undo reverses it like any other change (undo_change).
import type { ContactRow } from "../db/db.ts";
import { newId } from "../ids.ts";
import { buildChange, type Ctx, type ChangeInput, type RowChange, updatedRow } from "../services/change.ts";
import { IMPORT_COLUMNS, type ImportPlan } from "./plan.ts";
import { renderScript } from "./sql.ts";

export const IMPORT_ACTOR = { actor: "owner", tool: "import" } as const satisfies Pick<Ctx, "actor" | "tool">;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Counts only: an import's summary never quotes what the file held. */
export const importSummary = (created: number, filled: number) =>
  `Imported ${plural(created, "contact", "contacts")} and filled details on ${filled}`;

/** The change for a plan, or null when it would write nothing. `existing` holds every contact a merge names. */
export function importChange(plan: ImportPlan, existing: readonly ContactRow[], now: Date): ChangeInput | null {
  const stamp = now.toISOString();
  const changes: RowChange[] = [];
  for (const row of plan.create) {
    const contact: ContactRow = {
      id: newId("ct"),
      name: row.name,
      email: row.email,
      phone: row.phone,
      business: row.business,
      source: row.source,
      notes: row.notes,
      fields: JSON.stringify(row.fields),
      untrusted_fields: JSON.stringify([...IMPORT_COLUMNS.filter((column) => row[column] !== null), ...Object.keys(row.fields)]),
      archived: 0,
      version: 1,
      created_at: stamp,
      updated_at: stamp,
      lead_status: row.leadStatus,
      lead_status_at: row.leadStatus === null ? null : stamp,
    };
    changes.push({ table: "contacts", id: contact.id, before: null, after: contact });
  }
  for (const { id, changes: filled, fields: filledFields } of plan.merge) {
    const before = existing.find((contact) => contact.id === id);
    if (!before) throw new Error(`The import plan names contact ${id}, which wasn't read.`);
    const untrusted = new Set(JSON.parse(before.untrusted_fields) as string[]);
    for (const column of [...Object.keys(filled), ...Object.keys(filledFields ?? {})]) untrusted.add(column);
    const patch: Partial<ContactRow> = { ...filled, untrusted_fields: JSON.stringify([...untrusted]) };
    if (filledFields) patch.fields = JSON.stringify({ ...(JSON.parse(before.fields) as object), ...filledFields });
    const after = updatedRow(before, patch, now);
    changes.push({ table: "contacts", id, before, after });
  }
  const first = changes[0];
  if (!first) return null;
  return {
    target: { table: "contacts", id: first.id },
    summary: importSummary(plan.create.length, plan.merge.length),
    changes,
  };
}

export interface RenderedImport {
  changeId: string;
  summary: string;
  sql: string;
}

/** The change as a SQL file: the guards and writes, then the audit row, exactly as commitChange would batch them. */
export function renderImport(input: ChangeInput, now: Date): RenderedImport {
  const { changeId, summary, writes, audit } = buildChange({ ...IMPORT_ACTOR, now }, input);
  return { changeId, summary, sql: renderScript([...writes, ...audit]) };
}
