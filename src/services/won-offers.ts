// The Won question (decision 0055): when an applied change marks a deal Won and projects are on, the AI app is told to
// ask the owner whether to start a project, with the exact call to make on a yes. Names come through labels.ts, so no
// outside text is in the line.
import type { Db } from "../db/db.ts";
import { type RowChange, readSnapshot } from "./change.ts";
import { dealLabel } from "./labels.ts";
import { settingsRow } from "./memo.ts";

export interface StartProjectOffer {
  deal: string;
  line: string;
}

/** The deals a set of row changes moved to won: open (or lost, or not now) before, won after. */
export function wonDealIds(changes: readonly Pick<RowChange, "table" | "id" | "before" | "after">[]): string[] {
  return changes.flatMap((change) =>
    change.table === "deals" && change.before !== null && change.before.status !== "won" && change.after?.status === "won" ? [change.id] : [],
  );
}

/** The deals a stored change moved to won, from its audit snapshot. */
export async function wonDealsOfChange(db: Db, changeId: string): Promise<string[]> {
  const audit = await db
    .prepare("SELECT id, before_json, after_json, parts FROM audit_log WHERE id = ?")
    .bind(changeId)
    .first<{ id: string; before_json: string; after_json: string; parts: number }>();
  if (audit === null) return [];
  const { before, after } = await readSnapshot(db, audit);
  return Object.entries(after).flatMap(([key, row]) => {
    const [table = "", id = ""] = key.split(/:(.*)/s);
    return table === "deals" && before[key] != null && before[key]?.status !== "won" && row?.status === "won" ? [id] : [];
  });
}

const placeholders = (ids: readonly string[]) => ids.map(() => "?").join(", ");

/**
 * One offer per deal with no unarchived project, while projects are on; none otherwise. Each line says what to ask and
 * which call to make on a yes, with the number of open tasks moveOpenTasks would move.
 */
export async function startProjectOffers(db: Db, dealIds: readonly string[]): Promise<StartProjectOffer[]> {
  if (dealIds.length === 0 || (await settingsRow(db)).projects !== 1) return [];
  const ids = [...dealIds];
  const [deals, projects, tasks] = await db.batch<Record<string, unknown>>([
    db
      .prepare(`SELECT d.*, c.name AS person_name, c.untrusted_fields AS person_untrusted FROM deals d JOIN contacts c ON c.id = d.contact_id WHERE d.id IN (${placeholders(ids)})`)
      .bind(...ids),
    db.prepare(`SELECT DISTINCT deal_id FROM projects WHERE archived = 0 AND deal_id IN (${placeholders(ids)})`).bind(...ids),
    db
      .prepare(`SELECT deal_id, COUNT(*) AS open FROM tasks WHERE done_at IS NULL AND deal_id IN (${placeholders(ids)}) GROUP BY deal_id`)
      .bind(...ids),
  ]);
  const covered = new Set((projects?.results ?? []).map((row) => String(row.deal_id)));
  const open = new Map((tasks?.results ?? []).map((row) => [String(row.deal_id), Number(row.open)]));
  const found = new Map((deals?.results ?? []).map((row) => [String(row.id), row]));
  return ids.flatMap((id) => {
    const row = found.get(id);
    if (row === undefined || covered.has(id)) return [];
    const person = { id: String(row.contact_id), name: String(row.person_name), untrusted_fields: row.person_untrusted };
    const n = open.get(id) ?? 0;
    const moves = n === 0 ? "" : ` (moveOpenTasks true also moves its ${n} open task${n === 1 ? "" : "s"})`;
    const label = dealLabel({ id, title: String(row.title), untrusted_fields: row.untrusted_fields }, person);
    return [{ deal: id, line: `Ask the owner: start a project for ${label}? If yes, propose add_project with deal ${id}${moves}.` }];
  });
}
