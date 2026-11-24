// Collect mode (decision 0044): with `ctx.plan` set, commitChange hands each service's ChangeInput to this collector
// instead of writing it, so a list of actions runs through the ordinary services and nothing reaches the database.
// The collector merges the inputs as one change would write them: each row once, with the `before` read from the
// database by the first action that touched it and the `after` the last action left, and the extra statements in
// order. The record services read a row the plan already has from here (lookup.ts), so an action sees what the earlier
// ones planned; a planned row's version is the database version + 1, the one bump the merged change makes.
import { newId } from "../ids.ts";
import type { ChangeInput, ChangeResult, ChangeTable, Ctx, Row, RowChange } from "./change.ts";
import { oneLine, rowKey } from "./change.ts";

type Entry = { table: ChangeTable; id: string; before: Row | null; after: Row | null };

export class PlanCollector {
  /** The one change id the apply will use, chg_... */
  readonly changeId: string = newId("chg");
  readonly #rows = new Map<string, Entry>();
  readonly #leading: D1PreparedStatement[] = [];
  readonly #extra: D1PreparedStatement[] = [];
  readonly #summaries: string[] = [];
  #target: { table: ChangeTable; id: string } | null = null;

  /** Called by commitChange when ctx.plan is set. */
  record(_ctx: Ctx, input: ChangeInput): ChangeResult {
    if (input.bulk || input.undoOf !== undefined) throw new Error("A bulk change or an undo can't be planned.");
    for (const change of input.changes) this.#merge(change);
    this.#leading.push(...(input.leading ?? []));
    this.#extra.push(...(input.extra ?? []));
    const summary = oneLine(input.summary);
    this.#summaries.push(summary);
    this.#target ??= input.target;
    return { changeId: this.changeId, summary: `${summary} (change ${this.changeId})` };
  }

  #merge(change: RowChange): void {
    const key = rowKey(change.table, change.id);
    const seen = this.#rows.get(key);
    if (seen === undefined) {
      this.#rows.set(key, { table: change.table, id: change.id, before: change.before, after: change.after });
      return;
    }
    // The write must have read the planned row, not the database's: otherwise an earlier action's edit would be lost.
    const version = seen.after?.version;
    if (change.before === null || typeof version !== "number" || change.before.version !== version) {
      throw new Error(`${key} was read from the database after an earlier action planned it.`);
    }
    seen.after = change.after === null ? null : { ...change.after, version };
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
