// How a proposal's action names a record (decision 0044): an id, else an exact name or title (ignoring case and extra
// spaces), else the non-archived records whose name has the ref as a whole word or the start of one ("Dana" finds
// "Dana Example") or whose business is the ref. One match is used; several, or none, become a question for the owner.
// A match on a name, business or title that came from outside (untrusted_fields) never wins and never stands in
// alone: when any candidate matched only on outside text, every candidate is a question. More than MATCH_MAX
// candidates is one "too many" answer. A deal can also be named by its person, when that person has exactly one open
// deal; a task by its title, among open tasks. Only the database is read: refs are resolved before anything is planned.
// Every ref of a list is read at once (matchAll): one statement per kind of record, all in one D1 batch, so a list of
// any length costs one D1 call to resolve (decision 0044, "D1 calls").
import type { ContactRow, Db, DealRow, TaskRow } from "../db/db.ts";
import { isTrusted } from "./labels.ts";
import { businessKey } from "./lead-change.ts";

export type Match<T> =
  | { kind: "one"; row: T }
  | { kind: "many"; rows: T[] }
  | { kind: "none" }
  /** More than MATCH_MAX candidates: `noun` is what they are ("people", "deals", "tasks"). */
  | { kind: "tooMany"; noun: string };

/** The most candidates a question lists; more is "too many". */
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

/** How a contact ref picks among the rows its read found (by id, or by name or business), as matchContact did alone. */
function contactMatch(key: string, byId: readonly ContactRow[], found: readonly ContactRow[]): Match<ContactRow> {
  const [one] = byId;
  if (one !== undefined) return { kind: "one", row: one };
  const byName = (row: ContactRow) => hasWordPrefix(nameKey(row.name), key);
  const byBusiness = (row: ContactRow) => businessKey(row.business) === key;
  const exact = found.filter((row) => nameKey(row.name) === key);
  const loose = found.filter((row) => !exact.includes(row) && (byName(row) || byBusiness(row)));
  const trustedHit = (row: ContactRow) => (byName(row) && isTrusted(row, "name")) || (byBusiness(row) && isTrusted(row, "business"));
  return decide(exact, loose, (row) => !trustedHit(row), "people");
}

/** A deal ref: by id, else an exact title, else its person's one open deal (`personDeals`: the open deals of the people its LIKE found). */
function dealMatch(
  key: string,
  read: { byId: readonly DealRow[]; titled: readonly DealRow[]; person: Match<ContactRow>; personDeals: readonly DealRow[] },
): Match<DealRow> {
  const [one] = read.byId;
  if (one !== undefined) return { kind: "one", row: one };
  const exact = read.titled.filter((row) => nameKey(row.title) === key);
  if (exact.length > 0) return decide(exact, [], (row) => !isTrusted(row, "title"), "deals");
  // By the person: their one open deal. Two people matching is a question even when only one of them has a deal.
  const { person } = read;
  if (person.kind === "none" || person.kind === "tooMany") return person;
  const people = new Set((person.kind === "one" ? [person.row] : person.rows).map((row) => row.id));
  const deals = read.personDeals.filter((deal) => people.has(deal.contact_id));
  if (person.kind === "many" && deals.length > 0) return deals.length > MATCH_MAX ? { kind: "tooMany", noun: "deals" } : { kind: "many", rows: deals };
  return matchOf(deals, "deals");
}

function taskMatch(key: string, byId: readonly TaskRow[], found: readonly TaskRow[]): Match<TaskRow> {
  const [one] = byId;
  if (one !== undefined) return { kind: "one", row: one };
  const exact = found.filter((row) => nameKey(row.title) === key);
  const loose = found.filter((row) => !exact.includes(row) && hasWordPrefix(nameKey(row.title), key));
  return decide(exact, loose, (row) => !isTrusted(row, "title"), "tasks");
}

/** Refs per statement: each binds two parameters (the id and the LIKE pattern), and D1 takes 100 a statement. */
const REFS_PER_READ = 50;

type Tagged = Record<string, unknown> & { ref_n: number; by_id?: number };

/** A read's rows of one ref, without the tag columns: those it found by id, and the others. */
function rowsOf<T>(rows: readonly Tagged[], n: number): { byId: T[]; found: T[] } {
  const byId: T[] = [];
  const found: T[] = [];
  for (const { ref_n: tag, by_id: id, ...row } of rows) {
    if (tag !== n) continue;
    (id === 1 ? byId : found).push(row as T);
  }
  return { byId, found };
}

type Asked = { n: number; id: string; pattern: string };

/**
 * One statement per chunk of refs: `refs(n, id, pattern)`, the ref's number as a literal (it is a count, never text)
 * and its id and pattern bound, joined to the table by `on`; each row comes back tagged with its ref's number.
 */
function readsFor(db: Db, refs: readonly Asked[], select: string, on: string, order: string): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < refs.length; i += REFS_PER_READ) {
    const chunk = refs.slice(i, i + REFS_PER_READ);
    const values = chunk.map((ref) => `(${ref.n}, ?, ?)`).join(", ");
    out.push(
      db
        .prepare(`WITH refs(n, id, pattern) AS (VALUES ${values}) SELECT refs.n AS ref_n, ${select} FROM refs JOIN ${on} ORDER BY ref_n, ${order}`)
        .bind(...chunk.flatMap((ref) => [ref.id, ref.pattern])),
    );
  }
  return out;
}

const CONTACT_ON = "contacts c ON c.id = refs.id OR (c.archived = 0 AND (c.name LIKE refs.pattern ESCAPE '\\' OR c.business LIKE refs.pattern ESCAPE '\\'))";

export interface Refs {
  contacts?: readonly string[];
  deals?: readonly string[];
  tasks?: readonly string[];
}

export interface Matches {
  contacts: Match<ContactRow>[];
  deals: Match<DealRow>[];
  tasks: Match<TaskRow>[];
}

/**
 * Every ref's match, in the order given, each exactly as it would be matched alone: one D1 batch however many refs
 * (none when every ref is blank), a statement per kind of record (and per 50 refs of a kind).
 */
export async function matchAll(db: Db, refs: Refs): Promise<Matches> {
  const contacts = (refs.contacts ?? []).map((ref) => ({ ref, key: nameKey(ref) }));
  const deals = (refs.deals ?? []).map((ref) => ({ ref, key: nameKey(ref) }));
  const tasks = (refs.tasks ?? []).map((ref) => ({ ref, key: nameKey(ref) }));
  // A blank ref matches nothing and isn't read.
  const asked = (list: readonly { ref: string; key: string }[], from = 0): Asked[] =>
    list.flatMap(({ ref, key }, i) => (key === "" ? [] : [{ n: from + i, id: ref.trim(), pattern: likePattern(key) }]));
  // A deal ref is also read as a person (its person's open deal): the contact refs, then the deal refs as people.
  const people = [...asked(contacts), ...asked(deals, contacts.length)];
  const groups = [
    readsFor(db, people, "c.id = refs.id AS by_id, c.*", CONTACT_ON, "c.created_at, c.id"),
    readsFor(db, asked(deals), "d.id = refs.id AS by_id, d.*", "deals d ON d.id = refs.id OR (d.archived = 0 AND d.title LIKE refs.pattern ESCAPE '\\')", "d.created_at, d.id"),
    readsFor(db, asked(deals), "d.*", `${CONTACT_ON} JOIN deals d ON d.contact_id = c.id AND d.status = 'open' AND d.archived = 0`, "d.created_at, d.id"),
    readsFor(db, asked(tasks), "t.id = refs.id AS by_id, t.*", "tasks t ON t.id = refs.id OR (t.done_at IS NULL AND t.title LIKE refs.pattern ESCAPE '\\')", "t.created_at, t.id"),
  ];
  const statements = groups.flat();
  const results = statements.length === 0 ? [] : await db.batch<Tagged>(statements);
  let at = 0;
  const rowsOfGroup = (group: readonly D1PreparedStatement[]): Tagged[] => {
    const rows = results.slice(at, at + group.length).flatMap((result) => result.results);
    at += group.length;
    return rows;
  };
  const [personRows, titledRows, personDealRows, taskRows] = groups.map(rowsOfGroup);
  const none = { kind: "none" } as const;
  const personMatch = (n: number, key: string): Match<ContactRow> => {
    if (key === "") return none;
    const { byId, found } = rowsOf<ContactRow>(personRows ?? [], n);
    return contactMatch(key, byId, found);
  };
  return {
    contacts: contacts.map(({ key }, n) => personMatch(n, key)),
    deals: deals.map(({ key }, n) => {
      if (key === "") return none;
      const { byId, found: titled } = rowsOf<DealRow>(titledRows ?? [], n);
      const personDeals = rowsOf<DealRow>(personDealRows ?? [], n).found;
      return dealMatch(key, { byId, titled, person: personMatch(contacts.length + n, key), personDeals });
    }),
    tasks: tasks.map(({ key }, n) => {
      if (key === "") return none;
      const { byId, found } = rowsOf<TaskRow>(taskRows ?? [], n);
      return taskMatch(key, byId, found);
    }),
  };
}

export async function matchContact(db: Db, ref: string): Promise<Match<ContactRow>> {
  return (await matchAll(db, { contacts: [ref] })).contacts[0] ?? { kind: "none" };
}

export async function matchDeal(db: Db, ref: string): Promise<Match<DealRow>> {
  return (await matchAll(db, { deals: [ref] })).deals[0] ?? { kind: "none" };
}

export async function matchTask(db: Db, ref: string): Promise<Match<TaskRow>> {
  return (await matchAll(db, { tasks: [ref] })).tasks[0] ?? { kind: "none" };
}
