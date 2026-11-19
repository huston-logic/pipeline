// TEST-ONLY: a small D1-compatible database over node:sqlite, so unit tests run the real SQL without wrangler.
// It covers the D1 API the code uses (prepare, bind, first, all, run, raw, batch) and behaves like D1 where that
// matters: foreign keys on, atomic batches, lazy statement errors as "D1_ERROR: ...", D1_TYPE_ERROR on bad binds.
// Worker code must never import this file (eslint.config.mjs enforces it).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

type Row = Record<string, unknown>;
type Executed = { rows: Row[]; columns: () => string[]; meta: D1Meta & Record<string, unknown> };

function toSqlValue(value: unknown): SQLInputValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return value;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error(`D1_TYPE_ERROR: Type '${typeof value}' not supported for value '${String(value)}'`);
}

function asD1Error(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("D1_") ? (error as Error) : new Error(`D1_ERROR: ${message}`, { cause: error });
}

export class SqliteStatement {
  readonly database: SqliteD1;
  readonly sql: string;
  readonly params: SQLInputValue[];

  constructor(database: SqliteD1, sql: string, params: SQLInputValue[] = []) {
    this.database = database;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.database, this.sql, values.map(toSqlValue));
  }

  first<T = unknown>(colName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  async first<T>(colName?: string): Promise<T | null> {
    const [row] = this.database.execute(this).rows;
    if (!row) return null;
    if (colName === undefined) return row as T;
    if (!(colName in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${colName})`);
    return row[colName] as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const { rows, meta } = this.database.execute(this);
    return { success: true, meta, results: rows as T[] };
  }

  run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.all<T>();
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const { rows, columns } = this.database.execute(this);
    const values = rows.map((row) => Object.values(row) as T);
    return options?.columnNames ? [columns(), ...values] : values;
  }
}

export class SqliteD1 {
  readonly #db: DatabaseSync;

  constructor(path = ":memory:") {
    this.#db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    this.#db.exec("PRAGMA foreign_keys = ON");
  }

  prepare(query: string): SqliteStatement {
    return new SqliteStatement(this, query);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const own = statements.map((statement) => {
      if (!(statement instanceof SqliteStatement) || statement.database !== this) {
        throw new Error("D1_ERROR: batch() takes statements prepared on the same database.");
      }
      return statement;
    });
    this.#db.exec("BEGIN");
    try {
      const results = own.map((statement): D1Result<T> => {
        const { rows, meta } = this.execute(statement);
        return { success: true, meta, results: rows as T[] };
      });
      this.#db.exec("COMMIT");
      return results;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Runs a whole SQL script (migrations, seed files). Not part of the D1 API the Worker uses. */
  exec(sql: string): void {
    try {
      this.#db.exec(sql);
    } catch (error) {
      throw asD1Error(error);
    }
  }

  /** @internal Used by SqliteStatement. */
  execute(statement: SqliteStatement): Executed {
    const started = performance.now();
    try {
      const prepared = this.#db.prepare(statement.sql);
      const before = this.#totalChanges();
      const rows = prepared.all(...statement.params).map((row) => ({ ...row }));
      const changes = this.#totalChanges() - before;
      const lastRowId = Number(this.#db.prepare("SELECT last_insert_rowid() AS id").get()?.id ?? 0);
      return {
        rows,
        columns: () => prepared.columns().map((column) => column.name),
        meta: {
          duration: performance.now() - started,
          size_after: 0,
          rows_read: rows.length,
          rows_written: changes,
          last_row_id: lastRowId,
          changed_db: changes > 0,
          changes,
        },
      };
    } catch (error) {
      throw asD1Error(error);
    }
  }

  #totalChanges(): number {
    return Number(this.#db.prepare("SELECT total_changes() AS n").get()?.n ?? 0);
  }
}

export type MigrationFile = { number: number; name: string; path: string };

/** migrations/*.sql in the order wrangler applies them. */
export function migrationFiles(): MigrationFile[] {
  const dir = join(ROOT, "migrations");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => {
      const match = MIGRATION_FILE.exec(name);
      if (!match) throw new Error(`migrations/${name} must be named NNNN_lowercase_words.sql.`);
      return { number: Number(match[1]), name, path: join(dir, name) };
    })
    .sort((a, b) => a.number - b.number);
}

/**
 * Applies the migrations not yet applied, up to and including number `upTo`, each in its own transaction, and
 * records them in d1_migrations the way `wrangler d1 migrations apply` does. Returns the names it applied.
 */
export async function applyMigrations(db: SqliteD1, upTo = Infinity): Promise<string[]> {
  db.exec(`CREATE TABLE IF NOT EXISTS d1_migrations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);
  const done = new Set(
    (await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>()).results.map((row) => row.name),
  );
  const applied: string[] = [];
  for (const file of migrationFiles()) {
    if (file.number > upTo || done.has(file.name)) continue;
    const record = `INSERT INTO d1_migrations (name) VALUES ('${file.name}');`;
    db.exec("BEGIN");
    try {
      db.exec(`${readFileSync(file.path, "utf8")}\n${record}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    applied.push(file.name);
  }
  return applied;
}

/** Runs a SQL file given relative to the repo root, for example "seed/defaults.sql". */
export function applySqlFile(db: SqliteD1, path: string): void {
  db.exec(readFileSync(join(ROOT, path), "utf8"));
}

/** A fresh in-memory database with every migration and seed/defaults.sql, with exec() for extra test SQL. */
export async function createTestDb(): Promise<SqliteD1> {
  const db = new SqliteD1();
  await applyMigrations(db);
  applySqlFile(db, "seed/defaults.sql");
  return db;
}

/** A fresh in-memory database with every migration and seed/defaults.sql. */
export async function openTestDb(): Promise<Db> {
  return createTestDb();
}
