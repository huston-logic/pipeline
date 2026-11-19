// The full export (decision 0013): every owner table as JSON in one file, or one table as CSV. Rows are exported as
// stored (JSON columns stay JSON text, times stay UTC ISO), so an export is a faithful copy. Read-only.
import type { Db, TableName } from "../db/db.ts";
import { toCsv } from "./csv.ts";

/** Every table that holds the copy's data, in the order the export lists them. write_guard is empty scratch space. */
export const EXPORT_TABLES = [
  "contacts",
  "deals",
  "activities",
  "tasks",
  "stages",
  "field_defs",
  "rules",
  "rule_firings",
  "rulebook",
  "settings",
  "audit_log",
  "briefs",
] as const satisfies readonly TableName[];

export type ExportTable = (typeof EXPORT_TABLES)[number];

export type ExportRow = Record<string, unknown>;

export interface FullExport {
  exportedAt: string;
  tables: Record<ExportTable, ExportRow[]>;
}

export function isExportTable(name: string): name is ExportTable {
  return (EXPORT_TABLES as readonly string[]).includes(name);
}

// Table names come only from EXPORT_TABLES, never from the request, so interpolating them is safe.
const selectAll = (table: ExportTable) => `SELECT * FROM ${table} ORDER BY rowid`;

/** Every table in one D1 batch, so the tables are read from the same moment. */
export async function exportAll(db: Db, now: Date): Promise<FullExport> {
  const results = await db.batch<ExportRow>(EXPORT_TABLES.map((table) => db.prepare(selectAll(table))));
  const tables = Object.fromEntries(EXPORT_TABLES.map((table, i) => [table, results[i]?.results ?? []]));
  return { exportedAt: now.toISOString(), tables: tables as FullExport["tables"] };
}

/** One table as CSV, with its header row even when the table is empty. */
export async function exportTableCsv(db: Db, table: ExportTable): Promise<string> {
  const [columns = [], ...values] = await db.prepare(selectAll(table)).raw<unknown[]>({ columnNames: true });
  const rows = values.map((value) => Object.fromEntries(columns.map((column, i) => [column, value[i]])));
  return toCsv(rows, columns);
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * The name unchanged, or an error when it could break out of a Content-Disposition header or a folder: only letters,
 * digits, ".", "-" and "_", no "..", and no leading dot or dash. Every part is already checked where it comes from
 * (fixed table names, the owner's date, a checked copy name); this keeps it so if one of them ever changes.
 */
export function safeFileName(name: string): string {
  if (!SAFE_NAME.test(name) || name.includes("..")) {
    throw new Error(`${JSON.stringify(name)} isn't a safe file name.`);
  }
  return name;
}

/** "pipeline-contacts-2026-11-19.csv"; `localDate` is the owner's date. */
export const csvFilename = (table: ExportTable, localDate: string) => safeFileName(`pipeline-${table}-${localDate}.csv`);

export const jsonFilename = (localDate: string) => safeFileName(`pipeline-export-${localDate}.json`);
