// Finding people for a campaign's hand-picked list (decision 0053): a search of the people who are not archived, and the
// picked ones by id. Reads only; the list itself is written by updateCampaignDraft.
import type { Db } from "../db/db.ts";

export const PICK_LIMIT = 50;

export interface PickPerson {
  id: string;
  name: string;
  /** The row's untrusted_fields JSON. */
  untrusted_fields: string;
}

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Up to PICK_LIMIT people matching the words in name, email or company, leaving out `picked`, with how many match. */
export async function searchPeople(db: Db, query: string, picked: string[]): Promise<{ people: PickPerson[]; total: number }> {
  const text = query.trim();
  const match = text === "" ? "" : ` AND (${["name", "email", "business"].map((column) => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`;
  const params: unknown[] = [JSON.stringify(picked)];
  if (text !== "") params.push(...Array.from({ length: 3 }, () => `%${escapeLike(text)}%`));
  params.push(PICK_LIMIT);
  const found = await db
    .prepare(
      `SELECT id, name, untrusted_fields, COUNT(*) OVER () AS total FROM contacts
       WHERE archived = 0 AND id NOT IN (SELECT value FROM json_each(?))${match}
       ORDER BY name COLLATE NOCASE, id LIMIT ?`,
    )
    .bind(...params)
    .all<PickPerson & { total: number }>();
  return { people: found.results.map(({ id, name, untrusted_fields }) => ({ id, name, untrusted_fields })), total: found.results[0]?.total ?? 0 };
}

/** The picked people that are still on the board, by id. */
export async function peopleByIds(db: Db, ids: string[]): Promise<Map<string, PickPerson>> {
  if (ids.length === 0) return new Map();
  const found = await db
    .prepare("SELECT id, name, untrusted_fields FROM contacts WHERE archived = 0 AND id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(ids))
    .all<PickPerson>();
  return new Map(found.results.map((person) => [person.id, person]));
}
