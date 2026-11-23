// Importing over MCP (decision 0039): the owner's AI app sends a sheet's rows to import_rows in calls of up to 500,
// which keeps them in an import draft (the board's drafts, migration 0010, as CSV text) and answers the same preview the
// board's check step shows, planned against the records on file now. apply_import plans the draft once more and writes
// it as one audited change (actor ai, tool apply_import), in the batch that marks the draft applied, so a second apply
// writes nothing and answers the first change's line. Draft writes are scratch, not audited, as on the board.
// Every answer gives counts, line numbers, ids, built-in column keys and the owner's field and stage labels, never a
// value from a row or a column's name: columns are named by number. The plan's options are built from fixed keys here;
// nothing an MCP call sends reaches them except the three choices below.
import type { ContactRow, Db, FieldDefRow, StageRow } from "../db/db.ts";
import { listFieldDefs } from "../db/queries.ts";
import { csvLines, toCsv } from "../http/csv.ts";
import { isImportId, newId } from "../ids.ts";
import {
  appendDraft,
  appliedStatements,
  createDraft,
  deleteExpiredDrafts,
  type Draft,
  type DraftChoices,
  draftGuard,
  draftText,
  getDraft,
  type ImportResult,
  markApplied,
} from "../import/drafts.ts";
import {
  autoMatch,
  fileChange,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  type ImportModuleKey,
  type MappedRow,
  MappingError,
  mapRows,
  type ModuleShape,
  planNewFields,
  planRows,
  readCsv,
  type Target,
} from "../import/engine.ts";
import { contactsOnFile, dealsOnFile, tasksOnFile } from "../import/load.ts";
import { type DealsCtx, type DealsPlan, dealsModule } from "../import/modules/deals.ts";
import { IMPORT_MODULES } from "../import/modules/index.ts";
import { type PeoplePlan, peopleModule } from "../import/modules/people.ts";
import { type TasksCtx, type TasksPlan, tasksModule } from "../import/modules/tasks.ts";
import { RecordTooLargeError } from "./bulk.ts";
import { type ChangeInput, commitChange, isDuplicateEmailFailure, isDuplicateIdFailure, StaleWriteError } from "./change.ts";
import { UserError } from "./errors.ts";

/** The most rows one import_rows call takes. */
export const IMPORT_ROWS_PER_CALL = 500;

/** The most columns an MCP import takes. */
export const IMPORT_MAX_MCP_COLUMNS = 60;

/** How many lines each list in the preview shows, as on the board's check step. */
const SHOWN = 20;

export const IMPORT_GONE = "That import has expired or doesn't exist. Start again with import_rows.";

const TOOL = "apply_import";

export interface ImportRowsInput {
  module: ImportModuleKey;
  draft?: string | undefined;
  columns: readonly string[];
  rows: readonly (readonly string[])[];
  mapping?: Readonly<Record<string, string>> | undefined;
  as?: "contacts" | "leads" | undefined;
  allowDuplicates?: boolean | undefined;
  closedDeals?: boolean | undefined;
}

export interface ImportCtx {
  db: Db;
  now: Date;
}

const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;

const IMPORT_NOUN: Record<ImportModuleKey, string> = { people: "your contacts", deals: "your deals", tasks: "your tasks" };

type Planned =
  | { module: "people"; plan: PeoplePlan; ctx: ContactRow[]; newFields: FieldDefRow[] }
  | { module: "deals"; plan: DealsPlan; ctx: DealsCtx; newFields: FieldDefRow[] }
  | { module: "tasks"; plan: TasksPlan; ctx: TasksCtx; newFields: FieldDefRow[] };

interface Mapped {
  rows: MappedRow[];
  newFields: FieldDefRow[];
  fieldDefs: FieldDefRow[];
}

/**
 * The file mapped as the draft says. Lines count the columns as line 1 and each row, in the order sent, from line 2,
 * so a line is the sheet's row number even when a value holds a line break (which a CSV file would count again).
 */
function mapDraft(module: ModuleShape, text: string, targets: readonly Target[], fieldDefs: readonly FieldDefRow[], now: Date): Mapped {
  const { header, records } = readCsv(text);
  try {
    const { targets: resolved, created } = planNewFields(module, header, targets, fieldDefs, now);
    const all = [...fieldDefs, ...created];
    const numbered = records.map((record, i) => ({ line: i + 2, fields: record.fields }));
    return { rows: mapRows(module, numbered, resolved, header, all), newFields: created, fieldDefs: all };
  } catch (error) {
    // The board shows a mapping problem beside its column; here the message names the column when it doesn't yet.
    if (error instanceof MappingError && !new RegExp(`\\bcolumn ${error.column + 1}\\b`, "i").test(error.message)) {
      throw new UserError(`Column ${error.column + 1}: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

type Choices = Required<DraftChoices>;

async function planDraft(db: Db, module: ImportModuleKey, text: string, mapping: readonly Target[], choices: Choices, now: Date): Promise<Planned> {
  const fieldDefs = await listFieldDefs(db, { includeArchived: true });
  switch (module) {
    case "people": {
      const mapped = mapDraft(peopleModule, text, mapping, fieldDefs, now);
      const ctx = await contactsOnFile(db);
      const options = { asLeads: choices.asLeads, allowDuplicates: choices.allowDuplicates, fieldDefs: mapped.fieldDefs };
      return { module, ctx, newFields: mapped.newFields, plan: planRows(peopleModule, mapped.rows, ctx, options) };
    }
    case "deals": {
      const mapped = mapDraft(dealsModule, text, mapping, fieldDefs, now);
      const ctx = await dealsOnFile(db, mapped.rows);
      const options = { closedAsHistory: choices.closedAsHistory, fieldDefs: mapped.fieldDefs };
      return { module, ctx, newFields: mapped.newFields, plan: planRows(dealsModule, mapped.rows, ctx, options) };
    }
    case "tasks": {
      const mapped = mapDraft(tasksModule, text, mapping, fieldDefs, now);
      const ctx = await tasksOnFile(db, mapped.rows);
      return { module, ctx, newFields: mapped.newFields, plan: planRows(tasksModule, mapped.rows, ctx, { fieldDefs: mapped.fieldDefs }) };
    }
  }
}

function changeOf(planned: Planned, now: Date): ChangeInput | null {
  switch (planned.module) {
    case "people":
      return fileChange(peopleModule, planned.plan, planned.ctx, now, planned.newFields);
    case "deals":
      return fileChange(dealsModule, planned.plan, planned.ctx, now, planned.newFields);
    case "tasks":
      return fileChange(tasksModule, planned.plan, planned.ctx, now, planned.newFields);
  }
}

/** The counts the board's check step forecasts (wrote false) and an applied draft keeps. */
function resultOf(planned: Planned, wrote: boolean): ImportResult {
  const { plan } = planned;
  const base: ImportResult = {
    created: plan.create.length,
    filled: plan.merge.length,
    unchanged: plan.unchanged.length,
    skipped: plan.skipped.length,
    duplicates: 0,
    fields: wrote ? planned.newFields.length : 0,
    people: 0,
    closed: 0,
    archived: 0,
  };
  switch (planned.module) {
    case "people":
      return { ...base, duplicates: planned.plan.duplicates.length, archived: planned.plan.archived.length };
    case "deals":
      return {
        ...base,
        people: planned.plan.people.length,
        closed: planned.plan.create.filter((row) => row.status !== "open").length,
        archived: planned.plan.archived.length,
      };
    case "tasks":
      return base;
  }
}

/** One mapping value as a target; refuses, naming the column by number, anything that isn't one. */
function targetOf(module: (typeof IMPORT_MODULES)[ImportModuleKey], value: string, column: number): Target {
  const where = `column ${column + 1}`;
  if (value === "skip") return { kind: "skip" };
  const match = /^(builtin|field|new_field|notes):(.*)$/s.exec(value);
  const [, kind, rest = ""] = match ?? [];
  switch (kind) {
    case "builtin":
      if (!module.columns.some((col) => col.key === rest)) {
        throw new UserError(
          `The mapping sends ${where} to a built-in column ${module.noun.many} don't have. ` +
            `Use builtin: with one of ${module.columns.map((col) => col.key).join(", ")}.`,
        );
      }
      return { kind, key: rest };
    case "field":
      return { kind, key: rest.trim() };
    case "new_field":
    case "notes":
      return { kind, label: rest };
    default:
      throw new UserError(
        `The mapping for ${where} isn't one of builtin:<key>, field:<key>, new_field:<label>, notes:<label> or skip.`,
      );
  }
}

/** Where each column goes: the mapping's choice, by column name, else matched by name as the board does. */
function targetsFor(
  module: (typeof IMPORT_MODULES)[ImportModuleKey],
  columns: readonly string[],
  mapping: Readonly<Record<string, string>> | undefined,
  fieldDefs: readonly FieldDefRow[],
): Target[] {
  const auto = autoMatch(module, [...columns], fieldDefs);
  if (mapping === undefined) return auto;
  const chosen = new Map<number, string>();
  for (const [name, value] of Object.entries(mapping)) {
    const at = columns.flatMap((column, i) => (column === name ? [i] : []));
    const [first, second] = at;
    if (first === undefined) {
      throw new UserError("The mapping names a column that isn't in columns. Use each column's name exactly as columns gives it.");
    }
    if (second !== undefined) {
      throw new UserError(
        `Columns ${first + 1} and ${second + 1} have the same name, so the mapping can't tell them apart. Give them different names in columns.`,
      );
    }
    chosen.set(first, value);
  }
  return columns.map((_, i) => {
    const value = chosen.get(i);
    return value === undefined ? (auto[i] ?? { kind: "skip" }) : targetOf(module, value, i);
  });
}

/** Refuses a choice the module doesn't have, so a call never thinks it set one. */
function checkChoices(input: ImportRowsInput): void {
  const only = (name: string, module: ImportModuleKey, what: string) => {
    if (input.module !== module) throw new UserError(`${name} is for ${what} imports only. Leave it out for a ${input.module} import.`);
  };
  if (input.as !== undefined) only("as", "people", "people");
  if (input.allowDuplicates !== undefined) only("allow_duplicates", "people", "people");
  if (input.closedDeals !== undefined) only("closed_deals", "deals", "deals");
}

function checkRows(input: ImportRowsInput): void {
  const { rows, columns } = input;
  if (rows.length > IMPORT_ROWS_PER_CALL) {
    throw new UserError(
      `This call sends ${count(rows.length)} rows. import_rows takes at most ${IMPORT_ROWS_PER_CALL} a call: send the first ` +
        `${IMPORT_ROWS_PER_CALL}, then the rest in more calls of up to ${IMPORT_ROWS_PER_CALL}, each with draft set to the id the first answers.`,
    );
  }
  if (columns.length > IMPORT_MAX_MCP_COLUMNS) {
    throw new UserError(`This sheet has ${columns.length} columns. One import takes at most ${IMPORT_MAX_MCP_COLUMNS}. Leave out the columns you don't need.`);
  }
  const long = rows.findIndex((row) => row.length > columns.length);
  if (long !== -1) {
    throw new UserError(
      `Row ${count(long + 1)} of this call has ${rows[long]?.length ?? 0} values but columns names ${columns.length}. ` +
        "Give each row one value per column, in the order of columns (a short row is fine: the missing values are empty).",
    );
  }
}

/** The draft a call names, checked against the call. */
async function openDraft(db: Db, id: string, input: ImportRowsInput, now: Date): Promise<{ draft: Draft; text: string }> {
  const draft = isImportId(id) ? await getDraft(db, id, now) : null;
  if (draft === null) throw new UserError(IMPORT_GONE);
  if (draft.result !== null) {
    throw new UserError(`Import ${draft.id} was already applied, so no rows can be added to it. Start a new one with import_rows and no draft.`);
  }
  if (draft.module !== input.module) {
    throw new UserError(`Import ${draft.id} is a ${draft.module} import. Send module ${draft.module}, or start a new import with no draft.`);
  }
  const text = await draftText(db, draft.id);
  const { header } = readCsv(text);
  if (header.length !== input.columns.length || header.some((name, i) => name !== input.columns[i])) {
    throw new UserError(
      `These columns aren't the ones import ${draft.id} started with. Send the same columns, in the same order, as the first call.`,
    );
  }
  return { draft, text };
}

const joined = (text: string, more: string) => (text === "" || /[\r\n]$/.test(text) ? text + more : `${text}\r\n${more}`);

function checkSize(text: string, rows: number): void {
  if (rows > IMPORT_MAX_ROWS) {
    throw new UserError(
      `With these rows the import would have ${count(rows)} rows. One import takes at most ${count(IMPORT_MAX_ROWS)}. ` +
        "Apply this one without them, then start another import with the rest.",
    );
  }
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > IMPORT_MAX_BYTES) {
    const mb = (Math.ceil((bytes * 10) / IMPORT_MAX_BYTES) / 10).toFixed(1);
    throw new UserError(
      `With these rows the import would be ${mb} MB. One import takes at most 1 MB. Apply this one without them, then start another import with the rest.`,
    );
  }
}

export interface ImportPreview {
  headline: string;
  data: Record<string, unknown>;
}

/**
 * import_rows: starts a draft, or adds rows to one (the same module and columns), saving the mapping and choices the
 * call gives (a call that leaves them out keeps the draft's), then answers the preview. Only the draft is written.
 */
export async function importRows(ctx: ImportCtx, input: ImportRowsInput): Promise<ImportPreview> {
  const { db, now } = ctx;
  checkChoices(input);
  checkRows(input);
  await deleteExpiredDrafts(db, now);
  const opened = input.draft === undefined ? null : await openDraft(db, input.draft, input, now);
  if (opened === null && input.rows.length === 0) {
    throw new UserError("Send at least one row. Only a call with draft may send no rows (to change the mapping or the choices).");
  }
  const module = IMPORT_MODULES[input.module];
  const fieldDefs = await listFieldDefs(db, { includeArchived: true });
  const mapping = input.mapping === undefined && opened !== null ? opened.draft.mapping : targetsFor(module, input.columns, input.mapping, fieldDefs);
  const previous = opened?.draft;
  const choices: Choices = {
    asLeads: input.module === "people" && (input.as === undefined ? previous?.asLeads === true : input.as === "leads"),
    allowDuplicates: input.module === "people" && (input.allowDuplicates ?? previous?.allowDuplicates ?? false),
    closedAsHistory: input.module === "deals" && (input.closedDeals ?? previous?.closedAsHistory ?? false),
  };
  const added = csvLines(input.rows);
  const text = opened === null ? toCsv([], input.columns) + added : joined(opened.text, added);
  const before = opened === null ? 0 : readCsv(opened.text).records.length;
  checkSize(text, before + input.rows.length);
  // Planned before anything is saved, so a mapping that can't work is refused with nothing written.
  const planned = await planDraft(db, input.module, text, mapping, choices, now);
  let draft: Draft | null;
  if (opened === null) {
    const id = await createDraft(db, { module: input.module, text, mapping, ...choices, now });
    draft = await getDraft(db, id, now);
  } else {
    if (!(await appendDraft(db, opened.draft, { text: added, mapping, choices }, now))) {
      throw new UserError(
        `Import ${opened.draft.id} changed while these rows were being added (another call, or the board), so they weren't added. Send them again.`,
      );
    }
    draft = await getDraft(db, opened.draft.id, now);
  }
  if (draft === null) throw new UserError(IMPORT_GONE);
  return previewOf(draft, planned, before + input.rows.length);
}

const firstOf = <T>(list: readonly T[]) => list.slice(0, SHOWN);

function closedByStage(closed: DealsPlan["closed"], stages: readonly StageRow[]): { stage: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of closed) counts.set(row.stageKey, (counts.get(row.stageKey) ?? 0) + 1);
  return [...stages]
    .sort((a, b) => a.position - b.position)
    .filter((stage) => counts.has(stage.key))
    .map((stage) => ({ stage: stage.label, count: counts.get(stage.key) ?? 0 }));
}

/** The board's check-step preview as data: counts, line numbers, ids and labels only. */
function previewOf(draft: Draft, planned: Planned, rows: number): ImportPreview {
  const { plan } = planned;
  const result = { ...resultOf(planned, false), fields: planned.newFields.length };
  const notes: string[] = [];
  const counts: Record<string, number> = {
    new: result.created,
    filledIn: result.filled,
    alreadyUpToDate: result.unchanged,
    skipped: result.skipped,
  };
  const data: Record<string, unknown> = {
    draft: draft.id,
    module: draft.module,
    expiresAt: draft.expiresAt,
    rows,
    counts,
  };
  let parts: string[];
  switch (planned.module) {
    case "people": {
      const { duplicates } = planned.plan;
      counts.possibleDuplicates = duplicates.length;
      counts.archivedInFile = result.archived;
      data.as = draft.asLeads ? "leads" : "contacts";
      data.allowDuplicates = draft.allowDuplicates;
      data.duplicates = firstOf(duplicates).map((row) =>
        row.ofId === null ? { line: row.line, sameBusinessAsLine: row.ofLine } : { line: row.line, sameBusinessAs: row.ofId },
      );
      if (duplicates.length > 0) {
        notes.push(
          `${plural(duplicates.length, "line has", "lines have")} no email and the same business as someone on file or an earlier line, ` +
            "so they are left out. To bring them in too, ask the owner, then call import_rows with this draft, the same columns, no rows and allow_duplicates true.",
        );
      }
      parts = [
        `${plural(result.created, draft.asLeads ? "new lead" : "new contact", draft.asLeads ? "new leads" : "new contacts")}`,
        `${count(result.filled)} to fill in`,
        `${count(result.unchanged)} already up to date`,
        `${count(result.skipped)} skipped`,
        plural(duplicates.length, "possible duplicate", "possible duplicates"),
      ];
      break;
    }
    case "deals": {
      const { closed, people, qualify } = planned.plan;
      counts.newPeople = result.people;
      counts.closedDealsInFile = closed.length;
      counts.archivedInFile = result.archived;
      data.closedDeals = draft.closedAsHistory;
      data.closedByStage = closedByStage(closed, planned.ctx.stages);
      data.newPeopleLines = firstOf(people.map((person) => person.line));
      data.qualified = firstOf(qualify);
      if (closed.length > 0 && !draft.closedAsHistory) {
        notes.push(
          `${plural(closed.length, "deal is", "deals are")} in a closed stage and skipped. To bring them in as history, ask the owner, ` +
            "then call import_rows with this draft, the same columns, no rows and closed_deals true.",
        );
      }
      parts = [
        plural(result.created, "new deal", "new deals"),
        plural(result.people, "new person", "new people"),
        `${count(result.filled)} to fill in`,
        `${count(result.unchanged)} already up to date`,
        `${count(result.skipped)} skipped`,
        `${count(closed.length)} closed in the file`,
      ];
      break;
    }
    case "tasks":
      parts = [
        plural(result.created, "new task", "new tasks"),
        `${count(result.filled)} to fill in`,
        `${count(result.unchanged)} already up to date`,
        `${count(result.skipped)} skipped`,
      ];
      break;
  }
  counts.newFields = planned.newFields.length;
  data.newFields = planned.newFields.map((def) => ({ entity: def.entity, label: def.label, key: def.key }));
  data.skippedLines = firstOf(plan.skipped).map((row) => ({ line: row.line, reason: row.reason }));
  data.filledIn = firstOf<{ line: number; id: string }>(plan.merge).map((row) => ({ line: row.line, id: row.id }));
  const writes = plan.create.length + plan.merge.length > 0;
  data.willWrite = writes;
  if (plan.skipped.length > SHOWN) notes.push(`Only the first ${SHOWN} skipped lines are listed; ${count(plan.skipped.length - SHOWN)} more are skipped.`);
  if (!writes) notes.push(`Nothing in this import would change ${IMPORT_NOUN[draft.module]} as it stands.`);
  data.notes = notes;
  const fields = planned.newFields.length > 0 ? `, ${plural(planned.newFields.length, "new field", "new fields")}` : "";
  const headline =
    `Import ${draft.id} (${plural(rows, "row", "rows")}, not saved): ${parts.join(", ")}${fields}. ` +
    "Show the owner this preview; apply_import saves it once they say yes.";
  return { headline, data };
}

export interface AppliedImport {
  summary: string;
  changeId: string | null;
  draft: string;
  alreadyApplied: boolean;
}

/** What an applied draft did: its change's line, or that it changed nothing. */
async function appliedAnswer(db: Db, draft: Draft): Promise<AppliedImport> {
  if (draft.changeId === null) {
    return { summary: `Import ${draft.id} was already applied and changed nothing.`, changeId: null, draft: draft.id, alreadyApplied: true };
  }
  const audit = await db.prepare("SELECT summary FROM audit_log WHERE id = ?").bind(draft.changeId).first<{ summary: string }>();
  const line = audit?.summary ?? `(change ${draft.changeId})`;
  return { summary: `Import ${draft.id} was already applied: ${line}`, changeId: draft.changeId, draft: draft.id, alreadyApplied: true };
}

/** After a failed or lost apply: the winner's answer if another apply of this draft won, else null. */
async function settled(db: Db, id: string, now: Date): Promise<AppliedImport | null> {
  const latest = await getDraft(db, id, now);
  if (latest === null) throw new UserError(IMPORT_GONE);
  return latest.result === null ? null : appliedAnswer(db, latest);
}

const AGAIN = "Check the preview again (import_rows with this draft, the same columns and no rows), then apply.";

/** apply_import: the draft planned against the records on file now, written as one change. */
export async function applyImport(ctx: ImportCtx, id: string): Promise<AppliedImport> {
  const { db, now } = ctx;
  await deleteExpiredDrafts(db, now);
  const draft = isImportId(id) ? await getDraft(db, id, now) : null;
  if (draft === null) throw new UserError(IMPORT_GONE);
  if (draft.result !== null) return appliedAnswer(db, draft);
  let planned: Planned;
  try {
    const choices = { asLeads: draft.asLeads, allowDuplicates: draft.allowDuplicates, closedAsHistory: draft.closedAsHistory };
    planned = await planDraft(db, draft.module, await draftText(db, draft.id), draft.mapping, choices, now);
  } catch (error) {
    const answer = await settled(db, draft.id, now);
    if (answer !== null) return answer;
    throw error;
  }
  const input = changeOf(planned, now);
  if (input === null) {
    if (await markApplied(db, draft, resultOf(planned, false), now)) {
      return { summary: `Nothing in import ${draft.id} would change ${IMPORT_NOUN[draft.module]}, so nothing was saved.`, changeId: null, draft: draft.id, alreadyApplied: false };
    }
    const answer = await settled(db, draft.id, now);
    if (answer !== null) return answer;
    throw new UserError(`Import ${draft.id} changed while it was saving, so nothing was saved. ${AGAIN}`);
  }
  const changeId = newId("chg");
  try {
    const { summary } = await commitChange(
      { db, now, actor: "ai", tool: TOOL },
      { ...input, changeId, leading: [draftGuard(db, draft, now)], extra: appliedStatements(db, draft, resultOf(planned, true), changeId) },
    );
    return { summary, changeId, draft: draft.id, alreadyApplied: false };
  } catch (error) {
    const answer = await settled(db, draft.id, now);
    if (answer !== null) return answer;
    throw refusal(error, draft.module);
  }
}

/** A failed apply in plain English; anything unexpected as it is. */
function refusal(error: unknown, module: ImportModuleKey): unknown {
  const records = module === "people" ? "people" : module;
  if (error instanceof StaleWriteError) {
    return new UserError(`A record this import touches was changed while it was importing, so nothing was saved. ${AGAIN}`, { cause: error });
  }
  // Before the email check, which matches every unique failure on contacts.
  if (isDuplicateIdFailure(error)) {
    return new UserError(`A record with an id in this import was added while it was importing, so nothing was saved. ${AGAIN}`, { cause: error });
  }
  if (isDuplicateEmailFailure(error)) {
    return new UserError(`Someone with an email in this import was added while it was importing, so nothing was saved. ${AGAIN}`, { cause: error });
  }
  if (error instanceof RecordTooLargeError) {
    return new UserError(
      `${module === "people" ? "Someone on file" : "A record on file"} is too large to fill in with this import in one step, so ` +
        `nothing was saved. Leave out the columns that fill in details on ${records} already on file, or shorten the longest values, and try again.`,
      { cause: error },
    );
  }
  return error;
}
