// undo_change: reverses exactly one change by writing its `before` snapshot back, as a new audited change. It
// refuses when the change is unknown, already undone, itself an undo, when a row it would delete now has other
// records pointing at it (by foreign key or by key inside a JSON column), when putting back a field's choices would
// drop one records use, when any row it touched is no longer exactly as the change left it, or when it would reopen a
// deal for someone who is an unqualified lead now, or make someone an unqualified lead again while they have an open
// deal (decision 0022, invariant 1). Decision 0009.
// Every read is set-based (decision 0035): grouped by table, the ids passed through json_each, so an undo makes the
// same number of reads for 2 rows as for 2,000. A change that had parts, or touched more than 50 rows, is undone
// with a bulk change and described with counts.
import type { AuditRow, ContactRow, Db, RuleType } from "../db/db.ts";
import { newId } from "../ids.ts";
import { chunkBy, sqlBytes } from "./bulk.ts";
import {
  type ChangeResult,
  type ChangeTable,
  changedColumns,
  commitChange,
  type Ctx,
  isBulkTable,
  isChangeTable,
  isClientRatePairFailure,
  isForeignKeyFailure,
  isRunningTimerFailure,
  isSuppressionEmailFailure,
  isWorkTypeNameFailure,
  primaryKey,
  readSnapshot,
  type Row,
  type RowChange,
  rowKey,
  type SqlValue,
  StaleWriteError,
} from "./change.ts";
import { capitalize, columnLabel, dealTitleOf, joinAnd, rowLabel, short } from "./describe.ts";
import { UserError } from "./errors.ts";
import { contactName, dealLabel } from "./labels.ts";
import { isUnqualified, type LeadStatus } from "./lead-status.ts";
import { statusLabels } from "./status-labels.ts";
import { parseStringArray, stageLabels } from "./lookup.ts";
import { migratedPersonColumns } from "./person-move.ts";
import { resumedParams } from "./rules.ts";

type Entry = { table: ChangeTable; id: string; before: Row | null; after: Row | null };

/** An undo of a change that touched more than this many rows is written as a bulk change (decision 0035). */
const BULK_ROWS = 50;

/** Campaign delivery records are written next to an audited change, never undone, so they are not change tables. */
type Dependent = { table: ChangeTable | "campaign_recipients" | "campaign_batches"; column: string; one: string; many: string };

const CAMPAIGN_RECIPIENT = { table: "campaign_recipients", one: "campaign recipient", many: "campaign recipients" } as const;
const EMAIL_BLOCK = { table: "email_suppressions", one: "campaign email block", many: "campaign email blocks" } as const;

/** Rows that point at a row of each table, so deleting it would break them. ON DELETE SET NULL links are left out. */
const TIME_ENTRY = { table: "time_entries", one: "time entry", many: "time entries" } as const;

const PROJECT = { table: "projects", one: "project", many: "projects" } as const;

const DEPENDENTS: Partial<Record<ChangeTable, Dependent[]>> = {
  contacts: [
    { table: "deals", column: "contact_id", one: "deal", many: "deals" },
    { table: "activities", column: "contact_id", one: "activity", many: "activities" },
    { table: "tasks", column: "contact_id", one: "task", many: "tasks" },
    { table: "rule_firings", column: "contact_id", one: "rule firing", many: "rule firings" },
    { ...TIME_ENTRY, column: "contact_id" },
    { table: "client_rates", column: "contact_id", one: "client rate", many: "client rates" },
    { ...CAMPAIGN_RECIPIENT, column: "contact_id" },
    { ...EMAIL_BLOCK, column: "contact_id" },
    { ...PROJECT, column: "contact_id" },
  ],
  // Delivery work after a sale (migration 0020): what points at a project, and the status it is in.
  projects: [
    { table: "tasks", column: "project_id", one: "task", many: "tasks" },
    { table: "activities", column: "project_id", one: "activity", many: "activities" },
    { ...TIME_ENTRY, column: "project_id" },
  ],
  project_statuses: [{ ...PROJECT, column: "status_key" }],
  // Delivery records and address blocks of a campaign (migration 0019).
  campaigns: [
    { ...CAMPAIGN_RECIPIENT, column: "campaign_id" },
    { table: "campaign_batches", column: "campaign_id", one: "sending attempt", many: "sending attempts" },
    { ...EMAIL_BLOCK, column: "campaign_id" },
  ],
  campaign_steps: [{ ...CAMPAIGN_RECIPIENT, column: "step_id" }],
  deals: [
    { table: "activities", column: "deal_id", one: "activity", many: "activities" },
    { table: "tasks", column: "deal_id", one: "task", many: "tasks" },
    { table: "rule_firings", column: "deal_id", one: "rule firing", many: "rule firings" },
    { ...TIME_ENTRY, column: "deal_id" },
    { ...PROJECT, column: "deal_id" },
  ],
  // Time entries (decision 0049): the task or note they point at, and the work type they used.
  // A sub-task (migration 0022) points at its parent task.
  tasks: [{ ...TIME_ENTRY, column: "task_id" }, { table: "tasks", column: "parent_id", one: "sub-task", many: "sub-tasks" }],
  activities: [{ ...TIME_ENTRY, column: "activity_id" }],
  work_types: [
    { ...TIME_ENTRY, column: "work_type_id" },
    { table: "client_rates", column: "work_type_id", one: "client rate", many: "client rates" },
  ],
  stages: [{ table: "deals", column: "stage_key", one: "deal", many: "deals" }],
  rules: [{ table: "rule_firings", column: "rule_id", one: "rule firing", many: "rule firings" }],
  // No foreign keys (migration 0011): a person names their status by key, and their sub-status by key within it, so
  // the sub-status's id is matched as "<person_status>.<sub_status>".
  person_statuses: [
    { table: "contacts", column: "person_status", one: "person", many: "people" },
    { table: "person_substatuses", column: "status_key", one: "sub-status", many: "sub-statuses" },
  ],
  person_substatuses: [{ table: "contacts", column: "person_status || '.' || sub_status", one: "person", many: "people" }],
};

/**
 * Rows that name a row inside a JSON column rather than through a foreign key: a custom field's key in the `fields` of
 * contacts or deals, a stage's key in `rules.params` or a saved view's filters, a person status's key in a saved view's
 * filters (decision 0042). Removing the row would leave them pointing at nothing (or, for a field, let a later field
 * reuse the key and inherit the old values). `equals` absent means "any value at that path".
 */
type JsonRef = {
  table: "contacts" | "deals" | "rules" | "views";
  column: string;
  path: string;
  /** The top-level key `path` reads, to check a snapshot row the same way in code. */
  key: string;
  equals?: string;
  what: (labels: string, n: number) => string;
};

const JSON_DEPENDENTS: Partial<Record<ChangeTable, (row: Row) => JsonRef[]>> = {
  field_defs: (row) => [
    {
      table: row.entity === "contact" ? "contacts" : "deals",
      column: "fields",
      path: `$."${String(row.key)}"`,
      key: String(row.key),
      what: (labels) => `${short(String(row.label), 60)} is set on ${labels}`,
    },
  ],
  stages: (row) => [
    {
      table: "rules",
      column: "params",
      path: "$.stage",
      key: "stage",
      equals: String(row.key),
      what: (labels, n) => `${labels} ${n === 1 ? "watches" : "watch"} ${short(String(row.label), 60)}`,
    },
    viewFilterRef("stage", row),
  ],
  person_statuses: (row) => [viewFilterRef("person_status", row)],
};

/** Saved views whose filters name the stage or person status by its key (decision 0042). */
function viewFilterRef(key: "stage" | "person_status", row: Row): JsonRef {
  return {
    table: "views",
    column: "filters",
    path: `$.${key}`,
    key,
    equals: String(row.key),
    what: (labels, n) => `${labels} ${n === 1 ? "shows" : "show"} ${short(String(row.label), 60)}`,
  };
}

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
  "lead_status_at",
  "status",
  "untrusted_fields",
]);

async function entriesOf(db: Db, audit: AuditRow): Promise<Entry[]> {
  const { before, after } = await readSnapshot(db, audit);
  return Object.keys(after).map((key) => {
    const split = key.indexOf(":");
    const table = key.slice(0, split);
    if (split < 1 || !isChangeTable(table)) throw new Error(`Change ${audit.id} names an unknown row ${key}.`);
    return { table, id: key.slice(split + 1), before: before[key] ?? null, after: after[key] ?? null };
  });
}

const pkOf = (entry: Entry): SqlValue | undefined => (entry.after ?? entry.before)?.[primaryKey(entry.table)];

/**
 * The rows one statement shape finds for a set of values, in as few statements as the values need: `sql` takes the
 * values as a JSON array in its one `?` (read with json_each). Values are cut at CHUNK_BYTES, like a bulk write, so a
 * statement never grows past D1's limit; up to 2,000 ids fit in one.
 */
async function rowsFor(db: Db, values: readonly SqlValue[], sql: string): Promise<Row[]> {
  const unique = [...new Set(values)];
  if (unique.length === 0) return [];
  const out: Row[] = [];
  for (const chunk of chunkBy(unique, (value) => sqlBytes(JSON.stringify(value)))) {
    out.push(...(await db.prepare(sql).bind(JSON.stringify(chunk)).all<Row>()).results);
  }
  return out;
}

/** `rows` grouped by the text of one column, each group in the order the rows came. */
function groupBy(rows: readonly Row[], column: string): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = String(row[column]);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

/** The current row for every entry (null when it is gone), one read per table. */
async function currentRows(db: Db, entries: Entry[]): Promise<Map<Entry, Row | null>> {
  const current = new Map<Entry, Row | null>();
  const tables = [...new Set(entries.map((entry) => entry.table))];
  for (const table of tables) {
    const pk = primaryKey(table);
    const mine = entries.filter((entry) => entry.table === table);
    const values = mine.map(pkOf).filter((value): value is SqlValue => value !== undefined);
    const rows = await rowsFor(db, values, `SELECT * FROM ${table} WHERE ${pk} IN (SELECT j.value FROM json_each(?) AS j)`);
    const found = new Map(rows.map((row) => [String(row[pk]), row]));
    for (const entry of mine) current.set(entry, found.get(String(pkOf(entry))) ?? null);
  }
  return current;
}

const sameRow = (current: Row | null, expected: Row | null) =>
  expected === null
    ? current === null
    : current !== null && Object.keys(expected).every((column) => current[column] === expected[column]);

const dependsMessage = (changeId: string, what: string) =>
  `Can't undo ${changeId}: other records now depend on it (${what}). Change those first, or leave it.`;

/**
 * The tools whose changes can never be undone: a campaign's sending steps (an email that went out can't be taken back;
 * Pause or Cancel stops the rest) and an unsubscribe or delivery result (the person asked, or the mail system said so).
 */
export const CAMPAIGN_FINAL_TOOLS = [
  "campaign_approve",
  "campaign_schedule",
  "campaign_send",
  "campaign_pause",
  "campaign_resume",
  "campaign_cancel",
  "campaign_test",
  "unsubscribe",
  "campaign_webhook",
] as const;

const finalMessage = (changeId: string, tool: string) =>
  `Can't undo ${changeId}. ` +
  (tool === "unsubscribe"
    ? "An unsubscribe can't be undone."
    : "A campaign's sending steps can't be undone. Use Pause or Cancel on its page.");

const isFinalTool = (tool: string) => (CAMPAIGN_FINAL_TOOLS as readonly string[]).includes(tool);

const alreadyUndone = (changeId: string, audit: AuditRow) =>
  `${changeId} was already undone (by ${audit.undone_by ?? "an earlier undo"}). Nothing to do.`;

const changedMessage = (changeId: string, what: string) =>
  `Can't undo ${changeId}: ${what} changed since (see recent_changes). Undo the later changes first, or leave it.`;

/**
 * A rule firing keeps firing idempotent, so the deal, person or rule it names can never be removed again (decisions
 * 0010 and 0026). The refusal says what to do instead of "change those first", which the owner can't do for a firing.
 */
function ruleHistoryMessage(changeId: string, entry: Entry): string {
  const row = entry.after ?? {};
  if (entry.table === "rules") {
    return `Can't undo ${changeId}: rule ${entry.id} has already fired, so it can't be removed. Pause it with pause_rule instead.`;
  }
  if (entry.table === "contacts") {
    return (
      `Can't undo ${changeId}: this person has rule history (a rule already fired on ${rowLabel("contacts", row)}), so ` +
      "they can't be removed. Mark them Bad lead or Not a fit with update_contact instead."
    );
  }
  return (
    `Can't undo ${changeId}: this lead has rule history (a rule already fired on ${rowLabel("deals", row)}), so it can't ` +
    "be removed. Close the deal instead: update_deal with status lost or not_now."
  );
}

/** What points at the rows an undo would remove, by `<table>.<column>` and then by the value pointed at. */
type Pointers = Map<string, Map<string, Row[]>>;

const pointerKey = (dep: Dependent) => `${dep.table}.${dep.column}`;

/** For each foreign-key dependent of the tables being removed, one read of the rows that point at them. */
async function pointers(db: Db, deleting: Entry[]): Promise<Pointers> {
  const found: Pointers = new Map();
  for (const table of [...new Set(deleting.map((entry) => entry.table))]) {
    const values = deleting
      .filter((entry) => entry.table === table)
      .map((entry) => entry.after?.[primaryKey(table)])
      .filter((value): value is SqlValue => value !== undefined);
    for (const dep of DEPENDENTS[table] ?? []) {
      const columns = dep.table === "rule_firings" ? "deal_id" : "id";
      const rows = await rowsFor(
        db,
        values,
        `SELECT ${columns}, ${dep.column} AS undo_ref FROM ${dep.table} ` +
          `WHERE ${dep.column} IN (SELECT j.value FROM json_each(?) AS j) ORDER BY rowid`,
      );
      found.set(pointerKey(dep), groupBy(rows, "undo_ref"));
    }
  }
  return found;
}

/**
 * Refuses when a row the undo would remove has rule firings. A person whose firings all came from deal rules (they
 * record the deal's contact too) gets the deal's message, since closing the deal is the way out.
 */
async function ruleHistory(ctx: Ctx, changeId: string, deleting: Entry[], found: Pointers): Promise<void> {
  for (const entry of deleting) {
    const pkValue = entry.after?.[primaryKey(entry.table)];
    for (const dep of DEPENDENTS[entry.table] ?? []) {
      if (dep.table !== "rule_firings") continue;
      const firings = found.get(pointerKey(dep))?.get(String(pkValue)) ?? [];
      const [first] = firings;
      if (first === undefined) continue;
      const dealId = first.deal_id ?? null;
      if (entry.table === "contacts" && dealId !== null && firings.every((f) => f.deal_id !== null)) {
        const deal = await ctx.db.prepare("SELECT * FROM deals WHERE id = ?").bind(dealId).first<Row>();
        if (deal) throw new UserError(ruleHistoryMessage(changeId, { table: "deals", id: String(dealId), before: null, after: deal }));
      }
      throw new UserError(ruleHistoryMessage(changeId, entry));
    }
  }
}

const isOpenDeal = (row: Row | null) => row !== null && row.status === "open" && row.archived !== 1;

/**
 * An undo that would make a deal open again for a person who is an unqualified lead now would break invariant 1
 * (decision 0022), unless the contact row is part of the same undo. The refusal points to update_deal, which reopens
 * the deal and makes them Qualified in one change.
 */
async function reopenBlocker(ctx: Ctx, changeId: string, entries: Entry[], current: Map<Entry, Row | null>): Promise<string | null> {
  const contactsInUndo = new Set(entries.filter((entry) => entry.table === "contacts").map((entry) => entry.id));
  const reopening = entries.filter(
    (entry) =>
      entry.table === "deals" &&
      isOpenDeal(entry.before) &&
      !isOpenDeal(current.get(entry) ?? null) &&
      !contactsInUndo.has(String(entry.before?.contact_id)),
  );
  const people = await rowsFor(
    ctx.db,
    reopening.map((entry) => String(entry.before?.contact_id)),
    "SELECT * FROM contacts WHERE id IN (SELECT j.value FROM json_each(?) AS j)",
  );
  const byId = new Map(people.map((row) => [String(row.id), row as unknown as ContactRow]));
  for (const entry of reopening) {
    const deal = entry.before as Row;
    const contact = byId.get(String(deal.contact_id)) ?? null;
    if (contact === null || !isUnqualified(contact.lead_status) || contact.lead_status === null) continue;
    const dealRef = { id: String(deal.id), title: String(deal.title), untrusted_fields: deal.untrusted_fields };
    return (
      `Can't undo ${changeId}: it would reopen ${dealLabel(dealRef, contact)}, but ${contactName(contact)} is a lead now ` +
      `(${(await statusLabels(ctx.db)).lead(contact.lead_status)}). Reopen the deal with update_deal instead, which makes them a contact again.`
    );
  }
  return null;
}

/**
 * The other half of invariant 1: an undo that would make someone an unqualified lead again while they have an open deal
 * (one added since, such as a deal for a person qualified with no deal) is refused. Deals in the same undo count as
 * the undo leaves them. The refusal points to return_to_lead, which archives the deal and sets the status in one change.
 */
async function leadAgainBlocker(ctx: Ctx, changeId: string, entries: Entry[], current: Map<Entry, Row | null>): Promise<string | null> {
  const dealEntries = entries.filter((entry) => entry.table === "deals");
  const leads = entries.filter((entry) => {
    const status = entry.before?.lead_status;
    return entry.table === "contacts" && typeof status === "string" && isUnqualified(status);
  });
  const openDeals = groupBy(
    await rowsFor(
      ctx.db,
      leads.map((entry) => entry.id),
      "SELECT * FROM deals WHERE contact_id IN (SELECT j.value FROM json_each(?) AS j) AND status = 'open' AND archived = 0 " +
        "ORDER BY created_at, id",
    ),
    "contact_id",
  );
  for (const entry of leads) {
    const before = entry.before as Row;
    const status = before.lead_status as LeadStatus;
    const open = new Map((openDeals.get(entry.id) ?? []).map((row) => [String(row.id), row]));
    for (const deal of dealEntries) {
      if (isOpenDeal(deal.before) && deal.before?.contact_id === entry.id) open.set(deal.id, deal.before);
      else open.delete(deal.id);
    }
    if (open.size === 0) continue;
    const contact = current.get(entry) ?? before;
    const person = { id: entry.id, name: String(contact.name), untrusted_fields: contact.untrusted_fields };
    const who = `${contactName(person)} a lead again (${(await statusLabels(ctx.db)).lead(status)})`;
    const [only] = open.values();
    if (open.size === 1 && only !== undefined) {
      return (
        `Can't undo ${changeId}: it would make ${who}, but they have an open deal now, ${dealTitleOf(only)}. ` +
        "Use return_to_lead on that deal instead, or leave the change."
      );
    }
    return (
      `Can't undo ${changeId}: it would make ${who}, but they have ${open.size} open deals now. ` +
      "Close all but one and use return_to_lead on that one instead, or leave the change."
    );
  }
  return null;
}

/**
 * An undo that would archive a person status or sub-status again (undoing its bring-back) while someone has it would
 * leave them on a status the board can't offer, which archiving refuses too (decision 0040).
 */
async function archiveAgainBlocker(ctx: Ctx, changeId: string, entries: Entry[], current: Map<Entry, Row | null>): Promise<string | null> {
  for (const entry of entries) {
    if (entry.table !== "person_statuses" && entry.table !== "person_substatuses") continue;
    if (entry.before?.archived !== 1 || current.get(entry)?.archived !== 0) continue;
    const row = entry.before;
    const sql =
      entry.table === "person_statuses"
        ? "SELECT COUNT(*) AS n FROM contacts WHERE archived = 0 AND person_status = ?"
        : "SELECT COUNT(*) AS n FROM contacts WHERE archived = 0 AND person_status || '.' || sub_status = ?";
    const n = (await ctx.db.prepare(sql).bind(entry.id).first<number>("n")) ?? 0;
    if (n === 0) continue;
    const people = n === 1 ? "1 person has it" : `${n} people have it`;
    return `Can't undo ${changeId}: it would archive ${rowLabel(entry.table, row)} again, but ${people} now. Move them first, or leave the change.`;
  }
  return null;
}

const isRunningRow = (row: Row | null) => row !== null && row.ended_at === null && row.archived === 0;

/**
 * An undo that would make a timer run again (undoing its stop, or the archiving of a running one) while another timer
 * runs would break the one-running rule (decision 0049).
 */
async function runningAgainBlocker(ctx: Ctx, changeId: string, entries: Entry[], current: Map<Entry, Row | null>): Promise<string | null> {
  const timers = entries.filter((entry) => entry.table === "time_entries");
  const again = timers.filter((entry) => isRunningRow(entry.before) && !isRunningRow(current.get(entry) ?? null));
  if (again.length === 0) return null;
  const running = await ctx.db.prepare("SELECT id FROM time_entries WHERE ended_at IS NULL AND archived = 0").all<{ id: string }>();
  // A timer this undo removes or stops doesn't count.
  const leaving = new Set(timers.filter((entry) => !isRunningRow(entry.before)).map((entry) => entry.id));
  if (running.results.every((row) => leaving.has(row.id))) return null;
  return `Can't undo ${changeId}: it would start a timer again, but another one is running now. Stop it first, or leave the change.`;
}

async function dependents(ctx: Ctx, changeId: string, entries: Entry[]): Promise<string | null> {
  const deleting = entries.filter((entry) => entry.before === null);
  const found = await pointers(ctx.db, deleting);
  await ruleHistory(ctx, changeId, deleting, found);
  // Read before the counting below, filtered after it: rows the undo removes, or that point at them, don't count.
  const refs = deleting.flatMap((entry) => (entry.after === null ? [] : (JSON_DEPENDENTS[entry.table]?.(entry.after) ?? [])));
  const choices = choicesDropped(updatesOf(entries));
  const referrers = await jsonReferrers(ctx.db, [...refs, ...choices.map((choice) => choice.ref)]);

  const removed = new Set(deleting.map((entry) => rowKey(entry.table, entry.id)));
  // Rows the same undo puts back to a `before` that doesn't hold the reference stop holding it too (an import that
  // added a field and filled it on people already on file).
  const restored = new Map(updatesOf(entries).map((entry) => [rowKey(entry.table, entry.id), entry.before as Row]));
  const counts = new Map<string, { n: number; one: string; many: string }>();
  for (const entry of deleting) {
    const pkValue = entry.after?.[primaryKey(entry.table)];
    for (const dep of DEPENDENTS[entry.table] ?? []) {
      if (dep.table === "rule_firings") continue;
      for (const row of found.get(pointerKey(dep))?.get(String(pkValue)) ?? []) {
        const key = `${dep.table}:${String(row.id)}`;
        if (removed.has(key)) continue;
        // A row the same undo puts back to a `before` that doesn't point here (a stopped timer's link to its note).
        const before = restored.get(key);
        if (before !== undefined && dep.column in before && String(before[dep.column]) !== String(pkValue)) continue;
        removed.add(key);
        const tally = counts.get(dep.one) ?? { n: 0, one: dep.one, many: dep.many };
        tally.n += 1;
        counts.set(dep.one, tally);
      }
    }
  }
  const tallies = [...counts.values()].map((t) => `${t.n} ${t.n === 1 ? t.one : t.many}`);
  const parts = tallies.length === 0 ? [] : [joinAnd(tallies)];
  const users = (ref: JsonRef, i: number) =>
    (referrers[i] ?? []).filter((row) => {
      const key = rowKey(ref.table, String(row.id));
      if (removed.has(key)) return false;
      if (ref.table === "views" && row.archived === 1) return false;
      const before = restored.get(key);
      return before === undefined || holdsRef(ref, before);
    });
  refs.forEach((ref, i) => {
    const rows = users(ref, i);
    if (rows.length > 0) parts.push(ref.what(labelList(rows.map((row) => refLabel(ref.table, row))), rows.length));
  });
  choices.forEach(({ ref, choice, label }, i) => {
    const rows = users(ref, refs.length + i);
    if (rows.length === 0) return;
    const labels = labelList(rows.map((row) => refLabel(ref.table, row)));
    parts.push(`the choice ${choice} of ${label} is used by ${labels}`);
  });
  return parts.length === 0 ? null : parts.join("; ");
}

/**
 * For each reference, the rows of its table whose JSON column holds it, ordered by created_at and id. References of
 * the same table, column and kind are read together: their paths (and values) go through json_each.
 */
async function jsonReferrers(db: Db, refs: readonly JsonRef[]): Promise<Row[][]> {
  const out: Row[][] = refs.map(() => []);
  const groups = new Map<string, number[]>();
  refs.forEach((ref, i) => {
    const key = `${ref.table} ${ref.column} ${ref.equals === undefined ? "set" : "equals"}`;
    const group = groups.get(key);
    if (group) group.push(i);
    else groups.set(key, [i]);
  });
  for (const indexes of groups.values()) {
    const [first] = indexes;
    const sample = refs[first ?? 0];
    if (sample === undefined) continue;
    const { table, column } = sample;
    const test =
      sample.equals === undefined
        ? `json_extract(t.${column}, json_extract(j.value, '$.p')) IS NOT NULL`
        : `json_extract(t.${column}, json_extract(j.value, '$.p')) = json_extract(j.value, '$.e')`;
    // A handful of field and stage keys: one small JSON parameter, never near CHUNK_BYTES.
    const items = indexes.map((i) => ({ i, p: refs[i]?.path, e: refs[i]?.equals ?? null }));
    const rows = await db
      .prepare(
        `SELECT t.*, json_extract(j.value, '$.i') AS undo_ref FROM ${table} AS t ` +
          `JOIN json_each(?) AS j ON ${test} ORDER BY t.created_at, t.id`,
      )
      .bind(JSON.stringify(items))
      .all<Row>();
    for (const { undo_ref: ref, ...row } of rows.results) out[Number(ref)]?.push(row);
  }
  return out;
}

/** Whether a row holds the reference, read the way jsonReferrers' SQL reads it (a null value doesn't count). */
function holdsRef(ref: JsonRef, row: Row): boolean {
  let value: unknown;
  try {
    const parsed: unknown = JSON.parse(String(row[ref.column] ?? "{}"));
    value = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)[ref.key] : undefined;
  } catch {
    return true;
  }
  return ref.equals === undefined ? value !== undefined && value !== null : value === ref.equals;
}

const updatesOf = (entries: Entry[]) => entries.filter((entry) => entry.before !== null && entry.after !== null);

const choiceList = (row: Row): string[] => (typeof row.choices === "string" ? parseStringArray(row.choices) : []);

/** The choices an undo of update_field would drop from a field, each with the reference that finds its users. */
function choicesDropped(updates: Entry[]): { ref: JsonRef; choice: string; label: string }[] {
  const out: { ref: JsonRef; choice: string; label: string }[] = [];
  for (const { table, before, after } of updates) {
    if (table !== "field_defs" || before === null || after === null) continue;
    const restored = new Set(choiceList(before));
    const [ref] = JSON_DEPENDENTS.field_defs?.(after) ?? [];
    if (!ref) continue;
    for (const choice of choiceList(after).filter((c) => !restored.has(c))) {
      out.push({ ref: { ...ref, equals: choice }, choice, label: short(String(after.label), 60) });
    }
  }
  return out;
}

/** "Moved "Website refresh" back to Replied", "Removed contact Pat Example and deal "Website refresh"", ... */
function describeUndo(entries: Entry[], labels: Map<string, string>): string {
  const removed: string[] = [];
  const parts: string[] = [];
  for (const { table, before, after } of entries) {
    if (before === null && after !== null) {
      if (!isOwnStageChange(table, after)) removed.push(rowLabel(table, after));
    } else if (before !== null && after === null) {
      parts.push(`restored ${rowLabel(table, before)}`);
    } else if (before !== null && after !== null) {
      let columns = changedColumns(before, after).filter((c) => !BOOKKEEPING.has(c));
      // A person's status moves with their lead status (decision 0040); the lead status says it once.
      if (columns.includes("lead_status")) columns = columns.filter((c) => c !== "person_status" && c !== "sub_status");
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

const isOwnStageChange = (table: ChangeTable, after: Row) => table === "activities" && after.type === "stage_change";

const NOUNS: Record<ChangeTable, [string, string]> = {
  settings: ["settings record", "settings records"],
  stages: ["stage", "stages"],
  field_defs: ["field", "fields"],
  contacts: ["contact", "contacts"],
  deals: ["deal", "deals"],
  activities: ["activity", "activities"],
  tasks: ["task", "tasks"],
  rules: ["rule", "rules"],
  rule_firings: ["rule firing", "rule firings"],
  rulebook: ["rulebook document", "rulebook documents"],
  push_subscriptions: ["notification device", "notification devices"],
  person_statuses: ["person status", "person statuses"],
  person_substatuses: ["sub-status", "sub-statuses"],
  views: ["view", "views"],
  work_types: ["work type", "work types"],
  client_rates: ["client rate", "client rates"],
  time_entries: ["time entry", "time entries"],
  project_statuses: ["project status", "project statuses"],
  projects: ["project", "projects"],
  campaigns: ["campaign", "campaigns"],
  campaign_steps: ["campaign email", "campaign emails"],
  email_suppressions: ["campaign email block", "campaign email blocks"],
};

/** "2,000 contacts and 3 fields": the entries counted by table, in the order the tables first appear. */
function counted(entries: Entry[]): string {
  const counts = new Map<ChangeTable, number>();
  for (const { table } of entries) counts.set(table, (counts.get(table) ?? 0) + 1);
  return joinAnd(
    [...counts].map(([table, n]) => `${n.toLocaleString("en-US")} ${n === 1 ? NOUNS[table][0] : NOUNS[table][1]}`),
  );
}

/** A big undo in counts, never names: "Removed 2,000 contacts and put back the earlier values on 40 contacts". */
function describeBulkUndo(entries: Entry[]): string {
  const removed = entries.filter((e) => e.before === null && e.after !== null && !isOwnStageChange(e.table, e.after));
  const restored = entries.filter((e) => e.before !== null && e.after === null);
  const updated = updatesOf(entries);
  const parts = [
    removed.length > 0 ? `removed ${counted(removed)}` : null,
    restored.length > 0 ? `restored ${counted(restored)}` : null,
    updated.length > 0 ? `put back the earlier values on ${counted(updated)}` : null,
  ].filter((part) => part !== null);
  return capitalize(joinAnd(parts) || "put back the earlier values");
}

/** Records of these tables that a change added and its undo would remove, in this order. */
const REMOVABLE = ["contacts", "deals", "tasks", "activities"] as const;

export type Removal = { table: (typeof REMOVABLE)[number]; count: number };

/**
 * What undoing the change would remove: the contacts, deals, tasks and activities it added, counted by table. A move's
 * own stage-change entry is left out (undoing the move only puts the stage back). Empty for a change that only
 * changed values, or that is unknown (undoChange then says why). The board asks first when this is not empty.
 */
export async function undoRemovals(db: Ctx["db"], changeId: string): Promise<Removal[]> {
  const audit = await db.prepare("SELECT * FROM audit_log WHERE id = ?").bind(changeId.trim()).first<AuditRow>();
  if (!audit) return [];
  const added = (await entriesOf(db, audit)).filter(
    (entry) => entry.before === null && entry.after !== null && !isOwnStageChange(entry.table, entry.after),
  );
  return REMOVABLE.map((table) => ({ table, count: added.filter((entry) => entry.table === table).length })).filter(
    (removal) => removal.count > 0,
  );
}

export async function undoChange(ctx: Ctx, changeId: string): Promise<ChangeResult> {
  const { db } = ctx;
  const id = changeId.trim();
  const original = await db.prepare("SELECT * FROM audit_log WHERE id = ?").bind(id).first<AuditRow>();
  if (!original) throw new UserError(`There's no change ${id}. Use recent_changes to find the change id.`);
  if (original.undo_of !== null) throw new UserError("Undo entries can't be undone; make the change again instead.");
  if (isFinalTool(original.tool)) throw new UserError(finalMessage(id, original.tool));
  if (original.undone_at !== null) throw new UserError(alreadyUndone(id, original));
  if (!isChangeTable(original.target_table)) throw new Error(`Change ${id} targets an unknown table.`);

  const entries = await entriesOf(db, original);
  const current = await currentRows(db, entries);

  const blockers = await dependents(ctx, id, entries);
  if (blockers !== null) throw new UserError(dependsMessage(id, blockers));
  const moved = entries.find((entry) => !sameRow(current.get(entry) ?? null, entry.after));
  if (moved) {
    const row = current.get(moved) ?? moved.after ?? moved.before;
    throw new UserError(changedMessage(id, row ? rowLabel(moved.table, row) : `${moved.table}:${moved.id}`));
  }
  const reopening =
    (await reopenBlocker(ctx, id, entries, current)) ??
    (await leadAgainBlocker(ctx, id, entries, current)) ??
    (await archiveAgainBlocker(ctx, id, entries, current)) ??
    (await runningAgainBlocker(ctx, id, entries, current));
  if (reopening !== null) throw new UserError(reopening);

  const changes: RowChange[] = [...entries].reverse().map((entry) => {
    const now = current.get(entry) ?? null;
    let restored: Row | null = entry.before;
    if (restored !== null && now !== null) {
      restored = { ...restored };
      if (typeof now.version === "number") restored.version = now.version + 1;
      if ("updated_at" in restored) restored.updated_at = ctx.now.toISOString();
      if (entry.table === "contacts" && !("person_status" in restored)) {
        // A snapshot from before migration 0011 has no status columns: put back what the migration would have given
        // its lead status, so the status and the lead status still agree (decision 0040).
        Object.assign(restored, migratedPersonColumns(restored.lead_status));
      }
      if (entry.table === "rules" && restored.active === 1 && now.active === 0) {
        // An undone pause is a resume, with the same cut-over (decision 0010).
        restored.params = resumedParams({ type: restored.type as RuleType, params: String(restored.params) }, ctx.now);
      }
    }
    return { table: entry.table, id: entry.id, before: now, after: restored };
  });

  const big = original.parts > 0 || entries.length > BULK_ROWS;
  const undoId = newId("chg");
  const extra = [
    db.prepare("INSERT INTO write_guard (ok) SELECT COUNT(*) = 1 FROM audit_log WHERE id = ? AND undone_at IS NULL").bind(id),
    db.prepare("UPDATE audit_log SET undone_at = ?, undone_by = ? WHERE id = ?").bind(ctx.now.toISOString(), undoId, id),
  ];
  try {
    return await commitChange(ctx, {
      target: { table: original.target_table, id: original.target_id },
      summary: `Undid ${id}: ${big ? describeBulkUndo(entries) : describeUndo(entries, await stageLabels(db))}`,
      changes,
      extra,
      changeId: undoId,
      undoOf: id,
      bulk: big && entries.every((entry) => isBulkTable(entry.table)),
    });
  } catch (error) {
    if (error instanceof StaleWriteError) {
      // Another undo of this change may have won the race: say so instead of blaming a later edit.
      const latest = await db.prepare("SELECT * FROM audit_log WHERE id = ?").bind(id).first<AuditRow>();
      if (latest?.undone_at) throw new UserError(alreadyUndone(id, latest), { cause: error });
      throw new UserError(changedMessage(id, "a record it touched"), { cause: error });
    }
    if (isForeignKeyFailure(error)) throw new UserError(dependsMessage(id, "records added since"), { cause: error });
    if (isRunningTimerFailure(error)) {
      throw new UserError(`Can't undo ${id}: it would start a timer again, but another one is running now. Stop it first, or leave the change.`, { cause: error });
    }
    if (isSuppressionEmailFailure(error)) {
      throw new UserError(`Can't undo ${id}: that address has a newer block. Leave the change.`, { cause: error });
    }
    if (isWorkTypeNameFailure(error) || isClientRatePairFailure(error)) {
      throw new UserError(`Can't undo ${id}: a work type or client rate it would put back has been set again since. Change that one first, or leave the change.`, { cause: error });
    }
    throw error;
  }
}
