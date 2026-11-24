// How a proposal's action names a record (decision 0044): an id, else an exact name or title (ignoring case and extra
// spaces), else the non-archived records whose name has the ref as a whole word or the start of one ("Dana" finds
// "Dana Example") or whose business is the ref. One match is used; several, or none, become a question for the owner.
// A match on a name, business or title that came from outside (untrusted_fields) never wins and never stands in
// alone: when any candidate matched only on outside text, every candidate is a question. More than MATCH_MAX
// candidates is one "too many" answer. A deal can also be named by its person, when that person has exactly one open
// deal; a task by its title, among open tasks. Only the database is read: refs are resolved before anything is planned.
import type { ContactRow, Db, DealRow, TaskRow } from "../db/db.ts";
import { getContact, getDeal, getTask } from "../db/queries.ts";
import { isTrusted } from "./labels.ts";
import { businessKey } from "./lead-change.ts";

export type Match<T> =
  | { kind: "one"; row: T }
  | { kind: "many"; rows: T[] }
  | { kind: "none" }
  /** More than MATCH_MAX candidates: `noun` is what they are ("people", "deals", "tasks"). */
  | { kind: "tooMany"; noun: string };

/** The most candidates a question lists; more is "too many" (and keeps every read under D1's 100 parameters). */
export const MATCH_MAX = 10;

/** Trimmed, inner spaces collapsed, ignoring case: how a ref and a name are compared. */
export const nameKey = (text: string | null): string => (text ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/** The ref as a whole word or the start of a word of the name. */
const hasWordPrefix = (name: string, ref: string) => ` ${name}`.includes(` ${ref}`);

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** A LIKE pattern every name holding the ref's words in order matches, whatever the spaces between them. */
const likePattern = (key: string) => `%${key.split(" ").map(escapeLike).join("%")}%`;

function matchOf<T>(rows: readonly T[], noun: string): Match<T> {
  const [first, ...others] = rows;
  if (first === undefined) return { kind: "none" };
  if (rows.length > MATCH_MAX) return { kind: "tooMany", noun };
  return others.length === 0 ? { kind: "one", row: first } : { kind: "many", rows: [...rows] };
}

/**
 * The exact matches if there are any, else the loose ones; but when any candidate matched only on outside text, all
 * of them, always as a question.
 */
function decide<T>(exact: readonly T[], loose: readonly T[], outsideOnly: (row: T) => boolean, noun: string): Match<T> {
  const all = [...exact, ...loose];
  if (all.some(outsideOnly)) return all.length > MATCH_MAX ? { kind: "tooMany", noun } : { kind: "many", rows: all };
  return matchOf(exact.length > 0 ? exact : loose, noun);
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
  const byName = (row: ContactRow) => hasWordPrefix(nameKey(row.name), key);
  const byBusiness = (row: ContactRow) => businessKey(row.business) === key;
  const exact = found.results.filter((row) => nameKey(row.name) === key);
  const loose = found.results.filter((row) => !exact.includes(row) && (byName(row) || byBusiness(row)));
  const trustedHit = (row: ContactRow) => (byName(row) && isTrusted(row, "name")) || (byBusiness(row) && isTrusted(row, "business"));
  return decide(exact, loose, (row) => !trustedHit(row), "people");
}

/** The open, unarchived deals of these people (at most MATCH_MAX of them), oldest first. */
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
  if (exact.length > 0) return decide(exact, [], (row) => !isTrusted(row, "title"), "deals");
  // By the person: their one open deal. Two people matching is a question even when only one of them has a deal.
  const person = await matchContact(db, ref);
  if (person.kind === "none" || person.kind === "tooMany") return person;
  const deals = await openDeals(db, person.kind === "one" ? [person.row] : person.rows);
  if (person.kind === "many" && deals.length > 0) return deals.length > MATCH_MAX ? { kind: "tooMany", noun: "deals" } : { kind: "many", rows: deals };
  return matchOf(deals, "deals");
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
  const exact = found.results.filter((row) => nameKey(row.title) === key);
  const loose = found.results.filter((row) => !exact.includes(row) && hasWordPrefix(nameKey(row.title), key));
  return decide(exact, loose, (row) => !isTrusted(row, "title"), "tasks");
}
