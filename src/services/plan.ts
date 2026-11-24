// Collect mode (decision 0044): with `ctx.plan` set, commitChange hands each service's ChangeInput to this collector
// instead of writing it, so a list of actions runs through the ordinary services and nothing reaches the database.
// The collector merges the inputs as one change would write them: each row once, with the `before` read from the
// database by the first action that touched it and the `after` the last action left, and the extra statements in
// order. The record services read a row the plan already has from here (lookup.ts), so an action sees what the earlier
// ones planned; a planned row's version is the database version + 1, the one bump the merged change makes.
import { newId } from "../ids.ts";
import type { ChangeInput, ChangeResult, ChangeTable, Ctx, Row, RowChange } from "./change.ts";
import { guardIds, oneLine, rowKey } from "./change.ts";
import { MEMO_TABLES } from "./memo.ts";

type Entry = { table: ChangeTable; id: string; before: Row | null; after: Row | null };

export class PlanCollector {
  /** The one change id the apply will use, chg_... */
  readonly changeId: string = newId("chg");
  readonly #rows = new Map<string, Entry>();
  readonly #leading: D1PreparedStatement[] = [];
  readonly #extra: D1PreparedStatement[] = [];
  /** The action number each extra (and leading) statement came from, in step with #extra (#leading). */
  readonly #extraSources: number[] = [];
  readonly #leadingSources: number[] = [];
  /** The action that added each row the plan adds, by id. */
  readonly #addedBy = new Map<string, number>();
  /** The actions that wrote each row, by row key, in order. */
  readonly #writtenBy = new Map<string, number[]>();
  readonly #summaries: string[] = [];
  #target: { table: ChangeTable; id: string } | null = null;
  #action = 0;

  /** Says which action (1-based) the next changes come from, so a failing extra statement can be traced to it. */
  startAction(n: number): void {
    this.#action = n;
  }

  /** The action number each of build()'s extra statements came from, in the same order. */
  extraSources(): number[] {
    return [...this.#extraSources];
  }

  /**
   * Apply swaps the fresh plan's new ids for the ones the list showed (`ids`: fresh id -> shown id), in the rows only.
   * A leading or extra statement is already bound, so it must not be bound to a swapped id: one whose service declared
   * its ids (withGuardReason) is checked against them; one that didn't may not come from an action that added a
   * swapped row. Breaking this is a programming error (decision 0044), so it throws a plain Error.
   */
  checkShownIds(ids: ReadonlyMap<string, string>): void {
    const swapped = new Set([...ids].filter(([fresh, shown]) => fresh !== shown).map(([fresh]) => fresh));
    if (swapped.size === 0) return;
    const statements = [
      ...this.#leading.map((statement, i) => ({ statement, source: this.#leadingSources[i] ?? 0 })),
      ...this.#extra.map((statement, i) => ({ statement, source: this.#extraSources[i] ?? 0 })),
    ];
    for (const { statement, source } of statements) {
      const bound = guardIds(statement);
      const hit = bound?.find((id) => swapped.has(id));
      if (hit !== undefined) throw new Error(`A statement of action ${source} is bound to ${hit}, an id the apply swaps.`);
      if (bound === undefined && [...swapped].some((id) => this.#addedBy.get(id) === source)) {
        throw new Error(`A statement of action ${source} doesn't say what it is bound to, and action ${source} adds a row whose id the apply swaps.`);
      }
    }
  }

  /** Called by commitChange when ctx.plan is set. */
  record(ctx: Ctx, input: ChangeInput): ChangeResult {
    if (input.bulk || input.undoOf !== undefined) throw new Error("A bulk change or an undo can't be planned.");
    // The request memo (memo.ts) holds these tables for the whole plan: a planned write to one would leave it stale.
    const memoized = ctx.memo === undefined ? undefined : input.changes.find((change) => MEMO_TABLES.includes(change.table));
    if (memoized !== undefined) throw new Error(`A plan can't change ${memoized.table}: the request memo holds it.`);
    for (const change of input.changes) this.#merge(change);
    for (const statement of input.leading ?? []) {
      this.#leading.push(statement);
      this.#leadingSources.push(this.#action);
    }
    for (const statement of input.extra ?? []) {
      this.#extra.push(statement);
      this.#extraSources.push(this.#action);
    }
    const summary = oneLine(input.summary);
    this.#summaries.push(summary);
    this.#target ??= input.target;
    return { changeId: this.changeId, summary: `${summary} (change ${this.changeId})` };
  }

  #merge(change: RowChange): void {
    const key = rowKey(change.table, change.id);
    this.#writtenBy.set(key, [...(this.#writtenBy.get(key) ?? []), this.#action]);
    const seen = this.#rows.get(key);
    if (seen === undefined) {
      this.#rows.set(key, { table: change.table, id: change.id, before: change.before, after: change.after });
      if (change.before === null) this.#addedBy.set(change.id, this.#action);
      return;
    }
    // The write must have read the planned row, not the database's: otherwise an earlier action's edit would be lost.
    const version = seen.after?.version;
    if (change.before === null || typeof version !== "number" || change.before.version !== version) {
      throw new Error(`${key} was read from the database after an earlier action planned it.`);
    }
    seen.after = change.after === null ? null : { ...change.after, version };
  }

  /**
   * The first action after action `after` that wrote a row bound to one of `ids` (the row's id, or a column holding
   * one, as a deal's contact_id), or undefined when none did: which later action changes what a guard bound to `ids`
   * checks, read from the plan alone.
   */
  firstWriterAfter(after: number, ids: readonly string[]): number | undefined {
    const wanted = new Set(ids);
    let first: number | undefined;
    for (const [key, entry] of this.#rows) {
      const bound = [entry.id, ...Object.values(entry.before ?? {}), ...Object.values(entry.after ?? {})].some((value) => typeof value === "string" && wanted.has(value));
      if (!bound) continue;
      const writer = (this.#writtenBy.get(key) ?? []).find((action) => action > after);
      if (writer !== undefined && (first === undefined || writer < first)) first = writer;
    }
    return first;
  }

  /** The planned row (after every action so far), undefined when untouched, null when planned deleted. */
  row(table: ChangeTable, id: string): Row | null | undefined {
    return this.#rows.get(rowKey(table, id))?.after;
  }

  /** Planned rows of a table matching a predicate, for list reads such as a contact's open deals. */
  rows(table: ChangeTable, match: (row: Row) => boolean): Row[] {
    const out: Row[] = [];
    for (const entry of this.#rows.values()) if (entry.table === table && entry.after !== null && match(entry.after)) out.push(entry.after);
    return out;
  }

  /** "<table>:<id>" -> the version read from the database before the first planned write (null: inserted). */
  reads(): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const [key, entry] of this.#rows) {
      const version = entry.before?.version;
      out[key] = entry.before === null ? null : typeof version === "number" ? version : 0;
    }
    return out;
  }

  /** One ChangeInput: each row once, earliest `before`, latest `after`, version = before.version + 1; extras in order. */
  build(target: { table: ChangeTable; id: string }, summary: string): ChangeInput {
    const changes = [...this.#rows.values()].map(({ table, id, before, after }) => ({ table, id, before, after }));
    return { target, summary, changes, leading: [...this.#leading], extra: [...this.#extra] };
  }

  summaries(): string[] {
    return [...this.#summaries];
  }

  /** The first action's target, or null before any. */
  target(): { table: ChangeTable; id: string } | null {
    return this.#target;
  }
}
