// The one way the services write: every change is a single D1 batch holding the row writes, any extra statements,
// and its audit_log row. Updates and deletes are guarded by write_guard (see migrations/0001_init.sql), so a row that
// changed after it was read aborts the whole batch. Decision 0009 describes the snapshot format and undo.
import type { Actor, Db, TableName } from "../db/db.ts";
import { newId } from "../ids.ts";
import { UserError } from "./errors.ts";

export type { Actor };

export interface Ctx {
  db: Db;
  now: Date;
  actor: Actor;
  /** The tool or job making the change, for example "add_lead", "undo_change" or "rules_cron". */
  tool: string;
}

export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

/** The tables a change may write, with each one's primary key. audit_log and write_guard are written only here. */
const PRIMARY_KEYS = {
  settings: "id",
  stages: "key",
  field_defs: "id",
  contacts: "id",
  deals: "id",
  activities: "id",
  tasks: "id",
  rules: "id",
  rule_firings: "id",
  rulebook: "name",
} as const satisfies Partial<Record<TableName, string>>;

export type ChangeTable = keyof typeof PRIMARY_KEYS;

export function isChangeTable(table: string): table is ChangeTable {
  return Object.hasOwn(PRIMARY_KEYS, table);
}

export function primaryKey(table: ChangeTable): string {
  return PRIMARY_KEYS[table];
}

/** One touched row: `before` null is an insert, `after` null a delete (undo only), both set an update. */
export interface RowChange {
  table: ChangeTable;
  id: string;
  before: Row | null;
  after: Row | null;
}

export interface ChangeResult {
  changeId: string;
  summary: string;
}

export interface ChangeInput {
  target: { table: ChangeTable; id: string };
  /** One plain-English line for the owner, without the change id (added here). */
  summary: string;
  changes: RowChange[];
  /** Statements that run in the same batch but are not part of the snapshot, so undo leaves them alone. */
  extra?: D1PreparedStatement[];
  /** Set by undoChange, which needs the id before the batch is built. */
  changeId?: string;
  /** Set by undoChange: the change this one reverses. */
  undoOf?: string;
}

/** A row changed between reading it and writing it. */
export class StaleWriteError extends UserError {}

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

const ROW_NOUNS: Record<ChangeTable, string> = {
  settings: "The settings",
  stages: "Stage",
  field_defs: "Field",
  contacts: "Contact",
  deals: "Deal",
  activities: "Activity",
  tasks: "Task",
  rules: "Rule",
  rule_firings: "Rule firing",
  rulebook: "Rulebook document",
};

export const rowKey = (table: ChangeTable, id: string) => `${table}:${id}`;

export const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** `before` with `patch` applied, the version bumped and updated_at set, ready to be a RowChange's `after`. */
export function updatedRow<T extends Row>(before: T, patch: Partial<T>, now: Date): T {
  const after: Row = { ...before, ...patch };
  if (typeof before.version === "number") after.version = before.version + 1;
  if ("updated_at" in before) after.updated_at = now.toISOString();
  return after as T;
}

/** Columns whose values differ between two snapshots of the same row. */
export function changedColumns(before: Row, after: Row): string[] {
  return Object.keys(after).filter((column) => before[column] !== after[column]);
}

function columnsOf(row: Row): string[] {
  const columns = Object.keys(row);
  for (const column of columns) {
    if (!IDENTIFIER.test(column)) throw new Error(`A change has an invalid column name: ${JSON.stringify(column)}.`);
  }
  return columns;
}

function checkChange(change: RowChange): { table: ChangeTable; pk: string } {
  const { table } = change;
  if (!isChangeTable(table)) throw new Error(`A change can't write the table ${JSON.stringify(table)}.`);
  const pk = PRIMARY_KEYS[table];
  const rows = [change.before, change.after].filter((row): row is Row => row !== null);
  if (rows.length === 0) throw new Error(`A change to ${table}:${change.id} needs a before or an after row.`);
  for (const row of rows) {
    columnsOf(row);
    if (row[pk] === undefined || row[pk] === null || String(row[pk]) !== change.id) {
      throw new Error(`A change to ${table}:${change.id} has a row with a different id (${String(row[pk])}).`);
    }
  }
  if (change.before && change.after && typeof change.before.version === "number") {
    if (change.after.version !== change.before.version + 1) {
      throw new Error(`A change to ${table}:${change.id} must bump the version from ${change.before.version}.`);
    }
  }
  return { table, pk };
}

/** Fails the batch (write_guard's CHECK) unless the row is still exactly as `before` says. */
function guardStatement(db: Db, table: ChangeTable, pk: string, before: Row): D1PreparedStatement {
  const sql = "INSERT INTO write_guard (ok) SELECT COUNT(*) = 1 FROM";
  if (typeof before.version === "number") {
    return db.prepare(`${sql} ${table} WHERE ${pk} = ? AND version = ?`).bind(before[pk], before.version);
  }
  const columns = columnsOf(before);
  return db
    .prepare(`${sql} ${table} WHERE ${columns.map((column) => `${column} IS ?`).join(" AND ")}`)
    .bind(...columns.map((column) => before[column]));
}

function writeStatement(db: Db, table: ChangeTable, pk: string, change: RowChange): D1PreparedStatement {
  const { before, after } = change;
  if (after === null) {
    return db.prepare(`DELETE FROM ${table} WHERE ${pk} = ?`).bind(before?.[pk]);
  }
  const columns = columnsOf(after);
  if (before === null) {
    return db
      .prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .bind(...columns.map((column) => after[column]));
  }
  const set = columns.filter((column) => column !== pk);
  return db
    .prepare(`UPDATE ${table} SET ${set.map((column) => `${column} = ?`).join(", ")} WHERE ${pk} = ?`)
    .bind(...set.map((column) => after[column]), after[pk]);
}

/** The error's message and those of every `cause` below it: D1 wraps the SQLite text in its own error. */
function errorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  for (let current = error; current !== undefined && current !== null && !seen.has(current); ) {
    seen.add(current);
    parts.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join("\n");
}

export const isGuardFailure = (error: unknown) => /CHECK constraint failed: ok = 1/.test(errorText(error));

export const isForeignKeyFailure = (error: unknown) => /FOREIGN KEY constraint failed/.test(errorText(error));

/** Two contacts with the same email (the unique index on lower(email)). */
export const isDuplicateEmailFailure = (error: unknown) =>
  /UNIQUE constraint failed: (?:index 'contacts_email'|contacts\.)/.test(errorText(error));

/** A rule firing whose fire_key another run inserted first (two rule runs racing). */
export const isFireKeyFailure = (error: unknown) =>
  /UNIQUE constraint failed: rule_firings\.fire_key/.test(errorText(error));

export async function commitChange(ctx: Ctx, input: ChangeInput): Promise<ChangeResult> {
  const { db } = ctx;
  if (!isChangeTable(input.target.table)) {
    throw new Error(`A change can't target the table ${JSON.stringify(input.target.table)}.`);
  }
  const seen = new Set<string>();
  const guards: D1PreparedStatement[] = [];
  const writes: D1PreparedStatement[] = [];
  const before: Record<string, Row | null> = {};
  const after: Record<string, Row | null> = {};
  for (const change of input.changes) {
    const { table, pk } = checkChange(change);
    const key = rowKey(table, change.id);
    if (seen.has(key)) throw new Error(`A change touches ${key} twice.`);
    seen.add(key);
    if (change.before) guards.push(guardStatement(db, table, pk, change.before));
    writes.push(writeStatement(db, table, pk, change));
    before[key] = change.before;
    after[key] = change.after;
  }

  const changeId = input.changeId ?? newId("chg");
  const summary = `${oneLine(input.summary)} (change ${changeId})`;
  const audit = db
    .prepare(
      `INSERT INTO audit_log (id, at, actor, tool, target_table, target_id, before_json, after_json, summary, undo_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      changeId,
      ctx.now.toISOString(),
      ctx.actor,
      ctx.tool,
      input.target.table,
      input.target.id,
      JSON.stringify(before),
      JSON.stringify(after),
      summary,
      input.undoOf ?? null,
    );

  try {
    await db.batch([...guards, ...writes, ...(input.extra ?? []), audit, db.prepare("DELETE FROM write_guard")]);
  } catch (error) {
    if (isGuardFailure(error)) {
      const { table, id } = input.target;
      const what = table === "settings" ? "The settings" : `${ROW_NOUNS[table]} ${id}`;
      throw new StaleWriteError(`${what} changed since you read it. Read it again and retry.`, { cause: error });
    }
    throw error;
  }
  return { changeId, summary };
}
