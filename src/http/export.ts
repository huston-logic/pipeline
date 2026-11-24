// The full export (decision 0013): every owner table as JSON in one file, or one table as CSV. Rows are exported as
// stored (JSON columns stay JSON text, times stay UTC ISO), so an export is a faithful copy. Read-only.
import type { Db, TableName } from "../db/db.ts";
import { toCsv } from "./csv.ts";

/**
 * Every table that holds the copy's data, in the order the export lists them. write_guard and the board import's drafts
 * (decision 0036) are scratch space.
 */
export const EXPORT_TABLES = [
  "contacts",
  "deals",
  "activities",
  "tasks",
  "time_entries",
  "work_types",
  "client_rates",
  "stages",
  "person_statuses",
  "person_substatuses",
  "field_defs",
  "views",
  "rules",
  "rule_firings",
  "rulebook",
  "settings",
  "audit_log",
  "audit_parts",
  "briefs",
  "email_log",
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

/** Rows per piece of the streamed JSON export. */
export const EXPORT_ROWS_PER_CHUNK = 250;

/**
 * The JSON export as text pieces, table by table and a few hundred rows at a time, so the Worker never holds the
 * whole file as one string (decision 0020). Joined, the pieces are `{ exportedAt, tables }` with one row per line.
 */
export function* exportJsonChunks(full: FullExport): Generator<string> {
  yield `{\n  "exportedAt": ${JSON.stringify(full.exportedAt)},\n  "tables": {`;
  for (const [t, table] of EXPORT_TABLES.entries()) {
    const rows = full.tables[table];
    yield `${t === 0 ? "" : ","}\n    ${JSON.stringify(table)}: [`;
    for (let i = 0; i < rows.length; i += EXPORT_ROWS_PER_CHUNK) {
      yield rows
        .slice(i, i + EXPORT_ROWS_PER_CHUNK)
        .map((row, j) => `${i + j === 0 ? "" : ","}\n      ${JSON.stringify(row)}`)
        .join("");
    }
    yield rows.length === 0 ? "]" : "\n    ]";
  }
  yield "\n  }\n}\n";
}

/** The pieces as a byte stream for a Response body, made one piece at a time as the client reads. */
export function exportJsonStream(full: FullExport): ReadableStream<Uint8Array> {
  const pieces = exportJsonChunks(full);
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = pieces.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
  });
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
