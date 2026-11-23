// The People import module (decisions 0029, 0034): which rows become new contacts, which fill in details on a
// contact already on file (matched by email, ignoring case), and which are skipped and why; then the one audited
// change (actor owner, tool "import") that writes them. Every imported value is outside text: the change lists it in
// the contact's untrusted_fields.
// Leads (decision 0022): `asLeads` gives created rows the status New; a `lead_status` column is used only when it is
// exactly a status key or label; a column named like a contact custom field fills that field on created rows; and
// a leads import skips people who look like ones already on file (no email, same business) unless told not to.
import type { ContactRow, FieldDefRow } from "../../db/db.ts";
import { newId } from "../../ids.ts";
import { type ChangeInput, type RowChange, updatedRow } from "../../services/change.ts";
import { validateFieldValues } from "../../services/fields.ts";
import { businessKey } from "../../services/lead-change.ts";
import { type LeadStatus, leadStatusFromText } from "../../services/lead-status.ts";
import type { ColumnDef, ImportModule, ImportOptions, MappedRow } from "../engine.ts";

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

/** The header that names the optional status column. */
export const STATUS_COLUMN = "lead_status";

const LABELS: Record<ImportColumn, string> = {
  name: "Name",
  email: "Email",
  phone: "Phone",
  business: "Business",
  source: "Source",
  notes: "Notes",
};

// The status column is read for new people only, by its value (an exact status key or label), so its length is never
// checked on its own.
const PEOPLE_COLUMNS: readonly ColumnDef[] = [
  ...IMPORT_COLUMNS.map((key) => ({
    key,
    label: LABELS[key],
    aliases: [],
    limit: IMPORT_LIMITS[key],
    multiline: key === "notes",
    required: key === "name",
  })),
  { key: STATUS_COLUMN, label: "Lead status", aliases: [], limit: 500, multiline: false },
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
  /** The status the new contact starts with; null for a contact who is not a lead. */
  leadStatus: LeadStatus | null;
  /** Custom field values by field key, for the contact fields the file has columns for. */
  fields: Record<string, string | number>;
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
}

export interface PeoplePlan {
  create: CreateRow[];
  merge: MergeRow[];
  /** Rows matching a contact whose fields are all set already. */
  unchanged: { line: number; id: string }[];
  skipped: { line: number; reason: string }[];
  /** Possible duplicates left out of `create`; always empty unless the import is as leads. */
  duplicates: DuplicateRow[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fieldProblem(def: FieldDefRow): string {
  switch (def.type) {
    case "number":
      return "needs a number";
    case "date":
      return "needs a date like 2026-11-19";
    case "choice":
      return `needs one of: ${(JSON.parse(def.choices ?? "[]") as string[]).join(", ")}`;
    case "text":
      return "is too long for that field";
  }
}

function storedFields(contact: ExistingContact): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(contact.fields ?? "{}");
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const isEmptyField = (value: unknown) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");

const NUMBER = /^-?\d+(\.\d+)?$/;

export function planPeople(
  rows: readonly MappedRow[],
  existing: readonly ExistingContact[],
  options: ImportOptions,
): PeoplePlan {
  const contactField = (key: string): FieldDefRow => {
    const def = options.fieldDefs.find((candidate) => candidate.entity === "contact" && candidate.archived === 0 && candidate.key === key);
    if (!def) throw new Error(`The import maps a column to the field "${key}", which isn't a contact field.`);
    return def;
  };
  const byEmail = new Map<string, ExistingContact>();
  const byBusiness = new Map<string, ExistingContact>();
  for (const contact of existing) {
    if (contact.email) byEmail.set(contact.email.trim().toLowerCase(), contact);
    const business = businessKey(contact.business);
    if (business !== "" && !byBusiness.has(business)) byBusiness.set(business, contact);
  }
  const seenEmails = new Map<string, number>();
  const seenBusinesses = new Map<string, number>();
  const plan: PeoplePlan = { create: [], merge: [], unchanged: [], skipped: [], duplicates: [] };

  for (const row of rows) {
    const { line } = row;
    const values = Object.fromEntries(IMPORT_COLUMNS.map((column) => [column, row.values[column] ?? null])) as Record<
      ImportColumn,
      string | null
    >;
    const skip = (reason: string) => plan.skipped.push({ line, reason });

    if (IMPORT_COLUMNS.every((column) => values[column] === null)) {
      skip("empty row");
      continue;
    }
    const tooLong = IMPORT_COLUMNS.find((column) => (values[column]?.length ?? 0) > IMPORT_LIMITS[column]);
    if (tooLong) {
      skip(`${tooLong} is longer than ${IMPORT_LIMITS[tooLong]} characters`);
      continue;
    }
    const { name, email } = values;
    if (name === null) {
      skip("no name");
      continue;
    }
    // What each custom column holds in this row; checked below, only for the fields a row actually fills.
    const given = row.fields.map(({ key, column, text }) => ({ def: contactField(key), columnName: column, text }));
    const checked = (list: typeof given): { fields: CreateRow["fields"]; problem: string | null } => {
      const out: CreateRow["fields"] = {};
      for (const { def, columnName, text } of list) {
        const value = def.type === "number" && NUMBER.test(text) ? Number(text) : text;
        try {
          validateFieldValues([def], "contact", { [def.key]: value });
        } catch {
          return { fields: out, problem: `the "${columnName}" column ${fieldProblem(def)}` };
        }
        out[def.key] = value;
      }
      return { fields: out, problem: null };
    };
    if (email !== null) {
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
      const match = byEmail.get(key);
      if (match) {
        const changes: MergeRow["changes"] = {};
        for (const column of FILL_COLUMNS) {
          const value = values[column];
          const current = match[column];
          if (value !== null && (current === null || current.trim() === "")) changes[column] = value;
        }
        const stored = storedFields(match);
        const { fields: filled, problem } = checked(given.filter(({ def }) => isEmptyField(stored[def.key])));
        if (problem !== null) {
          skip(problem);
          continue;
        }
        const merged: MergeRow = { id: match.id, line, changes };
        if (Object.keys(filled).length > 0) merged.fields = filled;
        if (Object.keys(changes).length > 0 || merged.fields) plan.merge.push(merged);
        else plan.unchanged.push({ line, id: match.id });
        continue;
      }
    }
    // A new person: the status column (a merge never uses it) and every custom value must be usable.
    let leadStatus: LeadStatus | null = options.asLeads ? "new" : null;
    const statusText = row.values[STATUS_COLUMN] ?? null;
    if (statusText !== null) {
      leadStatus = leadStatusFromText(statusText);
      if (leadStatus === null) {
        skip(`${STATUS_COLUMN} isn't a lead status. Use new, contacted, not_now, not_a_fit, bad or qualified (or the same in words).`);
        continue;
      }
    }
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
    if (business !== "" && !seenBusinesses.has(business)) seenBusinesses.set(business, line);
    plan.create.push({ line, ...values, name, leadStatus, fields: custom });
  }
  return plan;
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
      id: newId("ct"),
      name: row.name,
      email: row.email,
      phone: row.phone,
      business: row.business,
      source: row.source,
      notes: row.notes,
      fields: JSON.stringify(row.fields),
      untrusted_fields: JSON.stringify([...IMPORT_COLUMNS.filter((column) => row[column] !== null), ...Object.keys(row.fields)]),
      archived: 0,
      version: 1,
      created_at: stamp,
      updated_at: stamp,
      lead_status: row.leadStatus,
      lead_status_at: row.leadStatus === null ? null : stamp,
    };
    changes.push({ table: "contacts", id: contact.id, before: null, after: contact });
  }
  for (const { id, changes: filled, fields: filledFields } of plan.merge) {
    const before = existing.find((contact) => contact.id === id);
    if (!before) throw new Error(`The import plan names contact ${id}, which wasn't read.`);
    const untrusted = new Set(JSON.parse(before.untrusted_fields) as string[]);
    for (const column of [...Object.keys(filled), ...Object.keys(filledFields ?? {})]) untrusted.add(column);
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

/** Contacts and leads, matched by email. The ctx is every contact on file. */
export const peopleModule: ImportModule<readonly ContactRow[], PeoplePlan> = {
  key: "people",
  noun: { one: "contact", many: "contacts" },
  entity: "contact",
  columns: PEOPLE_COLUMNS,
  hintColumns: IMPORT_COLUMNS,
  plan: planPeople,
  change: peopleChange,
};
