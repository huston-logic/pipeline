// The People import module (decisions 0029, 0034): which rows become new contacts, which fill in details on a
// contact already on file (matched by email, ignoring case), and which are skipped and why; then the one audited
// change (actor owner, tool "import") that writes them. Every imported value is outside text: the change lists it in
// the contact's untrusted_fields.
// Leads (decision 0022): `asLeads` gives created rows the status New; a `lead_status` column is used only when it is
// exactly a status key or label; a column named like a contact custom field fills that field on created rows; and
// a leads import skips people who look like ones already on file (no email, same business) unless told not to.
// Person status (decision 0040): `person_status` and `sub_status` columns (the key or label of a live status, and of
// one of its sub-statuses) say what a new person is; `lead_status` still works (Lead with that sub-status, or Contact
// for Qualified). The status columns are read for new people only: a merge never moves anyone.
// Ids (decision 0037): an `id` column that names a contact on file matches it before the email does; a well-formed
// contact id that matches nobody is kept for the new contact, so the board's export imports into another copy.
// Own list (decision 0038): with the board's box ticked, short single-line names, emails, phones, businesses and sources
// are the owner's, left out of untrusted_fields; notes and custom fields stay outside text.
import type { ContactRow } from "../../db/db.ts";
import { isContactId, newId } from "../../ids.ts";
import { type ChangeInput, type RowChange, updatedRow } from "../../services/change.ts";
import { businessKey } from "../../services/lead-change.ts";
import { isUnqualified, type LeadStatus, leadStatusFromText } from "../../services/lead-status.ts";
import {
  CONTACT,
  LEAD,
  liveByRef,
  newPersonColumns,
  SEEDED_STATUSES,
  type StatusEntry,
} from "../../services/person-move.ts";
import type { ColumnDef, ImportModule, ImportOptions, MappedRow } from "../engine.ts";
import { confirmedColumns, OWN_LIST_COLUMNS, type OwnListColumn } from "../own-list.ts";
import {
  ARCHIVED_IN_FILE,
  checkedFields,
  EMAIL,
  FIELDS_INVALID,
  fieldInputs,
  isArchivedCell,
  isEmptyValue,
  jsonFieldInputs,
  storedFields,
} from "./values.ts";

export const IMPORT_COLUMNS = ["name", "email", "phone", "business", "source", "notes"] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

/** The columns a merge may fill: never the name (always set) or the email (the match). */
export const FILL_COLUMNS = ["phone", "business", "source", "notes"] as const;
export type FillColumn = (typeof FILL_COLUMNS)[number];

/** The same limits the MCP tools apply (src/mcp/schemas.ts), so whatever the board exports can come back in. */
export const IMPORT_LIMITS: Record<ImportColumn, number> = {
  name: 500,
  email: 254,
  phone: 500,
  business: 500,
  source: 500,
  notes: 10_000,
};

/** The header that names the optional lead status column. */
export const STATUS_COLUMN = "lead_status";

/** The headers of the person status columns (decision 0040), as the board's export writes them. */
export const PERSON_STATUS_COLUMN = "person_status";
export const SUB_STATUS_COLUMN = "sub_status";

/** The header that names a contact's id, as the board's export writes it. */
export const ID_COLUMN = "id";

/** The board export's contacts columns that are bookkeeping, not details: recognised and never imported. */
const PEOPLE_IGNORED = ["untrusted_fields", "version", "created_at", "updated_at", "lead_status_at"];

/** The export's JSON object of custom field values, and its archived flag: read, never stored as they are. */
export const FIELDS_COLUMN = "fields";
export const ARCHIVED_COLUMN = "archived";

export interface PeopleOptions extends ImportOptions {
  /** Created rows become leads: New, unless a lead_status column says otherwise. */
  asLeads: boolean;
  /** Create rows that look like someone already on file (leads imports only). */
  allowDuplicates: boolean;
  /** The copy's person statuses, archived ones included; the seeded three when left out. */
  statuses?: readonly StatusEntry[];
}

const LABELS: Record<ImportColumn, string> = {
  name: "Name",
  email: "Email",
  phone: "Phone",
  business: "Account",
  source: "Source",
  notes: "Notes",
};

/** The person's account was called a company and a business before run 12; a file with either header still maps. */
export const ACCOUNT_ALIASES: string[] = ["account", "company"];

// The status column is read for new people only, by its value (an exact status key or label), the id only by its
// shape, and the export's fields and archived columns only for what they hold, so none has a length limit of its own.
const PEOPLE_COLUMNS: readonly ColumnDef[] = [
  { key: ID_COLUMN, label: "Contact id", aliases: [], multiline: false },
  ...IMPORT_COLUMNS.map((key) => ({
    key,
    label: LABELS[key],
    aliases: key === "business" ? ACCOUNT_ALIASES : [],
    limit: IMPORT_LIMITS[key],
    multiline: key === "notes",
    required: key === "name",
  })),
  { key: STATUS_COLUMN, label: "Lead status", aliases: [], multiline: false },
  { key: PERSON_STATUS_COLUMN, label: "Person status", aliases: [], multiline: false },
  { key: SUB_STATUS_COLUMN, label: "Sub-status", aliases: [], multiline: false },
  { key: FIELDS_COLUMN, label: "Field values (from an export)", aliases: [], multiline: false },
  { key: ARCHIVED_COLUMN, label: "Archived (from an export)", aliases: [], multiline: false },
];

export type ExistingContact = {
  id: string;
  email: string | null;
  phone: string | null;
  business: string | null;
  source: string | null;
  notes: string | null;
  /** The stored JSON object of custom field values. */
  fields?: string;
};

export type ImportValues = { name: string } & { [K in Exclude<ImportColumn, "name">]: string | null };

export interface CreateRow extends ImportValues {
  line: number;
  /** A well-formed contact id from the file that matches nobody, kept for the new contact; null for a new id. */
  id: string | null;
  /** The person status and sub-status the new contact starts with (decision 0040). */
  personStatus: string;
  subStatus: string | null;
  /** The lead status that goes with them: the sub-status of a Lead, Qualified as history, or null. */
  leadStatus: LeadStatus | null;
  /** Custom field values by field key, for the contact fields the file has columns for. */
  fields: Record<string, string | number>;
  /** Own list (decision 0038): the columns stored as the owner's. Left out when there are none. */
  confirmed?: OwnListColumn[];
}

/** A row left out because it may be a person already on file: the existing contact's id or an earlier line. */
export interface DuplicateRow {
  line: number;
  ofId: string | null;
  ofLine: number | null;
}

export interface MergeRow {
  id: string;
  line: number;
  changes: Partial<Record<FillColumn, string>>;
  /** Custom fields that were empty on the contact and are filled from the file, by field key. */
  fields?: Record<string, string | number>;
  /** Own list (decision 0038): the filled columns stored as the owner's. Left out when there are none. */
  confirmed?: OwnListColumn[];
}

export interface PeoplePlan {
  create: CreateRow[];
  merge: MergeRow[];
  /** Rows matching a contact whose fields are all set already. */
  unchanged: { line: number; id: string }[];
  skipped: { line: number; reason: string }[];
  /** Possible duplicates left out of `create`; always empty unless the import is as leads. */
  duplicates: DuplicateRow[];
  /** Lines the file marks archived (also in `skipped`): never created or filled in. */
  archived: number[];
}

const isBlank = (text: string | null) => text === null || text.trim() === "";

/** The columns the own-list box may confirm on a person on file: the identity columns a merge fills. */
const OWN_FILL_COLUMNS = ["business", "phone", "source"] as const satisfies readonly (OwnListColumn & FillColumn)[];

/** The non-empty texts, one per line; null when there are none. */
function joinLines(texts: readonly (string | null)[]): string | null {
  const kept = texts.filter((text): text is string => !isBlank(text));
  return kept.length === 0 ? null : kept.join("\n");
}

/** Rows over a column's limit never reach the plan: planRows (src/import/engine.ts) skips them first. */
export function planPeople(
  rows: readonly MappedRow[],
  existing: readonly ExistingContact[],
  options: PeopleOptions,
): PeoplePlan {
  const byId = new Map(existing.map((contact) => [contact.id, contact]));
  const byEmail = new Map<string, ExistingContact>();
  const byBusiness = new Map<string, ExistingContact>();
  for (const contact of existing) {
    if (contact.email) byEmail.set(contact.email.trim().toLowerCase(), contact);
    const business = businessKey(contact.business);
    if (business !== "" && !byBusiness.has(business)) byBusiness.set(business, contact);
  }
  const seenEmails = new Map<string, number>();
  const seenIds = new Map<string, number>();
  // The contacts on file a line already matched, so no contact is filled in twice in one change.
  const seenMatches = new Map<string, number>();
  const seenBusinesses = new Map<string, number>();
  const plan: PeoplePlan = { create: [], merge: [], unchanged: [], skipped: [], duplicates: [], archived: [] };

  for (const row of rows) {
    const { line } = row;
    const values = Object.fromEntries(IMPORT_COLUMNS.map((column) => [column, row.values[column] ?? null])) as Record<
      ImportColumn,
      string | null
    >;
    const skip = (reason: string) => plan.skipped.push({ line, reason });
    const lines = row.notes.map((note) => `${note.label}: ${note.text}`);

    if (IMPORT_COLUMNS.every((column) => values[column] === null) && lines.length === 0) {
      skip("empty row");
      continue;
    }
    if (isArchivedCell(row.values[ARCHIVED_COLUMN] ?? null)) {
      plan.archived.push(line);
      skip(ARCHIVED_IN_FILE);
      continue;
    }
    const { name, email } = values;
    if (name === null) {
      skip("no name");
      continue;
    }
    // What each custom column holds in this row, then the export's fields column for the fields no column gives;
    // checked below, only for the fields a row actually fills.
    const columns = fieldInputs(row.fields, options.fieldDefs, "contact");
    const fromJson = jsonFieldInputs(row.values[FIELDS_COLUMN] ?? null, options.fieldDefs, "contact", columns);
    if (fromJson === null) {
      skip(FIELDS_INVALID);
      continue;
    }
    const given = [...columns, ...fromJson];
    const checked = (list: typeof given) => checkedFields(list, "contact");
    const idText = row.values[ID_COLUMN] ?? null;
    const id = idText !== null && isContactId(idText) ? idText : null;
    if (id !== null) {
      const earlier = seenIds.get(id);
      if (earlier !== undefined) {
        skip(`the same id as line ${earlier}`);
        continue;
      }
      seenIds.set(id, line);
    }
    const byIdMatch = id === null ? undefined : byId.get(id);
    if (byIdMatch === undefined && email !== null) {
      if (!EMAIL.test(email)) {
        skip("the email doesn't look like an email address");
        continue;
      }
      const key = email.toLowerCase();
      const earlier = seenEmails.get(key);
      if (earlier !== undefined) {
        skip(`the same email as line ${earlier}`);
        continue;
      }
      seenEmails.set(key, line);
    }
    const match = byIdMatch ?? (email === null ? undefined : byEmail.get(email.toLowerCase()));
    if (match) {
      const before = seenMatches.get(match.id);
      if (before !== undefined) {
        skip(`the same person as line ${before}`);
        continue;
      }
      seenMatches.set(match.id, line);
      const changes: MergeRow["changes"] = {};
      for (const column of FILL_COLUMNS) {
        const value = column === "notes" ? joinLines([values.notes, ...lines]) : values[column];
        const current = match[column];
        if (value !== null && (current === null || current.trim() === "")) changes[column] = value;
      }
      // Notes on file keep everything they have; "Add to notes" lines they don't hold yet go after it.
      const added = isBlank(match.notes) ? [] : lines.filter((text) => !(match.notes ?? "").split("\n").includes(text));
      if (added.length > 0) changes.notes = [match.notes, ...added].join("\n");
      if ((changes.notes?.length ?? 0) > IMPORT_LIMITS.notes) {
        skip(`notes is longer than ${IMPORT_LIMITS.notes} characters`);
        continue;
      }
      const stored = storedFields(match.fields);
      const { fields: filled, problem } = checked(given.filter(({ def }) => isEmptyValue(stored[def.key])));
      if (problem !== null) {
        skip(problem);
        continue;
      }
      const merged: MergeRow = { id: match.id, line, changes };
      if (Object.keys(filled).length > 0) merged.fields = filled;
      const confirmed = confirmedColumns(options.ownList, changes, OWN_FILL_COLUMNS);
      if (confirmed.length > 0) merged.confirmed = confirmed;
      if (Object.keys(changes).length > 0 || merged.fields) plan.merge.push(merged);
      else plan.unchanged.push({ line, id: match.id });
      continue;
    }
    // A new person: the status columns (a merge never uses them) and every custom value must be usable.
    const person = personOf(row, options);
    if ("problem" in person) {
      skip(person.problem);
      continue;
    }
    const { leadStatus } = person;
    const { fields: custom, problem } = checked(given);
    if (problem !== null) {
      skip(problem);
      continue;
    }
    const business = businessKey(values.business);
    if (email === null && leadStatus !== null && !options.allowDuplicates && business !== "") {
      const onFile = byBusiness.get(business);
      const earlier = seenBusinesses.get(business);
      if (onFile) {
        plan.duplicates.push({ line, ofId: onFile.id, ofLine: null });
        continue;
      }
      if (earlier !== undefined) {
        plan.duplicates.push({ line, ofId: null, ofLine: earlier });
        continue;
      }
    }
    const notes = joinLines([values.notes, ...lines]);
    if ((notes?.length ?? 0) > IMPORT_LIMITS.notes) {
      skip(`notes is longer than ${IMPORT_LIMITS.notes} characters`);
      continue;
    }
    if (business !== "" && !seenBusinesses.has(business)) seenBusinesses.set(business, line);
    const created: CreateRow = {
      line,
      id,
      ...values,
      notes,
      name,
      personStatus: person.status,
      subStatus: person.sub,
      leadStatus,
      fields: custom,
    };
    const confirmed = confirmedColumns(options.ownList, values, OWN_LIST_COLUMNS);
    if (confirmed.length > 0) created.confirmed = confirmed;
    plan.create.push(created);
  }
  return plan;
}

type Person = { status: string; sub: string | null; leadStatus: LeadStatus | null };

const keysOf = (list: readonly { key: string; archived: boolean }[]) =>
  list
    .filter((entry) => !entry.archived)
    .map((entry) => entry.key)
    .join(", ");

/**
 * The status a new person starts with, from the person_status, sub_status and lead_status columns, else the import's
 * choice (as leads: Lead, New; else Contact). A reason names the column and the live keys, never the file's value.
 */
function personOf(row: MappedRow, options: PeopleOptions): Person | { problem: string } {
  const statuses = options.statuses ?? SEEDED_STATUSES;
  const statusText = row.values[PERSON_STATUS_COLUMN] ?? null;
  const subText = row.values[SUB_STATUS_COLUMN] ?? null;
  const leadText = row.values[STATUS_COLUMN] ?? null;
  const lead = statuses.find((entry) => entry.key === LEAD);
  const fromLead = leadText === null ? null : (leadStatusFromText(leadText) ?? leadByLabel(lead, leadText));
  if (leadText !== null && fromLead === null) {
    return { problem: `${STATUS_COLUMN} isn't a lead status. Use new, contacted, not_now, not_a_fit, bad or qualified (or the same in words).` };
  }
  let status: StatusEntry | null | undefined;
  if (statusText !== null) {
    status = liveByRef(statuses, statusText);
    if (status === null) {
      return { problem: `${PERSON_STATUS_COLUMN} isn't a person status. Use one of: ${keysOf(statuses)} (or the same in words).` };
    }
  } else {
    const key = fromLead !== null ? (isUnqualified(fromLead) ? LEAD : CONTACT) : options.asLeads ? LEAD : CONTACT;
    status = statuses.find((entry) => entry.key === key);
  }
  if (!status) throw new Error("The Lead and Contact statuses are missing. Run the migrations.");
  let sub: string | null = null;
  if (subText !== null) {
    const found = liveByRef(status.subs, subText);
    if (found === null) {
      const keys = keysOf(status.subs);
      return {
        problem:
          keys === ""
            ? `${SUB_STATUS_COLUMN} is set, but that person status has no sub-statuses. Leave ${SUB_STATUS_COLUMN} empty.`
            : `${SUB_STATUS_COLUMN} isn't a sub-status of that person status. Use one of: ${keys} (or the same in words).`,
      };
    }
    sub = found.key;
  } else if (status.key === LEAD) {
    sub = fromLead !== null && isUnqualified(fromLead) ? fromLead : "new";
  }
  // A Lead's lead status is its sub-status; anyone else who the file says was a lead keeps Qualified as history.
  const leadStatus = status.key === LEAD ? (sub as LeadStatus) : fromLead !== null ? "qualified" : null;
  return { status: status.key, sub, leadStatus };
}

/** A lead status by the label the owner gave its sub-status (a renamed "Bad lead"), exactly, after trimming. */
function leadByLabel(lead: StatusEntry | undefined, text: string): LeadStatus | null {
  const found = lead?.subs.find((entry) => entry.label === text.trim());
  return found !== undefined && isUnqualified(found.key) ? (found.key as LeadStatus) : null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Counts only: an import's summary never quotes what the file held. */
export const importSummary = (created: number, filled: number): string =>
  `Imported ${plural(created, "contact", "contacts")} and filled details on ${filled}`;

/** The change for a plan, or null when it would write nothing. `existing` holds every contact a merge names. */
export function peopleChange(plan: PeoplePlan, existing: readonly ContactRow[], now: Date): ChangeInput | null {
  const stamp = now.toISOString();
  const changes: RowChange[] = [];
  for (const row of plan.create) {
    const contact: ContactRow = {
      id: row.id ?? newId("ct"),
      name: row.name,
      email: row.email,
      phone: row.phone,
      business: row.business,
      source: row.source,
      notes: row.notes,
      fields: JSON.stringify(row.fields),
      untrusted_fields: JSON.stringify([
        ...IMPORT_COLUMNS.filter((column) => row[column] !== null && !(row.confirmed ?? []).some((key) => key === column)),
        ...Object.keys(row.fields),
      ]),
      archived: 0,
      version: 1,
      created_at: stamp,
      updated_at: stamp,
      ...personColumns(row, now),
    };
    changes.push({ table: "contacts", id: contact.id, before: null, after: contact });
  }
  for (const { id, changes: filled, fields: filledFields, confirmed = [] } of plan.merge) {
    const before = existing.find((contact) => contact.id === id);
    if (!before) throw new Error(`The import plan names contact ${id}, which wasn't read.`);
    // Marks on file stay as they are (a custom field may share a column's key); a confirmed value adds none.
    const untrusted = new Set(JSON.parse(before.untrusted_fields) as string[]);
    for (const column of Object.keys(filled)) if (!confirmed.some((key) => key === column)) untrusted.add(column);
    for (const key of Object.keys(filledFields ?? {})) untrusted.add(key);
    const patch: Partial<ContactRow> = { ...filled, untrusted_fields: JSON.stringify([...untrusted]) };
    if (filledFields) patch.fields = JSON.stringify({ ...(JSON.parse(before.fields) as object), ...filledFields });
    const after = updatedRow(before, patch, now);
    changes.push({ table: "contacts", id, before, after });
  }
  const first = changes[0];
  if (!first) return null;
  return {
    target: { table: "contacts", id: first.id },
    summary: importSummary(plan.create.length, plan.merge.length),
    changes,
    // One change at any size (decision 0035): up to IMPORT_MAX_ROWS rows in one batch and one undo.
    bulk: true,
  };
}

/** The status columns of a created row, through newPersonColumns; Qualified from the file is kept as history. */
function personColumns(row: CreateRow, now: Date): ReturnType<typeof newPersonColumns> {
  const columns = newPersonColumns({ status: row.personStatus, sub: row.subStatus }, now);
  if (row.leadStatus === "qualified" && columns.lead_status === null) {
    return { ...columns, lead_status: "qualified", lead_status_at: now.toISOString() };
  }
  return columns;
}

/** Contacts and leads, matched by id, then email. The ctx is every contact on file. */
export const peopleModule: ImportModule<readonly ContactRow[], PeoplePlan, PeopleOptions> = {
  key: "people",
  noun: { one: "contact", many: "contacts" },
  entity: "contact",
  notes: true,
  columns: PEOPLE_COLUMNS,
  hintColumns: IMPORT_COLUMNS,
  ignored: PEOPLE_IGNORED,
  plan: planPeople,
  change: peopleChange,
};
