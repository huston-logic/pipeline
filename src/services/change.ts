// The one way the services write: every change is a single D1 batch holding the row writes, any extra statements,
// and its audit_log row. Updates and deletes are guarded by write_guard (see migrations/0001_init.sql), so a row that
// changed after it was read aborts the whole batch. Decision 0009 describes the snapshot format and undo; decision
// 0035 the bulk form, which writes a change of any size set by set and keeps its snapshot in audit_parts.
import type { Actor, AuditPartRow, AuditRow, Db, TableName } from "../db/db.ts";
import { newId } from "../ids.ts";
import { CHUNK_BYTES, chunkBy, sqlBytes } from "./bulk.ts";
import { UserError } from "./errors.ts";
import type { ReadMemo } from "./memo.ts";
import type { PlanCollector } from "./plan.ts";

export type { Actor };

export interface Ctx {
  db: Db;
  now: Date;
  actor: Actor;
  /** The tool or job making the change, for example "add_lead", "undo_change" or "rules_cron". */
  tool: string;
  /** Collect mode (decision 0044): commitChange records the change here instead of writing it. */
  plan?: PlanCollector;
  /** A proposal's request memo (memo.ts): the settings-like reads, read once for the whole request. */
  memo?: ReadMemo;
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
  push_subscriptions: "id",
  person_statuses: "key",
  person_substatuses: "id",
  views: "id",
  work_types: "id",
  client_rates: "id",
  time_entries: "id",
  project_statuses: "key",
  projects: "id",
  project_templates: "id",
  template_tasks: "id",
  campaigns: "id",
  campaign_steps: "id",
  email_suppressions: "id",
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
  /** Rows of one list item share a group (a task plan's tasks), so a proposal's list can show them as one item. Never written. */
  group?: string;
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
  /**
   * Like `extra`, but first in the batch, before the row writes: a guard of the caller's own (an import draft still
   * unapplied, decision 0036), so a lost race fails there with a StaleWriteError rather than on a row it would write.
   */
  leading?: D1PreparedStatement[];
  /** Set by undoChange, which needs the id before the batch is built. */
  changeId?: string;
  /** Set by undoChange: the change this one reverses. */
  undoOf?: string;
  /**
   * Write the rows set by set, whatever their number (decision 0035): one statement per table, operation and chunk of
   * at most CHUNK_BYTES, each with one bound JSON parameter, and the snapshot in audit_parts. Only tables with a
   * version column. The import uses it; so does an undo of a change that had parts or touched more than 50 rows.
   */
  bulk?: boolean;
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
  push_subscriptions: "Notifications on device",
  person_statuses: "Person status",
  person_substatuses: "Sub-status",
  views: "View",
  work_types: "Work type",
  client_rates: "Client rate",
  time_entries: "Time entry",
  project_statuses: "Project status",
  projects: "Project",
  project_templates: "Project template",
  template_tasks: "Template task",
  campaigns: "Campaign",
  campaign_steps: "Campaign email",
  email_suppressions: "Campaign email block",
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

/** A statement as SQL text and the values bound to its `?`s, before it is prepared on a database. */
export interface SqlStatement {
  sql: string;
  params: SqlValue[];
}

const cellOf = (row: Row, column: string): SqlValue => row[column] ?? null;

/** Fails the batch (write_guard's CHECK) unless the row is still exactly as `before` says. */
function guardStatement(table: ChangeTable, pk: string, before: Row): SqlStatement {
  const sql = "INSERT INTO write_guard (ok) SELECT COUNT(*) = 1 FROM";
  if (typeof before.version === "number") {
    return { sql: `${sql} ${table} WHERE ${pk} = ? AND version = ?`, params: [cellOf(before, pk), before.version] };
  }
  const columns = columnsOf(before);
  return {
    sql: `${sql} ${table} WHERE ${columns.map((column) => `${column} IS ?`).join(" AND ")}`,
    params: columns.map((column) => cellOf(before, column)),
  };
}

function writeStatement(table: ChangeTable, pk: string, change: RowChange): SqlStatement {
  const { before, after } = change;
  if (after === null) {
    return { sql: `DELETE FROM ${table} WHERE ${pk} = ?`, params: [before === null ? null : cellOf(before, pk)] };
  }
  const columns = columnsOf(after);
  if (before === null) {
    return {
      sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      params: columns.map((column) => cellOf(after, column)),
    };
  }
  const set = columns.filter((column) => column !== pk);
  return {
    sql: `UPDATE ${table} SET ${set.map((column) => `${column} = ?`).join(", ")} WHERE ${pk} = ?`,
    params: [...set.map((column) => cellOf(after, column)), cellOf(after, pk)],
  };
}

/** The error's message and those of every `cause` below it: D1 wraps the SQLite text in its own error. */
export function errorText(error: unknown): string {
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

/** A contact, deal or task whose id another write inserted first (two imports keeping one file's ids, decision 0037). */
export const isDuplicateIdFailure = (error: unknown) =>
  /UNIQUE constraint failed: (?:contacts|deals|tasks)\.id\b/.test(errorText(error));

/** A rule firing whose fire_key another run inserted first (two rule runs racing). */
export const isFireKeyFailure = (error: unknown) =>
  /UNIQUE constraint failed: rule_firings\.fire_key/.test(errorText(error));

/** A logged email whose message key another delivery stored first (decision 0031). */
export const isEmailLogKeyFailure = (error: unknown) =>
  /UNIQUE constraint failed: email_log\.message_key/.test(errorText(error));

/** A second running timer (the one-running index, migration 0018, decision 0049). */
export const isRunningTimerFailure = (error: unknown) =>
  /UNIQUE constraint failed: index 'time_entries_one_running'/.test(errorText(error));

/** A second live work type with the same name, or a second live client rate for one work type and person. */
export const isWorkTypeNameFailure = (error: unknown) => /UNIQUE constraint failed: index 'work_types_name'/.test(errorText(error));
/** A second live template with the same name (ignoring case). */
export const isTemplateNameFailure = (error: unknown) => /UNIQUE constraint failed: index 'project_templates_name'/.test(errorText(error));
export const isClientRatePairFailure =(error: unknown) =>
  /UNIQUE constraint failed: client_rates\.work_type_id, client_rates\.contact_id/.test(errorText(error));

/** A second live block on one address (an undo of clearing a block, after a newer block was made). */
export const isSuppressionEmailFailure = (error: unknown) => /UNIQUE constraint failed: email_suppressions\.email/.test(errorText(error));

/** A change as statements: the guards and row writes, then (after any extra statements) the audit row and cleanup. */
export interface BuiltChange {
  changeId: string;
  summary: string;
  writes: SqlStatement[];
  audit: SqlStatement[];
}

/**
 * The statements commitChange runs, without a database. The CSV import (scripts/import-csv.ts) renders them as a SQL
 * file, so an import is written exactly the way the services write.
 */
export function buildChange(ctx: Pick<Ctx, "now" | "actor" | "tool">, input: ChangeInput): BuiltChange {
  if (!isChangeTable(input.target.table)) {
    throw new Error(`A change can't target the table ${JSON.stringify(input.target.table)}.`);
  }
  if (input.bulk) return buildBulkChange(ctx, input);
  const seen = new Set<string>();
  const guards: SqlStatement[] = [];
  const writes: SqlStatement[] = [];
  const before: Record<string, Row | null> = {};
  const after: Record<string, Row | null> = {};
  for (const change of input.changes) {
    const { table, pk } = checkChange(change);
    const key = rowKey(table, change.id);
    if (seen.has(key)) throw new Error(`A change touches ${key} twice.`);
    seen.add(key);
    if (change.before) guards.push(guardStatement(table, pk, change.before));
    writes.push(writeStatement(table, pk, change));
    before[key] = change.before;
    after[key] = change.after;
  }

  const changeId = input.changeId ?? newId("chg");
  const summary = changeSummary(input, changeId);
  const audit: SqlStatement = {
    sql: `INSERT INTO audit_log (id, at, actor, tool, target_table, target_id, before_json, after_json, summary, undo_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
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
    ],
  };
  return { changeId, summary, writes: [...guards, ...writes], audit: [audit, CLEAR_GUARD] };
}

const CLEAR_GUARD: SqlStatement = { sql: "DELETE FROM write_guard", params: [] };

const changeSummary = (input: ChangeInput, changeId: string) => `${oneLine(input.summary)} (change ${changeId})`;

/**
 * The tables a bulk change may write (each has a version column, which its guards compare), in the order it inserts
 * them: parents before the rows that point at them. It deletes in the reverse order, children first.
 */
const BULK_ORDER: readonly ChangeTable[] = [
  "settings",
  "stages",
  "field_defs",
  "person_statuses",
  "person_substatuses",
  "contacts",
  "deals",
  "project_statuses",
  "projects",
  // Before the tasks and templates that name them (migration 0024).
  "work_types",
  "tasks",
  "activities",
  "project_templates",
  "template_tasks",
  "client_rates",
  // After the tasks and activities an entry points at.
  "time_entries",
  "campaigns",
  "campaign_steps",
  "email_suppressions",
  "rules",
  "rulebook",
  "push_subscriptions",
  "views",
];

/** A change touching more rows than this is written as a bulk change (decision 0035). */
const BULK_ROWS = 50;

/**
 * Bulk when the change has more than BULK_ROWS rows, or when its snapshot (before_json or after_json, each one bound
 * parameter of the audit row) would be over CHUNK_BYTES, measured as bulk.ts measures (decision 0035).
 */
export function needsBulk(changes: readonly RowChange[]): boolean {
  if (changes.length > BULK_ROWS) return true;
  const snapshot = (side: "before" | "after") => JSON.stringify(Object.fromEntries(changes.map((change) => [rowKey(change.table, change.id), change[side]])));
  return sqlBytes(snapshot("before")) > CHUNK_BYTES || sqlBytes(snapshot("after")) > CHUNK_BYTES;
}

export const isBulkTable =(table: ChangeTable) => BULK_ORDER.includes(table);

/** Rows of one table written by one statement shape: an insert or an update of the same columns. */
type BulkGroup = { table: ChangeTable; columns: string[]; rows: Row[] };

function addTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const byOrder = <T extends { table: ChangeTable }>(groups: Iterable<T>, reverse = false): T[] =>
  [...groups].sort((a, b) => (BULK_ORDER.indexOf(a.table) - BULK_ORDER.indexOf(b.table)) * (reverse ? -1 : 1));

/**
 * The bulk change's row statements (decision 0035), each with one JSON parameter of at most CHUNK_BYTES: the guards
 * (every row read must still have the version it was read at), then inserts parents first, updates, and deletes
 * children first. json_extract gives back each value with the type it had (text, integer, real or null).
 */
function bulkWrites(changes: readonly RowChange[], jsonOf: (row: Row) => Json): SqlStatement[] {
  const guards = new Map<ChangeTable, Row[]>();
  const inserts = new Map<string, BulkGroup>();
  const updates = new Map<string, BulkGroup>();
  const deletes = new Map<ChangeTable, Row[]>();
  for (const change of changes) {
    const { table } = change;
    if (!isBulkTable(table)) throw new Error(`A bulk change can only write tables with a version column; ${table} has none.`);
    const pk = PRIMARY_KEYS[table];
    const { before, after } = change;
    if (before) {
      if (typeof before.version !== "number") throw new Error(`A bulk change to ${table}:${change.id} needs the version it read.`);
      addTo(guards, table, { id: cellOf(before, pk), v: before.version });
    }
    if (after === null) {
      addTo(deletes, table, { id: before === null ? null : cellOf(before, pk) });
      continue;
    }
    const columns = columnsOf(after);
    const groups = before === null ? inserts : updates;
    const key = `${table} ${columns.join(",")}`;
    const group = groups.get(key) ?? { table, columns, rows: [] };
    group.rows.push(after);
    groups.set(key, group);
  }

  const statements: SqlStatement[] = [];
  const each = (rows: Row[], sql: (n: number) => string, item: (row: Row) => Json = jsonOf) => {
    for (const chunk of chunkBy(rows, (row) => item(row).bytes)) {
      statements.push({ sql: sql(chunk.length), params: [`[${chunk.map((row) => item(row).text).join(",")}]`] });
    }
  };
  const tables = (map: Map<ChangeTable, Row[]>) => [...map].map(([table, rows]) => ({ table, rows }));
  for (const { table, rows } of byOrder(tables(guards))) {
    const pk = PRIMARY_KEYS[table];
    each(
      rows,
      (n) =>
        `INSERT INTO write_guard (ok) SELECT COUNT(*) = ${n} FROM ${table} JOIN json_each(?) AS j ` +
        `ON ${table}.${pk} = json_extract(j.value, '$.id') AND ${table}.version = json_extract(j.value, '$.v')`,
    );
  }
  for (const { table, columns, rows } of byOrder(inserts.values())) {
    const values = columns.map((column) => `json_extract(j.value, '$.${column}')`).join(", ");
    each(rows, () => `INSERT INTO ${table} (${columns.join(", ")}) SELECT ${values} FROM json_each(?) AS j`);
  }
  for (const { table, columns, rows } of byOrder(updates.values())) {
    const pk = PRIMARY_KEYS[table];
    const set = columns.filter((column) => column !== pk).map((column) => `${column} = json_extract(j.value, '$.${column}')`);
    if (set.length === 0) throw new Error(`A bulk update of ${table} sets no columns.`);
    each(rows, () => `UPDATE ${table} SET ${set.join(", ")} FROM json_each(?) AS j WHERE ${table}.${pk} = json_extract(j.value, '$.${pk}')`);
  }
  for (const { table, rows } of byOrder(tables(deletes), true)) {
    const pk = PRIMARY_KEYS[table];
    each(rows, () => `DELETE FROM ${table} WHERE ${pk} IN (SELECT j.value FROM json_each(?) AS j)`, (row) => json(row.id));
  }
  return statements;
}

/** A value as JSON text, with its size as a SQL literal (sqlBytes). */
type Json = { text: string; bytes: number };

function json(value: unknown): Json {
  const text = JSON.stringify(value);
  return { text, bytes: sqlBytes(text) };
}

/** json() that works out each row once, since a row is both written and kept in the snapshot. */
function jsonCache(): (row: Row | null) => Json {
  const seen = new WeakMap<Row, Json>();
  const nullJson = json(null);
  return (row) => {
    if (row === null) return nullJson;
    let found = seen.get(row);
    if (found === undefined) {
      found = json(row);
      seen.set(row, found);
    }
    return found;
  };
}

type SnapshotEntry = { key: Json; before: Json; after: Json };

/**
 * The snapshot in parts of at most CHUNK_BYTES (both objects together), in write order. Each part is
 * `{"<table>:<id>": row | null}` for its rows, like before_json and after_json.
 */
function snapshotParts(entries: SnapshotEntry[]): { before: string; after: string }[] {
  // One entry is `"key":before,` in one object and `"key":after,` in the other. chunkBy counts one comma and one
  // pair of brackets, so the second comma is in `bytes` and the second pair of braces comes off the limit.
  const bytes = ({ key, before, after }: SnapshotEntry) => 2 * key.bytes + 2 + before.bytes + after.bytes + 1;
  return chunkBy(entries, bytes, CHUNK_BYTES - 2).map((chunk) => ({
    before: `{${chunk.map((entry) => `${entry.key.text}:${entry.before.text}`).join(",")}}`,
    after: `{${chunk.map((entry) => `${entry.key.text}:${entry.after.text}`).join(",")}}`,
  }));
}

function buildBulkChange(ctx: Pick<Ctx, "now" | "actor" | "tool">, input: ChangeInput): BuiltChange {
  const seen = new Set<string>();
  const entries: SnapshotEntry[] = [];
  const jsonOf = jsonCache();
  for (const change of input.changes) {
    const { table } = checkChange(change);
    const key = rowKey(table, change.id);
    if (seen.has(key)) throw new Error(`A change touches ${key} twice.`);
    seen.add(key);
    entries.push({ key: json(key), before: jsonOf(change.before), after: jsonOf(change.after) });
  }
  const writes = bulkWrites(input.changes, jsonOf);
  const parts = snapshotParts(entries);
  const changeId = input.changeId ?? newId("chg");
  const summary = changeSummary(input, changeId);
  const audit: SqlStatement = {
    sql: `INSERT INTO audit_log (id, at, actor, tool, target_table, target_id, before_json, after_json, summary, undo_of, parts)
       VALUES (?, ?, ?, ?, ?, ?, '{}', '{}', ?, ?, ?)`,
    params: [
      changeId,
      ctx.now.toISOString(),
      ctx.actor,
      ctx.tool,
      input.target.table,
      input.target.id,
      summary,
      input.undoOf ?? null,
      parts.length,
    ],
  };
  const partStatements = parts.map(
    (part, i): SqlStatement => ({
      sql: "INSERT INTO audit_parts (change_id, seq, before_json, after_json) VALUES (?, ?, ?, ?)",
      params: [changeId, i + 1, part.before, part.after],
    }),
  );
  return { changeId, summary, writes, audit: [audit, ...partStatements, CLEAR_GUARD] };
}

export type Snapshot = Record<string, Row | null>;

function parseSnapshot(json: string): Snapshot {
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Bad change snapshot.");
  return value as Snapshot;
}

/**
 * A change's snapshot, `{"<table>:<id>": row | null}` before and after it, in write order: from its audit_log row, or
 * for a change with parts (decision 0035) the union of its audit_parts rows in seq order.
 */
export async function readSnapshot(
  db: Db,
  audit: Pick<AuditRow, "id" | "before_json" | "after_json" | "parts">,
): Promise<{ before: Snapshot; after: Snapshot }> {
  const before = parseSnapshot(audit.before_json);
  const after = parseSnapshot(audit.after_json);
  if (!(audit.parts > 0)) return { before, after };
  const rows = await db
    .prepare("SELECT * FROM audit_parts WHERE change_id = ? ORDER BY seq")
    .bind(audit.id)
    .all<AuditPartRow>();
  if (rows.results.length !== audit.parts) throw new Error(`Change ${audit.id} is missing part of its snapshot.`);
  for (const part of rows.results) {
    Object.assign(before, parseSnapshot(part.before_json));
    Object.assign(after, parseSnapshot(part.after_json));
  }
  return { before, after };
}

const rowNoun = (table: ChangeTable, id: string) => (table === "settings" ? "The settings" : `${ROW_NOUNS[table]} ${id}`);

/**
 * The row a failed guard is about: the target when it was read first, else the one row that was (a change that adds
 * its target, such as a log that also moves a lead's status), else every record the change read. A bulk change
 * guards its rows together, so with more than one row read it can't say which one moved.
 */
function staleRow(input: ChangeInput): string {
  const { table, id } = input.target;
  const read = input.changes.filter((change) => change.before !== null);
  if (input.bulk && read.length > 1) return "A record this change touches";
  if (read.length === 0 || read.some((change) => change.table === table && change.id === id)) return rowNoun(table, id);
  const [only, ...others] = read;
  return only && others.length === 0 ? rowNoun(only.table, only.id) : "A record this change touches";
}

/**
 * The one batch commitChange runs, prepared on ctx.db: the caller's leading guards, the row guards and writes, the
 * extra statements, then the audit rows. A proposal's trial (decision 0044) runs exactly these.
 */
export function changeBatch(
  ctx: Pick<Ctx, "db" | "now" | "actor" | "tool">,
  input: ChangeInput,
): { changeId: string; summary: string; statements: D1PreparedStatement[] } {
  const { db } = ctx;
  const { changeId, summary, writes, audit } = buildChange(ctx, input);
  const prepare = ({ sql, params }: SqlStatement) =>
    params.length === 0 ? db.prepare(sql) : db.prepare(sql).bind(...params);
  const statements = [...(input.leading ?? []), ...writes.map(prepare), ...(input.extra ?? []), ...audit.map(prepare)];
  return { changeId, summary, statements };
}

/**
 * What a guard statement a service puts in `extra` is for: why it exists, in a few plain words (for a refusal that
 * names it), and the record ids it is bound to (so a proposal's apply can tell it isn't bound to an id it swaps).
 */
const GUARDS = new WeakMap<D1PreparedStatement, { reason: string; ids: readonly string[] }>();

export function withGuardReason(statement: D1PreparedStatement, reason: string, ids: readonly string[]): D1PreparedStatement {
  GUARDS.set(statement, { reason, ids: [...ids] });
  return statement;
}

export const guardReason = (statement: D1PreparedStatement): string | undefined => GUARDS.get(statement)?.reason;

/** The record ids a statement is bound to, when its service said so; undefined when unknown. */
export const guardIds = (statement: D1PreparedStatement): readonly string[] | undefined => GUARDS.get(statement)?.ids;

export async function commitChange(ctx: Ctx, input: ChangeInput): Promise<ChangeResult> {
  if (ctx.plan !== undefined) return ctx.plan.record(ctx, input);
  const { db } = ctx;
  const { changeId, summary, statements } = changeBatch(ctx, input);
  try {
    await db.batch(statements);
  } catch (error) {
    if (isGuardFailure(error)) {
      throw new StaleWriteError(`${staleRow(input)} changed since you read it. Read it again and retry.`, { cause: error });
    }
    throw error;
  }
  return { changeId, summary };
}
