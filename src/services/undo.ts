// undo_change: reverses exactly one change by writing its `before` snapshot back, as a new audited change. It
// refuses when the change is unknown, already undone, itself an undo, when a row it would delete now has other
// records pointing at it (by foreign key or by key inside a JSON column), when putting back a field's choices would
// drop one records use, or when any row it touched is no longer exactly as the change left it. Decision 0009.
import type { AuditRow, RuleType } from "../db/db.ts";
import { newId } from "../ids.ts";
import {
  type ChangeResult,
  type ChangeTable,
  changedColumns,
  commitChange,
  type Ctx,
  isChangeTable,
  isForeignKeyFailure,
  primaryKey,
  type Row,
  type RowChange,
  rowKey,
  StaleWriteError,
} from "./change.ts";
import { capitalize, columnLabel, dealTitleOf, joinAnd, rowLabel, short } from "./describe.ts";
import { UserError } from "./errors.ts";
import { parseStringArray, stageLabels } from "./lookup.ts";
import { resumedParams } from "./rules.ts";

type Entry = { table: ChangeTable; id: string; before: Row | null; after: Row | null };

/** Rows that point at a row of each table, so deleting it would break them. ON DELETE SET NULL links are left out. */
const DEPENDENTS: Partial<Record<ChangeTable, { table: ChangeTable; column: string; one: string; many: string }[]>> = {
  contacts: [
    { table: "deals", column: "contact_id", one: "deal", many: "deals" },
    { table: "activities", column: "contact_id", one: "activity", many: "activities" },
    { table: "tasks", column: "contact_id", one: "task", many: "tasks" },
  ],
  deals: [
    { table: "activities", column: "deal_id", one: "activity", many: "activities" },
    { table: "tasks", column: "deal_id", one: "task", many: "tasks" },
    { table: "rule_firings", column: "deal_id", one: "rule firing", many: "rule firings" },
  ],
  stages: [{ table: "deals", column: "stage_key", one: "deal", many: "deals" }],
  rules: [{ table: "rule_firings", column: "rule_id", one: "rule firing", many: "rule firings" }],
};

/**
 * Rows that name a row inside a JSON column rather than through a foreign key: a custom field's key in the `fields` of
 * contacts or deals, a stage's key in `rules.params`. Removing the row would leave them pointing at nothing (or, for a
 * field, let a later field reuse the key and inherit the old values). `equals` absent means "any value at that path".
 */
type JsonRef = {
  table: "contacts" | "deals" | "rules";
  column: string;
  path: string;
  equals?: string;
  what: (labels: string, n: number) => string;
};

const JSON_DEPENDENTS: Partial<Record<ChangeTable, (row: Row) => JsonRef[]>> = {
  field_defs: (row) => [
    {
      table: row.entity === "contact" ? "contacts" : "deals",
      column: "fields",
      path: `$."${String(row.key)}"`,
      what: (labels) => `${short(String(row.label), 60)} is set on ${labels}`,
    },
  ],
  stages: (row) => [
    {
      table: "rules",
      column: "params",
      path: "$.stage",
      equals: String(row.key),
      what: (labels, n) => `${labels} ${n === 1 ? "watches" : "watch"} ${short(String(row.label), 60)}`,
    },
  ],
};

const SHOWN_LABELS = 5;

/** A rule by id (its id is what update_rule takes); other rows by their safe label. */
const refLabel = (table: JsonRef["table"], row: Row) => (table === "rules" ? `rule ${String(row.id)}` : rowLabel(table, row));

function labelList(labels: string[]): string {
  if (labels.length <= SHOWN_LABELS) return joinAnd(labels);
  return `${labels.slice(0, SHOWN_LABELS).join(", ")} and ${labels.length - SHOWN_LABELS} more`;
}

/** Columns that change as a side effect of the ones the owner set; an undo summary doesn't list them. */
const BOOKKEEPING = new Set([
  "version",
  "updated_at",
  "created_at",
  "last_activity_at",
  "stage_entered_at",
  "status",
  "untrusted_fields",
]);

function parseSnapshot(json: string): Record<string, Row | null> {
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Bad change snapshot.");
  return value as Record<string, Row | null>;
}

function entriesOf(audit: AuditRow): Entry[] {
  const before = parseSnapshot(audit.before_json);
  const after = parseSnapshot(audit.after_json);
  return Object.keys(after).map((key) => {
    const split = key.indexOf(":");
    const table = key.slice(0, split);
    if (split < 1 || !isChangeTable(table)) throw new Error(`Change ${audit.id} names an unknown row ${key}.`);
    return { table, id: key.slice(split + 1), before: before[key] ?? null, after: after[key] ?? null };
  });
}

const sameRow = (current: Row | null, expected: Row | null) =>
  expected === null
    ? current === null
    : current !== null && Object.keys(expected).every((column) => current[column] === expected[column]);

const dependsMessage = (changeId: string, what: string) =>
  `Can't undo ${changeId}: other records now depend on it (${what}). Change those first, or leave it.`;

const alreadyUndone = (changeId: string, audit: AuditRow) =>
  `${changeId} was already undone (by ${audit.undone_by ?? "an earlier undo"}). Nothing to do.`;

const changedMessage = (changeId: string, what: string) =>
  `Can't undo ${changeId}: ${what} changed since (see recent_changes). Undo the later changes first, or leave it.`;

/**
 * A rule firing keeps firing idempotent, so the deal or rule it names can never be removed again (decision 0010).
 * The refusal says what to do instead of "change those first", which the owner can't do for a firing.
 */
function ruleHistoryMessage(changeId: string, entry: Entry): string {
  const row = entry.after ?? {};
  if (entry.table === "rules") {
    return `Can't undo ${changeId}: rule ${entry.id} has already fired, so it can't be removed. Pause it with pause_rule instead.`;
  }
  return (
    `Can't undo ${changeId}: this lead has rule history (a rule already fired on ${rowLabel("deals", row)}), so it can't ` +
    "be removed. Close the deal instead: update_deal with status lost or not_now."
  );
}

async function dependents(ctx: Ctx, changeId: string, entries: Entry[]): Promise<string | null> {
  const deleting = entries.filter((entry) => entry.before === null);
  const removed = new Set(deleting.map((entry) => rowKey(entry.table, entry.id)));
  const counts = new Map<string, { n: number; one: string; many: string }>();
  for (const entry of deleting) {
    const pkValue = entry.after?.[primaryKey(entry.table)];
    for (const dep of DEPENDENTS[entry.table] ?? []) {
      const rows = await ctx.db
        .prepare(`SELECT id FROM ${dep.table} WHERE ${dep.column} = ?`)
        .bind(pkValue)
        .all<{ id: string }>();
      if (dep.table === "rule_firings" && rows.results.length > 0) {
        throw new UserError(ruleHistoryMessage(changeId, entry));
      }
      for (const row of rows.results) {
        const key = rowKey(dep.table, row.id);
        if (removed.has(key)) continue;
        removed.add(key);
        const tally = counts.get(dep.one) ?? { n: 0, one: dep.one, many: dep.many };
        tally.n += 1;
        counts.set(dep.one, tally);
      }
    }
  }
  const tallies = [...counts.values()].map((t) => `${t.n} ${t.n === 1 ? t.one : t.many}`);
  const parts = tallies.length === 0 ? [] : [joinAnd(tallies)];
  for (const entry of deleting) {
    if (entry.after === null) continue;
    for (const ref of JSON_DEPENDENTS[entry.table]?.(entry.after) ?? []) {
      const found = await jsonReferrers(ctx, ref, removed);
      if (found.length > 0) parts.push(ref.what(labelList(found.map((row) => refLabel(ref.table, row))), found.length));
    }
  }
  parts.push(...(await choicesInUse(ctx, removed, updatesOf(entries))));
  return parts.length === 0 ? null : parts.join("; ");
}

/** Rows of `ref.table` (other than ones this undo removes) whose JSON column holds the reference. */
async function jsonReferrers(ctx: Ctx, ref: JsonRef, removed: Set<string>): Promise<Row[]> {
  const test = ref.equals === undefined ? "IS NOT NULL" : "= ?";
  const params = ref.equals === undefined ? [ref.path] : [ref.path, ref.equals];
  const rows = await ctx.db
    .prepare(`SELECT * FROM ${ref.table} WHERE json_extract(${ref.column}, ?) ${test} ORDER BY created_at, id`)
    .bind(...params)
    .all<Row>();
  return rows.results.filter((row) => !removed.has(rowKey(ref.table, String(row.id))));
}

const updatesOf = (entries: Entry[]) => entries.filter((entry) => entry.before !== null && entry.after !== null);

const choiceList = (row: Row): string[] => (typeof row.choices === "string" ? parseStringArray(row.choices) : []);

/** Putting back a field's earlier choices would drop a choice records now use (an undo of update_field). */
async function choicesInUse(ctx: Ctx, removed: Set<string>, updates: Entry[]): Promise<string[]> {
  const parts: string[] = [];
  for (const { table, before, after } of updates) {
    if (table !== "field_defs" || before === null || after === null) continue;
    const restored = new Set(choiceList(before));
    const [ref] = JSON_DEPENDENTS.field_defs?.(after) ?? [];
    if (!ref) continue;
    for (const choice of choiceList(after).filter((c) => !restored.has(c))) {
      const users = await jsonReferrers(ctx, { ...ref, equals: choice }, removed);
      if (users.length === 0) continue;
      const labels = labelList(users.map((row) => refLabel(ref.table, row)));
      parts.push(`the choice ${choice} of ${short(String(after.label), 60)} is used by ${labels}`);
    }
  }
  return parts;
}

/** "Moved "Website refresh" back to Replied", "Removed contact Pat Example and deal "Website refresh"", ... */
function describeUndo(entries: Entry[], labels: Map<string, string>): string {
  const removed: string[] = [];
  const parts: string[] = [];
  for (const { table, before, after } of entries) {
    if (before === null && after !== null) {
      if (!(table === "activities" && after.type === "stage_change")) removed.push(rowLabel(table, after));
    } else if (before !== null && after === null) {
      parts.push(`restored ${rowLabel(table, before)}`);
    } else if (before !== null && after !== null) {
      let columns = changedColumns(before, after).filter((c) => !BOOKKEEPING.has(c));
      if (table === "deals" && columns.includes("stage_key")) {
        const stage = String(before.stage_key);
        parts.push(`moved ${dealTitleOf(before)} back to ${labels.get(stage) ?? stage}`);
        columns = columns.filter((c) => c !== "stage_key");
      }
      if (columns.length > 0) {
        parts.push(`put back the earlier ${joinAnd(columns.map(columnLabel))} on ${rowLabel(table, before)}`);
      }
    }
  }
  if (removed.length > 0) parts.unshift(`removed ${joinAnd(removed)}`);
  return capitalize(parts.join("; ") || "put back the earlier values");
}

export async function undoChange(ctx: Ctx, changeId: string): Promise<ChangeResult> {
  const { db } = ctx;
  const id = changeId.trim();
  const original = await db.prepare("SELECT * FROM audit_log WHERE id = ?").bind(id).first<AuditRow>();
  if (!original) throw new UserError(`There's no change ${id}. Use recent_changes to find the change id.`);
  if (original.undo_of !== null) throw new UserError("Undo entries can't be undone; make the change again instead.");
  if (original.undone_at !== null) throw new UserError(alreadyUndone(id, original));
  if (!isChangeTable(original.target_table)) throw new Error(`Change ${id} targets an unknown table.`);

  const entries = entriesOf(original);
  const current = new Map<Entry, Row | null>();
  for (const entry of entries) {
    const pk = primaryKey(entry.table);
    const pkValue = (entry.after ?? entry.before)?.[pk];
    current.set(
      entry,
      await db.prepare(`SELECT * FROM ${entry.table} WHERE ${pk} = ?`).bind(pkValue).first<Row>(),
    );
  }

  const blockers = await dependents(ctx, id, entries);
  if (blockers !== null) throw new UserError(dependsMessage(id, blockers));
  const moved = entries.find((entry) => !sameRow(current.get(entry) ?? null, entry.after));
  if (moved) {
    const row = current.get(moved) ?? moved.after ?? moved.before;
    throw new UserError(changedMessage(id, row ? rowLabel(moved.table, row) : `${moved.table}:${moved.id}`));
  }

  const changes: RowChange[] = [...entries].reverse().map((entry) => {
    const now = current.get(entry) ?? null;
    let restored: Row | null = entry.before;
    if (restored !== null && now !== null) {
      restored = { ...restored };
      if (typeof now.version === "number") restored.version = now.version + 1;
      if ("updated_at" in restored) restored.updated_at = ctx.now.toISOString();
      if (entry.table === "rules" && restored.active === 1 && now.active === 0) {
        // An undone pause is a resume, with the same cut-over (decision 0010).
        restored.params = resumedParams({ type: restored.type as RuleType, params: String(restored.params) }, ctx.now);
      }
    }
    return { table: entry.table, id: entry.id, before: now, after: restored };
  });

  const undoId = newId("chg");
  const extra = [
    db.prepare("INSERT INTO write_guard (ok) SELECT COUNT(*) = 1 FROM audit_log WHERE id = ? AND undone_at IS NULL").bind(id),
    db.prepare("UPDATE audit_log SET undone_at = ?, undone_by = ? WHERE id = ?").bind(ctx.now.toISOString(), undoId, id),
  ];
  try {
    return await commitChange(ctx, {
      target: { table: original.target_table, id: original.target_id },
      summary: `Undid ${id}: ${describeUndo(entries, await stageLabels(db))}`,
      changes,
      extra,
      changeId: undoId,
      undoOf: id,
    });
  } catch (error) {
    if (error instanceof StaleWriteError) {
      // Another undo of this change may have won the race: say so instead of blaming a later edit.
      const latest = await db.prepare("SELECT * FROM audit_log WHERE id = ?").bind(id).first<AuditRow>();
      if (latest?.undone_at) throw new UserError(alreadyUndone(id, latest), { cause: error });
      throw new UserError(changedMessage(id, "a record it touched"), { cause: error });
    }
    if (isForeignKeyFailure(error)) throw new UserError(dependsMessage(id, "records added since"), { cause: error });
    throw error;
  }
}
