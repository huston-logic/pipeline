// The request's read memo (decision 0044, "D1 calls"): propose_changes and apply_changes plan up to
// PROPOSAL_MAX_ACTIONS actions through the ordinary services, and every service reads the same settings-like tables
// again (the timezone, time tracking, stages, status labels, field definitions, work types). With `ctx.memo` set,
// those reads come from one snapshot, read in one D1 batch the first time any of them is needed, and kept for that
// request only. Without it (the board, the hourly run, a direct record tool) every helper reads the database as before.
// Record rows (contacts, deals, tasks, time entries) are never kept here: they go through lookup.ts and the plan.
// A plan never writes these tables (PlanCollector refuses a change to one while a memo is set), so the snapshot can't
// go stale inside a plan.
import type { Db, FieldDefRow, FieldEntity, PersonStatusRow, PersonSubstatusRow, SettingsRow, StageRow, WorkTypeRow } from "../db/db.ts";
import { getSettings, listFieldDefs, listStages } from "../db/queries.ts";
import type { ChangeTable } from "./change.ts";

interface Snapshot {
  settings: SettingsRow | null;
  stages: StageRow[];
  statuses: PersonStatusRow[];
  subStatuses: PersonSubstatusRow[];
  fieldDefs: FieldDefRow[];
  workTypes: WorkTypeRow[];
}

/** The tables the memo holds. A planned change to one of them, while a memo is set, is a programming error. */
export const MEMO_TABLES: readonly ChangeTable[] = ["settings", "stages", "person_statuses", "person_substatuses", "field_defs", "work_types"];

/** Each table whole, in the order its own readers sort it, so a filter of it is what their query would answer. */
const SNAPSHOT_SQL = [
  "SELECT * FROM settings WHERE id = 1",
  "SELECT * FROM stages ORDER BY position, key",
  "SELECT * FROM person_statuses ORDER BY archived, position, key",
  "SELECT * FROM person_substatuses ORDER BY status_key, archived, position, key",
  "SELECT * FROM field_defs ORDER BY entity, created_at, rowid",
  "SELECT * FROM work_types ORDER BY position, created_at, id",
] as const;

export class ReadMemo {
  readonly #db: Db;
  #snapshot: Promise<Snapshot> | undefined;

  constructor(db: Db) {
    this.#db = db;
  }

  async #load(): Promise<Snapshot> {
    const db = this.#db;
    const [settings, stages, statuses, subStatuses, fieldDefs, workTypes] = await db.batch(SNAPSHOT_SQL.map((sql) => db.prepare(sql)));
    return {
      settings: (settings?.results[0] as SettingsRow | undefined) ?? null,
      stages: (stages?.results ?? []) as StageRow[],
      statuses: (statuses?.results ?? []) as PersonStatusRow[],
      subStatuses: (subStatuses?.results ?? []) as PersonSubstatusRow[],
      fieldDefs: (fieldDefs?.results ?? []) as FieldDefRow[],
      workTypes: (workTypes?.results ?? []) as WorkTypeRow[],
    };
  }

  /** One part of the snapshot, as a copy: a caller that changes what it got can't change what the next one gets. */
  async get<K extends keyof Snapshot>(key: K): Promise<Snapshot[K]> {
    this.#snapshot ??= this.#load();
    return structuredClone((await this.#snapshot)[key]);
  }
}

/** Where a settings-like read goes: a database, or a ctx that may carry a memo. */
export type Reader = Db | { db: Db; memo?: ReadMemo | undefined };

export function readerOf(src: Reader): { db: Db; memo: ReadMemo | undefined } {
  return "prepare" in src ? { db: src, memo: undefined } : { db: src.db, memo: src.memo };
}

export async function settingsRow(src: Reader): Promise<SettingsRow> {
  const { db, memo } = readerOf(src);
  if (memo === undefined) return getSettings(db);
  const row = await memo.get("settings");
  if (!row) throw new Error("The settings row is missing. Load seed/defaults.sql into the database.");
  return row;
}

/** Stages by position, archived ones only when asked (listStages). */
export async function stageRows(src: Reader, options: { includeArchived?: boolean } = {}): Promise<StageRow[]> {
  const { db, memo } = readerOf(src);
  if (memo === undefined) return listStages(db, options);
  const all = await memo.get("stages");
  return options.includeArchived ? all : all.filter((row) => row.archived === 0);
}

/** Custom field definitions in the order they were added (listFieldDefs). */
export async function fieldDefRows(src: Reader, options: { entity?: FieldEntity; includeArchived?: boolean } = {}): Promise<FieldDefRow[]> {
  const { db, memo } = readerOf(src);
  if (memo === undefined) return listFieldDefs(db, options);
  return (await memo.get("fieldDefs")).filter(
    (row) => (options.entity === undefined || row.entity === options.entity) && (options.includeArchived === true || row.archived === 0),
  );
}

/** Every person status, live ones first in board order. */
export async function personStatusRows(src: Reader): Promise<PersonStatusRow[]> {
  const { db, memo } = readerOf(src);
  if (memo !== undefined) return memo.get("statuses");
  return (await db.prepare(SNAPSHOT_SQL[2]).all<PersonStatusRow>()).results;
}

/** Every sub-status (or one status's), by status, live ones first in board order. */
export async function subStatusRows(src: Reader, statusKey?: string): Promise<PersonSubstatusRow[]> {
  const { db, memo } = readerOf(src);
  if (memo !== undefined) {
    const all = await memo.get("subStatuses");
    return statusKey === undefined ? all : all.filter((row) => row.status_key === statusKey);
  }
  const sql = "SELECT * FROM person_substatuses";
  const order = " ORDER BY status_key, archived, position, key";
  const found =
    statusKey === undefined
      ? await db.prepare(sql + order).all<PersonSubstatusRow>()
      : await db.prepare(`${sql} WHERE status_key = ?${order}`).bind(statusKey).all<PersonSubstatusRow>();
  return found.results;
}

/** The live work types in list order. */
export async function liveWorkTypeRows(src: Reader): Promise<WorkTypeRow[]> {
  const { db, memo } = readerOf(src);
  if (memo !== undefined) return (await memo.get("workTypes")).filter((row) => row.archived === 0);
  return (await db.prepare("SELECT * FROM work_types WHERE archived = 0 ORDER BY position, created_at, id").all<WorkTypeRow>()).results;
}

/** A work type by id, archived ones too, from the memo; undefined without one (the caller reads the database). */
export async function memoWorkType(src: Reader, id: string): Promise<WorkTypeRow | null | undefined> {
  const { memo } = readerOf(src);
  if (memo === undefined) return undefined;
  return (await memo.get("workTypes")).find((row) => row.id === id) ?? null;
}
