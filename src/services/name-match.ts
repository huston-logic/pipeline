// How a proposal's action names a record (decision 0044): an id, else an exact name or title (ignoring case and extra
// spaces), else the non-archived records whose name has the ref as a whole word or the start of one ("Dana" finds
// "Dana Example") or whose business is the ref. One match is used; several, or none, become a question for the owner.
// A deal can also be named by its person, when that person has exactly one open deal; a task by its title, among
// open tasks. Only the database is read: refs are resolved before anything is planned.
import type { ContactRow, Db, DealRow, TaskRow } from "../db/db.ts";
import { getContact, getDeal, getTask } from "../db/queries.ts";
import { businessKey } from "./lead-change.ts";

export type Match<T> = { kind: "one"; row: T } | { kind: "many"; rows: T[] } | { kind: "none" };

/** Trimmed, inner spaces collapsed, ignoring case: how a ref and a name are compared. */
export const nameKey = (text: string | null): string => (text ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/** The ref as a whole word or the start of a word of the name. */
const hasWordPrefix = (name: string, ref: string) => ` ${name}`.includes(` ${ref}`);

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** A LIKE pattern every name holding the ref's words in order matches, whatever the spaces between them. */
const likePattern = (key: string) => `%${key.split(" ").map(escapeLike).join("%")}%`;

function matchOf<T>(rows: readonly T[]): Match<T> {
  const [first, ...others] = rows;
  if (first === undefined) return { kind: "none" };
  return others.length === 0 ? { kind: "one", row: first } : { kind: "many", rows: [...rows] };
}

/** The exact matches if there are any, else the loose ones. */
function bestOf<T>(rows: readonly T[], exact: (row: T) => boolean, loose: (row: T) => boolean): Match<T> {
  const exactRows = rows.filter(exact);
  return exactRows.length > 0 ? matchOf(exactRows) : matchOf(rows.filter(loose));
}

export async function matchContact(db: Db, ref: string): Promise<Match<ContactRow>> {
  const key = nameKey(ref);
  if (key === "") return { kind: "none" };
  const byId = await getContact(db, ref.trim());
  if (byId) return { kind: "one", row: byId };
  const pattern = likePattern(key);
  const found = await db
    .prepare(
      "SELECT * FROM contacts WHERE archived = 0 AND (name LIKE ? ESCAPE '\\' OR business LIKE ? ESCAPE '\\') ORDER BY created_at, id",
    )
    .bind(pattern, pattern)
    .all<ContactRow>();
  return bestOf(
    found.results,
    (row) => nameKey(row.name) === key,
    (row) => hasWordPrefix(nameKey(row.name), key) || businessKey(row.business) === key,
  );
}

/** The open, unarchived deals of these people, oldest first. */
async function openDeals(db: Db, contacts: readonly ContactRow[]): Promise<DealRow[]> {
  if (contacts.length === 0) return [];
  const found = await db
    .prepare(
      `SELECT * FROM deals WHERE contact_id IN (${contacts.map(() => "?").join(", ")}) AND status = 'open' AND archived = 0 ` +
        "ORDER BY created_at, id",
    )
    .bind(...contacts.map((contact) => contact.id))
    .all<DealRow>();
  return found.results;
}

export async function matchDeal(db: Db, ref: string): Promise<Match<DealRow>> {
  const key = nameKey(ref);
  if (key === "") return { kind: "none" };
  const byId = await getDeal(db, ref.trim());
  if (byId) return { kind: "one", row: byId };
  const titled = await db
    .prepare("SELECT * FROM deals WHERE archived = 0 AND title LIKE ? ESCAPE '\\' ORDER BY created_at, id")
    .bind(likePattern(key))
    .all<DealRow>();
  const exact = titled.results.filter((row) => nameKey(row.title) === key);
  if (exact.length > 0) return matchOf(exact);
  // By the person: their one open deal. Two people matching is a question even when only one of them has a deal.
  const person = await matchContact(db, ref);
  if (person.kind === "none") return { kind: "none" };
  const deals = await openDeals(db, person.kind === "one" ? [person.row] : person.rows);
  if (person.kind === "many" && deals.length > 0) return { kind: "many", rows: deals };
  return matchOf(deals);
}

export async function matchTask(db: Db, ref: string): Promise<Match<TaskRow>> {
  const key = nameKey(ref);
  if (key === "") return { kind: "none" };
  const byId = await getTask(db, ref.trim());
  if (byId) return { kind: "one", row: byId };
  const found = await db
    .prepare("SELECT * FROM tasks WHERE done_at IS NULL AND title LIKE ? ESCAPE '\\' ORDER BY created_at, id")
    .bind(likePattern(key))
    .all<TaskRow>();
  return bestOf(
    found.results,
    (row) => nameKey(row.title) === key,
    (row) => hasWordPrefix(nameKey(row.title), key),
  );
}
