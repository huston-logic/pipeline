// How a proposal's action names a record (decision 0044): an id, else an exact name or title (ignoring case and extra
// spaces), else the non-archived records whose name has the ref as a whole word or the start of one ("Dana" finds
// "Dana Example") or whose business is the ref. One match is used; several, or none, become a question for the owner.
// A match on a name, business or title that came from outside (untrusted_fields) never wins and never stands in
// alone: when any candidate matched only on outside text, every candidate is a question. More than MATCH_MAX
// candidates is one "too many" answer. A deal can also be named by its person, when that person has exactly one open
// deal; a task by its title, among open tasks. Only the database is read: refs are resolved before anything is planned.
// Every ref of a list is read at once (matchAll): a statement per way of reading each kind of record, all in one D1
// batch, so a list of any length costs one D1 call to resolve (decision 0044, "D1 calls"). A ref shaped like an id is
// read by id only, so it scans no names; read by name too only if no record has that id (a second batch). The one case
// that differs from a lone match: a deal ref that is a person's id finds that person's deal even if some deal's title
// is exactly that id.
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

/** Refs per statement: each binds one parameter (its id or its LIKE pattern), and D1 takes 100 a statement. */
const REFS_PER_READ = 90;

/** A ref shaped like an id (ct_..., dl_..., tk_...): read by id first, by name only if no record has that id. */
const ID_SHAPED = /^[a-z]{2}_[a-z0-9]+$/i;

type Tagged = Record<string, unknown> & { ref_n: number };

/** The rows a read found for ref n, without the tag column. */
function rowsOf<T>(rows: readonly Tagged[] | undefined, n: number): T[] {
  return (rows ?? []).flatMap(({ ref_n: tag, ...row }) => (tag === n ? [row as T] : []));
}

type Asked = { n: number; value: string };

/**
 * One statement per chunk of refs: `refs(n, v)`, the ref's number as a literal (it is a count, never text) and its id
 * or pattern bound, joined to the table by `on`; each row comes back tagged with its ref's number.
 */
function readsFor(db: Db, refs: readonly Asked[], select: string, on: string, order: string): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < refs.length; i += REFS_PER_READ) {
    const chunk = refs.slice(i, i + REFS_PER_READ);
    const values = chunk.map((ref) => `(${ref.n}, ?)`).join(", ");
    out.push(
      db
        .prepare(`WITH refs(n, v) AS (VALUES ${values}) SELECT refs.n AS ref_n, ${select} FROM refs JOIN ${on} ORDER BY ref_n, ${order}`)
        .bind(...chunk.map((ref) => ref.value)),
    );
  }
  return out;
}

const BY_NAME = "c.archived = 0 AND (c.name LIKE refs.v ESCAPE '\\' OR c.business LIKE refs.v ESCAPE '\\')";
const OPEN_DEAL = "d.status = 'open' AND d.archived = 0";

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

type Kind = keyof Matches;
type Ref = { ref: string; key: string; byName: boolean };

/** One batch: every ref by id, and those with `byName` by name too. Answers each ref's match, and the refs to read again by name. */
async function readOnce(db: Db, lists: Record<Kind, Ref[]>): Promise<{ matches: Matches; again: Record<Kind, number[]> }> {
  const { contacts, deals, tasks } = lists;
  const ids = (list: readonly Ref[], from = 0): Asked[] => list.flatMap(({ ref, key }, i) => (key === "" ? [] : [{ n: from + i, value: ref.trim() }]));
  const names = (list: readonly Ref[], from = 0): Asked[] =>
    list.flatMap(({ key, byName }, i) => (key === "" || !byName ? [] : [{ n: from + i, value: likePattern(key) }]));
  // A deal ref is also read as a person (its person's open deal): the contact refs, then the deal refs as people.
  const groups = [
    readsFor(db, [...ids(contacts), ...ids(deals, contacts.length)], "c.*", "contacts c ON c.id = refs.v", "c.created_at, c.id"),
    readsFor(db, [...names(contacts), ...names(deals, contacts.length)], "c.*", `contacts c ON ${BY_NAME}`, "c.created_at, c.id"),
    readsFor(db, ids(deals), "d.*", "deals d ON d.id = refs.v", "d.created_at, d.id"),
    readsFor(db, names(deals), "d.*", "deals d ON d.archived = 0 AND d.title LIKE refs.v ESCAPE '\\'", "d.created_at, d.id"),
    readsFor(db, ids(deals), "d.*", `deals d ON d.contact_id = refs.v AND ${OPEN_DEAL}`, "d.created_at, d.id"),
    readsFor(db, names(deals), "d.*", `contacts c ON ${BY_NAME} JOIN deals d ON d.contact_id = c.id AND ${OPEN_DEAL}`, "d.created_at, d.id"),
    readsFor(db, ids(tasks), "t.*", "tasks t ON t.id = refs.v", "t.created_at, t.id"),
    readsFor(db, names(tasks), "t.*", "tasks t ON t.done_at IS NULL AND t.title LIKE refs.v ESCAPE '\\'", "t.created_at, t.id"),
  ];
  const statements = groups.flat();
  const results = statements.length === 0 ? [] : await db.batch<Tagged>(statements);
  let at = 0;
  const [peopleById, peopleByName, dealsById, dealsByTitle, personDealsById, personDealsByName, tasksById, tasksByTitle] = groups.map((group) => {
    const rows = results.slice(at, at + group.length).flatMap((result) => result.results);
    at += group.length;
    return rows;
  });
  const none = { kind: "none" } as const;
  const again: Record<Kind, number[]> = { contacts: [], deals: [], tasks: [] };
  const personMatch = (n: number, key: string): Match<ContactRow> =>
    contactMatch(key, rowsOf<ContactRow>(peopleById, n), rowsOf<ContactRow>(peopleByName, n));
  const matches: Matches = {
    contacts: contacts.map(({ key, byName }, i) => {
      if (key === "") return none;
      const byId = rowsOf<ContactRow>(peopleById, i);
      if (byId.length === 0 && !byName) again.contacts.push(i);
      return personMatch(i, key);
    }),
    deals: deals.map(({ key, byName }, i) => {
      if (key === "") return none;
      const n = contacts.length + i;
      const byId = rowsOf<DealRow>(dealsById, i);
      if (byId.length === 0 && rowsOf(peopleById, n).length === 0 && !byName) again.deals.push(i);
      const personDeals = [...rowsOf<DealRow>(personDealsById, i), ...rowsOf<DealRow>(personDealsByName, i)];
      const unique = personDeals.filter((deal, j) => personDeals.findIndex((other) => other.id === deal.id) === j);
      unique.sort((x, y) => (x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
      return dealMatch(key, { byId, titled: rowsOf<DealRow>(dealsByTitle, i), person: personMatch(n, key), personDeals: unique });
    }),
    tasks: tasks.map(({ key, byName }, i) => {
      if (key === "") return none;
      const byId = rowsOf<TaskRow>(tasksById, i);
      if (byId.length === 0 && !byName) again.tasks.push(i);
      return taskMatch(key, byId, rowsOf<TaskRow>(tasksByTitle, i));
    }),
  };
  return { matches, again };
}

/**
 * Every ref's match, in the order given, each exactly as it would be matched alone, in one D1 batch however many refs
 * (none when every ref is blank): a statement per way of reading each kind of record. A ref shaped like an id is read
 * only by id; in the rare case that no record has that id, it is read again by name in a second batch.
 */
export async function matchAll(db: Db, refs: Refs): Promise<Matches> {
  const list = (values: readonly string[] | undefined): Ref[] =>
    (values ?? []).map((ref) => ({ ref, key: nameKey(ref), byName: !ID_SHAPED.test(ref.trim()) }));
  const lists: Record<Kind, Ref[]> = { contacts: list(refs.contacts), deals: list(refs.deals), tasks: list(refs.tasks) };
  const { matches, again } = await readOnce(db, lists);
  if (again.contacts.length + again.deals.length + again.tasks.length === 0) return matches;
  const pick = (kind: Kind): Ref[] => again[kind].map((i) => ({ ...(lists[kind][i] as Ref), byName: true }));
  const second = (await readOnce(db, { contacts: pick("contacts"), deals: pick("deals"), tasks: pick("tasks") })).matches;
  for (const kind of ["contacts", "deals", "tasks"] as const) {
    again[kind].forEach((i, j) => {
      const found = second[kind][j];
      if (found !== undefined) (matches[kind] as unknown[])[i] = found;
    });
  }
  return matches;
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
