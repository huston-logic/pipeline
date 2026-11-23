// The import engine (decision 0034): one way to bring a CSV in, whatever the records are. readCsv reads the file,
// autoMatch says where each header cell goes (a column the module defines, a custom field, or nowhere), and mapRows
// cleans each row's values. The module (src/import/modules/) then plans the rows and builds the one audited change.
// Pure: nothing here reads or writes the database.
import type { FieldDefRow } from "../db/db.ts";
import { type CsvRecord, parseCsvRecords } from "../http/csv.ts";
import type { ChangeInput } from "../services/change.ts";
import { sqlBytes } from "../services/bulk.ts";
import { UserError } from "../services/errors.ts";

export type { CsvRecord };

export type ImportModuleKey = "people" | "deals" | "tasks";

/** Where one CSV column goes. */
export type Target =
  | { kind: "builtin"; key: string }
  | { kind: "field"; key: string }
  | { kind: "new_field"; label: string }
  | { kind: "notes"; label: string }
  | { kind: "skip" };

/** A column the module defines. */
export interface ColumnDef {
  key: string;
  label: string;
  /** Other header names for this column, matched like the key (trimmed, any capitals). */
  aliases: string[];
  /** The most characters a value may have. */
  limit: number;
  /** Keeps its line breaks; in every other column a line break or tab becomes a space. */
  multiline: boolean;
  /** The header row must name it. */
  required?: boolean;
}

export interface ImportOptions {
  /** Created rows become leads: New, unless a lead_status column says otherwise. */
  asLeads: boolean;
  /** Create rows that look like someone already on file (leads imports only). */
  allowDuplicates: boolean;
  fieldDefs: readonly FieldDefRow[];
}

/** A custom field value one row gives, with the header of the column it came from (for skip reasons). */
export interface MappedField {
  key: string;
  column: string;
  text: string;
}

export interface MappedRow {
  /** The line of the file the row starts on. */
  line: number;
  /** Every module column by key: its cleaned value, or null when it is empty or not in the file. */
  values: Record<string, string | null>;
  /** The custom field values this row gives (empty cells left out), in column order. */
  fields: MappedField[];
}

export interface ImportModule<Ctx, Plan> {
  key: ImportModuleKey;
  noun: { one: string; many: string };
  /** Whose custom fields a column can fill; null when the records have none. */
  entity: "contact" | "deal" | null;
  columns: readonly ColumnDef[];
  /** The columns the missing-header message names; every column when left out. */
  hintColumns?: readonly string[];
  plan(rows: MappedRow[], ctx: Ctx, options: ImportOptions): Plan;
  change(plan: Plan, ctx: Ctx, now: Date): ChangeInput | null;
}

/** What reading and matching need from a module: not its plan or change. */
export type ModuleShape = Pick<ImportModule<never, unknown>, "noun" | "entity" | "columns" | "hintColumns">;

/** A module's plan, with the header names that are not imported. */
export type FilePlan<Plan> = Plan & { skippedColumns: string[] };

// What the export's formula guard (src/http/csv.ts) puts an apostrophe in front of.
const GUARDED = /^'[=+\-@\t\r]/;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const LINE_BREAK = /\r\n|[\r\n\t]/g;

const unguard = (value: string) => (GUARDED.test(value) ? value.slice(1) : value);

function cleanValue(raw: string, multiline: boolean): string | null {
  let value = unguard(raw).replace(CONTROL, "");
  if (!multiline) value = value.replace(LINE_BREAK, " ");
  value = value.trim();
  return value === "" ? null : value;
}

const headerKey = (text: string) => text.trim().toLowerCase();

/** The most data rows one import takes (decision 0035): one change, one undo, one D1 batch. */
export const IMPORT_MAX_ROWS = 2_000;

/** The largest file one import takes, in bytes (1 MB). */
export const IMPORT_MAX_BYTES = 1_048_576;

const FILE_COUNTS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

const isBlank = (record: CsvRecord) => record.fields.every((field) => field.trim() === "");

/**
 * The header row and the records after it; an empty file has an empty header. Refuses a file over IMPORT_MAX_BYTES or
 * with more than IMPORT_MAX_ROWS data rows (blank lines don't count), saying how to split it.
 */
export function readCsv(text: string): { header: string[]; records: CsvRecord[] } {
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > IMPORT_MAX_BYTES) {
    const mb = (Math.ceil((bytes * 10) / IMPORT_MAX_BYTES) / 10).toFixed(1);
    throw new UserError(`This file is ${mb} MB. One import takes at most 1 MB. Split it into smaller files and import each one.`);
  }
  const [first, ...records] = parseCsvRecords(text);
  const rows = records.filter((record) => !isBlank(record)).length;
  if (rows > IMPORT_MAX_ROWS) {
    const files = Math.ceil(rows / IMPORT_MAX_ROWS);
    throw new UserError(
      `This file has ${rows.toLocaleString("en-US")} rows. One import takes at most ${IMPORT_MAX_ROWS.toLocaleString("en-US")}. ` +
        `Split it into ${FILE_COUNTS[files] ?? files} files and import each one.`,
    );
  }
  return { header: first?.fields ?? [], records };
}

/**
 * Where each header cell goes, by name: a module column's key, then one of its aliases, then a custom field of the
 * module's entity (not archived) by key or label. Anything else is skipped.
 */
export function autoMatch(module: ModuleShape, header: string[], fieldDefs: readonly FieldDefRow[]): Target[] {
  return header.map((cell): Target => {
    const key = headerKey(cell);
    const column =
      module.columns.find((candidate) => candidate.key.toLowerCase() === key) ??
      module.columns.find((candidate) => candidate.aliases.some((alias) => headerKey(alias) === key));
    if (column) return { kind: "builtin", key: column.key };
    const def = fieldDefs.find(
      (candidate) =>
        module.entity !== null &&
        candidate.entity === module.entity &&
        candidate.archived === 0 &&
        (candidate.key.toLowerCase() === key || headerKey(candidate.label) === key),
    );
    return def ? { kind: "field", key: def.key } : { kind: "skip" };
  });
}

/** Header names (trimmed, blank ones left out) whose column is skipped. */
export function skippedColumnNames(header: readonly string[], targets: readonly Target[]): string[] {
  return header.flatMap((cell, index) => {
    const name = cell.trim();
    return targets[index]?.kind === "skip" && name !== "" ? [name] : [];
  });
}

function checkTargets(module: ModuleShape, header: readonly string[], targets: readonly Target[]): void {
  if (header.length === 0) {
    throw new UserError(`The CSV file is empty. Export your ${module.noun.many} with a header row and try again.`);
  }
  const seen = new Set<string>();
  for (const target of targets) {
    if (target.kind === "notes" || target.kind === "new_field") {
      throw new Error(`Importing a column as ${target.kind === "notes" ? "notes" : "a new field"} is not supported yet.`);
    }
    if (target.kind === "skip") continue;
    if (target.kind === "builtin" && !module.columns.some((column) => column.key === target.key)) {
      throw new Error(`The import maps a column to "${target.key}", which this import doesn't have.`);
    }
    const id = `${target.kind}:${target.key}`;
    if (seen.has(id)) {
      throw new UserError(`The header row names "${target.key}" twice. Keep one column of each name and try again.`);
    }
    seen.add(id);
  }
  const missing = module.columns.filter((column) => column.required && !seen.has(`builtin:${column.key}`));
  if (missing.length > 0) {
    const hint = module.hintColumns ?? module.columns.map((column) => column.key);
    throw new UserError(
      `The first line must be a header row naming the columns, with at least ${missing.map((column) => `"${column.key}"`).join(", ")} ` +
        `(${hint.join(", ")}). Add one and try again.`,
    );
  }
}

/**
 * Each record's cleaned values: the export's formula guard taken off, control characters removed, line breaks kept
 * only in multiline columns, trimmed, and an empty cell is null. Refuses an empty file, a target named twice and a
 * missing required column, in plain English. `targets[i]` and `header[i]` describe column i.
 */
export function mapRows(
  module: ModuleShape,
  records: CsvRecord[],
  targets: Target[],
  header: readonly string[],
): MappedRow[] {
  checkTargets(module, header, targets);
  const columns = new Map(module.columns.map((column) => [column.key, column]));
  return records.map(({ line, fields: cells }) => {
    const values: Record<string, string | null> = Object.fromEntries(module.columns.map((column) => [column.key, null]));
    const fields: MappedField[] = [];
    const sizes = new RowSize(line);
    targets.forEach((target, index) => {
      const raw = cells[index] ?? "";
      const column = (header[index] ?? "").trim();
      if (target.kind === "builtin") {
        values[target.key] = sizes.add(cleanValue(raw, columns.get(target.key)?.multiline ?? false), column);
      } else if (target.kind === "field") {
        const text = sizes.add(cleanValue(raw, false), column);
        if (text !== null) fields.push({ key: target.key, column, text });
      }
    });
    sizes.check();
    return { line, values, fields };
  });
}

/**
 * The most one imported value may take, and the most one row's values may take together, measured as stored (decision
 * 0035): JSON inside JSON for a custom field, then as a SQL literal. A row is written into a statement of at most
 * CHUNK_BYTES (90 KB), and an undo's snapshot holds it twice (before and after), so a row must stay under half of that
 * with room for its ids and times. Within these, every bulk statement fits D1's 100 KB.
 */
export const IMPORT_MAX_VALUE_BYTES = 40_000;
export const IMPORT_MAX_ROW_BYTES = 40_000;

const kb = (bytes: number) => `${Math.ceil(bytes / 1000)} KB`;

/** A value's stored size, worst case: written as JSON inside JSON (a custom field), then as a SQL literal. */
const storedBytes = (text: string) => sqlBytes(JSON.stringify(JSON.stringify(text)));

/** Adds up one row's values and refuses, in plain English, a value or a row too large to write in one statement. */
class RowSize {
  readonly #line: number;
  readonly #texts: string[] = [];
  #bound = 0;

  constructor(line: number) {
    this.#line = line;
  }

  add(text: string | null, column: string): string | null {
    if (text === null) return null;
    // Stored, one UTF-16 unit takes at most 7 bytes (a lone surrogate, \\uXXXX escaped twice), so a short value
    // needs no measuring.
    const bound = 7 * text.length + 6;
    if (bound > IMPORT_MAX_VALUE_BYTES) {
      const bytes = storedBytes(text);
      if (bytes > IMPORT_MAX_VALUE_BYTES) {
        throw new UserError(
          `Line ${this.#line}'s ${column === "" ? "unnamed" : `"${column}"`} value is ${kb(bytes)}; one value can be at most ` +
            `${kb(IMPORT_MAX_VALUE_BYTES)}. Shorten it and try again.`,
        );
      }
    }
    this.#texts.push(text);
    this.#bound += bound;
    return text;
  }

  check(): void {
    if (this.#bound <= IMPORT_MAX_ROW_BYTES) return;
    const total = this.#texts.reduce((sum, text) => sum + storedBytes(text), 0);
    if (total > IMPORT_MAX_ROW_BYTES) {
      throw new UserError(
        `Line ${this.#line} is ${kb(total)}; one row can be at most ${kb(IMPORT_MAX_ROW_BYTES)}. ` +
          "Shorten its longest values and try again.",
      );
    }
  }
}

/** readCsv, autoMatch and mapRows in one: the rows a module plans, and the header names not imported. */
export function mapCsv(
  module: ModuleShape,
  csvText: string,
  fieldDefs: readonly FieldDefRow[],
): { rows: MappedRow[]; skippedColumns: string[] } {
  const { header, records } = readCsv(csvText);
  const targets = autoMatch(module, header, fieldDefs);
  return { rows: mapRows(module, records, targets, header), skippedColumns: skippedColumnNames(header, targets) };
}

/** A CSV file planned by a module, matched by header names. */
export function planCsv<Ctx, Plan extends object>(
  module: ImportModule<Ctx, Plan>,
  csvText: string,
  ctx: Ctx,
  options: ImportOptions,
): FilePlan<Plan> {
  const { rows, skippedColumns } = mapCsv(module, csvText, options.fieldDefs);
  return { ...module.plan(rows, ctx, options), skippedColumns };
}
