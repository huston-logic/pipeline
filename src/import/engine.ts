// The import engine (decision 0034): one way to bring a CSV in, whatever the records are. readCsv reads the file,
// autoMatch says where each header cell goes (a column the module defines, a custom field, or nowhere), and mapRows
// cleans each row's values. The module (src/import/modules/) then plans the rows and builds the one audited change.
// Pure: nothing here reads or writes the database.
import type { FieldDefRow } from "../db/db.ts";
import { type CsvRecord, parseCsvRecords } from "../http/csv.ts";
import type { ChangeInput, RowChange } from "../services/change.ts";
import { sqlBytes } from "../services/bulk.ts";
import { UserError } from "../services/errors.ts";
import { newFieldRow } from "../services/fields.ts";
import { slugOf } from "../services/slug.ts";

export type { CsvRecord };

export type ImportModuleKey = "people" | "deals" | "tasks";

/**
 * Where one CSV column goes. `new_field` creates a text field of the module's entity, labelled `label`, in the
 * import's own change; `notes` adds a "label: value" line to the record's notes (decision 0036).
 */
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

/** A custom field value one row gives, with the 0-based index of the column it came from. */
export interface MappedField {
  key: string;
  column: number;
  text: string;
}

/** A value for the record's notes, from a column mapped to "Add to notes", with the label the owner gave it. */
export interface MappedNote {
  label: string;
  text: string;
}

export interface MappedRow {
  /** The line of the file the row starts on. */
  line: number;
  /** Every module column by key: its cleaned value, or null when it is empty or not in the file. */
  values: Record<string, string | null>;
  /** The custom field values this row gives (empty cells left out), in column order. */
  fields: MappedField[];
  /** The notes lines this row gives (empty cells left out), in column order. */
  notes: MappedNote[];
}

/** A mapping the owner has to fix, with the column (0-based) it is about, so the board can point at it. */
export class MappingError extends UserError {
  readonly column: number;

  constructor(message: string, column: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "MappingError";
    this.column = column;
  }
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

/**
 * "column 3": a column by its number, never by its header cell, which is outside text (the matching step shows the
 * header beside the number, escaped and labelled). `header` is kept so every caller names the same column the same way.
 */
function columnName(_header: readonly string[], index: number): string {
  return `column ${index + 1}`;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function checkLength(header: readonly string[], targets: readonly Target[]): void {
  if (targets.length === header.length) return;
  const columns = `${header.length} ${header.length === 1 ? "column" : "columns"}`;
  const matched = `${targets.length} ${targets.length === 1 ? "was" : "were"} matched`;
  throw new UserError(`The column matches don't fit this file: it has ${columns} and ${matched}. Match the columns again.`);
}

const NOTE_LABEL_MAX = 60;

/** A notes label as it is written: one line, trimmed, at most 60 characters. */
function noteLabel(label: string, header: readonly string[], index: number): string {
  const text = label.replace(CONTROL, "").replace(LINE_BREAK, " ").trim();
  if (text === "") {
    throw new MappingError(`Give the notes label for ${columnName(header, index)} some words, for example "Referred by".`, index);
  }
  if (text.length > NOTE_LABEL_MAX) {
    throw new MappingError(`A notes label can be at most ${NOTE_LABEL_MAX} characters (got ${text.length}).`, index);
  }
  return text;
}

function checkTargets(module: ModuleShape, header: readonly string[], targets: readonly Target[], fieldDefs: readonly FieldDefRow[]): void {
  if (header.length === 0) {
    throw new UserError(`The CSV file is empty. Export your ${module.noun.many} with a header row and try again.`);
  }
  checkLength(header, targets);
  const seen = new Set<string>();
  targets.forEach((target, index) => {
    if (target.kind === "new_field") throw new Error("A new field must be planned (planNewFields) before its rows are mapped.");
    if (target.kind === "skip") return;
    if (target.kind === "notes") {
      noteLabel(target.label, header, index);
      return;
    }
    if (target.kind === "builtin" && !module.columns.some((column) => column.key === target.key)) {
      throw new Error(`The import maps a column to "${target.key}", which this import doesn't have.`);
    }
    if (
      target.kind === "field" &&
      !fieldDefs.some((def) => def.key === target.key && def.entity === module.entity && def.archived === 0)
    ) {
      throw new MappingError(
        `${capitalize(columnName(header, index))} goes to a field that isn't a ${module.noun.one} field you can fill (it may ` +
          "have been archived). Choose again for that column.",
        index,
      );
    }
    const id = `${target.kind}:${target.key}`;
    if (seen.has(id)) {
      throw new MappingError(`The header row names "${target.key}" twice. Keep one column of each name and try again.`, index);
    }
    seen.add(id);
  });
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
 * The fields the mapping's `new_field` columns would create, as rows not yet written (text fields of the module's
 * entity, labelled and keyed exactly as add_field would), and the targets with each of those columns pointing at its
 * new field. Refuses, naming the column: a label add_field would refuse, a label whose key a live field already has
 * (that field should be chosen instead), and two columns that would make the same field. `fieldDefs` must include
 * archived fields, so a key is never reused.
 */
export function planNewFields(
  module: ModuleShape,
  header: readonly string[],
  targets: readonly Target[],
  fieldDefs: readonly FieldDefRow[],
  now: Date,
): { targets: Target[]; created: FieldDefRow[] } {
  checkLength(header, targets);
  const created: FieldDefRow[] = [];
  const resolved = targets.map((target, index): Target => {
    if (target.kind !== "new_field") return target;
    const entity = module.entity;
    if (entity === null) {
      throw new MappingError(`${capitalize(module.noun.many)} have no custom fields, so a column can't become a new field.`, index);
    }
    const known = [...fieldDefs, ...created];
    let row: FieldDefRow;
    try {
      const live = known.find((def) => def.entity === entity && def.archived === 0 && def.key === slugOrNull(target.label));
      if (live) {
        throw new UserError(
          `There's already a ${entity} field with the key ${live.key} (${live.label}). Choose it for ${columnName(header, index)} ` +
            "instead, or give the new field another label.",
        );
      }
      row = newFieldRow(known, { entity, label: target.label, type: "text" }, now);
    } catch (error) {
      if (error instanceof UserError) throw new MappingError(error.message, index, { cause: error });
      throw error;
    }
    created.push(row);
    return { kind: "field", key: row.key };
  });
  return { targets: resolved, created };
}

/** The key a label would slug to, or null when it has nothing to build one from (newFieldRow then says so). */
function slugOrNull(label: string): string | null {
  try {
    return slugOf(label.trim());
  } catch {
    return null;
  }
}

/**
 * Each record's cleaned values: the export's formula guard taken off, control characters removed, line breaks kept
 * only in multiline columns, trimmed, and an empty cell is null. Refuses an empty file, a mapping that doesn't fit the
 * header, a target named twice, a field target that isn't a live field of the module's entity, a blank notes label
 * and a missing required column, in plain English. `targets[i]` and `header[i]` describe column i. A `new_field`
 * target must have gone through planNewFields first, and `fieldDefs` must include the fields it planned.
 */
export function mapRows(
  module: ModuleShape,
  records: CsvRecord[],
  targets: Target[],
  header: readonly string[],
  fieldDefs: readonly FieldDefRow[],
): MappedRow[] {
  checkTargets(module, header, targets, fieldDefs);
  const columns = new Map(module.columns.map((column) => [column.key, column]));
  const labels = targets.map((target, index) => (target.kind === "notes" ? noteLabel(target.label, header, index) : ""));
  // What a size refusal calls each column: a built-in column's key or a field's label (both trusted), else its number.
  const names = targets.map((target, index) => {
    if (target.kind === "builtin") return `"${target.key}" value`;
    const def = target.kind === "field" ? fieldDefs.find((candidate) => candidate.key === target.key && candidate.entity === module.entity) : undefined;
    return def ? `"${def.label}" value` : `value in column ${index + 1}`;
  });
  return records.map(({ line, fields: cells }) => {
    const values: Record<string, string | null> = Object.fromEntries(module.columns.map((column) => [column.key, null]));
    const fields: MappedField[] = [];
    const notes: MappedNote[] = [];
    const sizes = new RowSize(line);
    targets.forEach((target, index) => {
      const raw = cells[index] ?? "";
      const name = names[index] ?? `value in column ${index + 1}`;
      if (target.kind === "builtin") {
        values[target.key] = sizes.add(cleanValue(raw, columns.get(target.key)?.multiline ?? false), name);
      } else if (target.kind === "field") {
        const text = sizes.add(cleanValue(raw, false), name);
        if (text !== null) fields.push({ key: target.key, column: index, text });
      } else if (target.kind === "notes") {
        const text = sizes.add(cleanValue(raw, false), name);
        if (text !== null) notes.push({ label: labels[index] ?? "", text });
      }
    });
    sizes.check();
    return { line, values, fields, notes };
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

  /** `name` is how the refusal names the value: `"notes" value`, `"Budget" value` or `value in column 3`. */
  add(text: string | null, name: string): string | null {
    if (text === null) return null;
    // Stored, one UTF-16 unit takes at most 7 bytes (a lone surrogate, \\uXXXX escaped twice), so a short value
    // needs no measuring.
    const bound = 7 * text.length + 6;
    if (bound > IMPORT_MAX_VALUE_BYTES) {
      const bytes = storedBytes(text);
      if (bytes > IMPORT_MAX_VALUE_BYTES) {
        throw new UserError(
          `Line ${this.#line}'s ${name} is ${kb(bytes)}; one value can be at most ` +
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
  return { rows: mapRows(module, records, targets, header, fieldDefs), skippedColumns: skippedColumnNames(header, targets) };
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

export interface MappedFile {
  header: string[];
  rows: MappedRow[];
  skippedColumns: string[];
  /** The fields the mapping creates, not yet written (planNewFields). */
  newFields: FieldDefRow[];
  /** `fieldDefs` and the new fields: what the module's plan takes as `ImportOptions.fieldDefs`. */
  fieldDefs: FieldDefRow[];
}

/**
 * A file mapped the way the owner chose (the board's mapping step): readCsv, planNewFields, then mapRows. `fieldDefs`
 * must include archived fields (see planNewFields).
 */
export function mapFile(
  module: ModuleShape,
  csvText: string,
  targets: readonly Target[],
  fieldDefs: readonly FieldDefRow[],
  now: Date,
): MappedFile {
  const { header, records } = readCsv(csvText);
  if (header.length === 0) {
    throw new UserError(`The CSV file is empty. Export your ${module.noun.many} with a header row and try again.`);
  }
  const { targets: resolved, created } = planNewFields(module, header, targets, fieldDefs, now);
  const all = [...fieldDefs, ...created];
  return {
    header,
    rows: mapRows(module, records, resolved, header, all),
    skippedColumns: skippedColumnNames(header, resolved),
    newFields: created,
    fieldDefs: all,
  };
}

/**
 * The module's change for its plan, with the new fields inserted first in the same change, so one undo takes back the
 * fields and the records. Null when the plan writes no record: a new field alone is never added.
 */
export function fileChange<Ctx, Plan>(
  module: ImportModule<Ctx, Plan>,
  plan: Plan,
  ctx: Ctx,
  now: Date,
  newFields: readonly FieldDefRow[],
): ChangeInput | null {
  const input = module.change(plan, ctx, now);
  if (input === null || newFields.length === 0) return input;
  const fields: RowChange[] = newFields.map((row) => ({ table: "field_defs", id: row.id, before: null, after: row }));
  const entity = newFields[0]?.entity ?? "contact";
  const n = newFields.length;
  return {
    ...input,
    summary: `${input.summary}; added ${n} ${entity} ${n === 1 ? "field" : "fields"}`,
    changes: [...fields, ...input.changes],
  };
}
