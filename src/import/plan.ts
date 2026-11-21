// The CSV contact import's plan (pure): which rows become new contacts, which fill in details on a contact already on
// file (matched by email, ignoring case), and which are skipped and why. Nothing is written here; the import script
// shows this plan as a dry run, and only `--apply` turns it into one audited change (src/import/change.ts).
// Every imported value is outside text: the change lists it in the contact's untrusted_fields.
// Leads (decision 0022): `asLeads` gives created rows the status New; a `lead_status` column is used only when it is
// exactly a status key or label; a column named like a contact custom field fills that field on created rows; and
// a leads import skips people who look like ones already on file (no email, same business) unless told not to.
import type { FieldDefRow } from "../db/db.ts";
import { parseCsvRecords } from "../http/csv.ts";
import { UserError } from "../services/errors.ts";
import { validateFieldValues } from "../services/fields.ts";
import { businessKey } from "../services/lead-change.ts";
import { type LeadStatus, leadStatusFromText } from "../services/lead-status.ts";

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

/** The header that names the optional status column. */
export const STATUS_COLUMN = "lead_status";

export interface CreateRow extends ImportValues {
  line: number;
  /** The status the new contact starts with; null for a contact who is not a lead. */
  leadStatus: LeadStatus | null;
  /** Custom field values by field key, for the contact fields the file has columns for. */
  fields: Record<string, string | number>;
}

export interface ImportOptions {
  /** Created rows become leads: New, unless a lead_status column says otherwise. */
  asLeads: boolean;
  /** Create rows that look like someone already on file (leads imports only). */
  allowDuplicates: boolean;
  fieldDefs: readonly FieldDefRow[];
}

const NO_OPTIONS: ImportOptions = { asLeads: false, allowDuplicates: false, fieldDefs: [] };

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

export interface ImportPlan {
  create: CreateRow[];
  merge: MergeRow[];
  /** Rows matching a contact whose fields are all set already. */
  unchanged: { line: number; id: string }[];
  skipped: { line: number; reason: string }[];
  /** Possible duplicates left out of `create`; always empty unless the import is as leads. */
  duplicates: DuplicateRow[];
  /** Header names that are not imported. */
  skippedColumns: string[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// What the export's formula guard (src/http/csv.ts) puts an apostrophe in front of.
const GUARDED = /^'[=+\-@\t\r]/;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const LINE_BREAK = /\r\n|[\r\n\t]/g;

const unguard = (value: string) => (GUARDED.test(value) ? value.slice(1) : value);

function cleanValue(column: ImportColumn, raw: string): string | null {
  let value = unguard(raw).replace(CONTROL, "");
  if (column !== "notes") value = value.replace(LINE_BREAK, " ");
  value = value.trim();
  return value === "" ? null : value;
}

interface Header {
  columns: Map<ImportColumn, number>;
  status: number | undefined;
  /** Column index by custom field, for the contact fields (not archived) the file has columns for. */
  fieldColumns: { def: FieldDefRow; header: string; index: number }[];
  skippedColumns: string[];
}

function readHeader(fields: string[], fieldDefs: readonly FieldDefRow[]): Header {
  const columns = new Map<ImportColumn, number>();
  const fieldColumns: Header["fieldColumns"] = [];
  const skippedColumns: string[] = [];
  let status: number | undefined;
  const twice = (name: string) =>
    new UserError(`The header row names "${name}" twice. Keep one column of each name and try again.`);
  fields.forEach((field, index) => {
    const name = field.trim();
    const key = name.toLowerCase();
    const known = IMPORT_COLUMNS.find((column) => column === key);
    if (known === undefined) {
      if (key === STATUS_COLUMN) {
        if (status !== undefined) throw twice(STATUS_COLUMN);
        status = index;
        return;
      }
      const def = fieldDefs.find(
        (candidate) =>
          candidate.entity === "contact" &&
          candidate.archived === 0 &&
          (candidate.key.toLowerCase() === key || candidate.label.trim().toLowerCase() === key),
      );
      if (def) {
        if (fieldColumns.some((column) => column.def.key === def.key)) throw twice(def.key);
        fieldColumns.push({ def, header: name, index });
      } else if (name !== "") {
        skippedColumns.push(name);
      }
      return;
    }
    if (columns.has(known)) throw twice(known);
    columns.set(known, index);
  });
  if (!columns.has("name")) {
    throw new UserError(
      `The first line must be a header row naming the columns, with at least "name" (${IMPORT_COLUMNS.join(", ")}). ` +
        "Add one and try again.",
    );
  }
  return { columns, status, fieldColumns, skippedColumns };
}

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

export function planImport(
  csvText: string,
  existing: readonly ExistingContact[],
  options: ImportOptions = NO_OPTIONS,
): ImportPlan {
  const [header, ...records] = parseCsvRecords(csvText);
  if (!header) throw new UserError("The CSV file is empty. Export your contacts with a header row and try again.");
  const { columns, status, fieldColumns, skippedColumns } = readHeader(header.fields, options.fieldDefs);

  const byEmail = new Map<string, ExistingContact>();
  const byBusiness = new Map<string, ExistingContact>();
  for (const contact of existing) {
    if (contact.email) byEmail.set(contact.email.trim().toLowerCase(), contact);
    const business = businessKey(contact.business);
    if (business !== "" && !byBusiness.has(business)) byBusiness.set(business, contact);
  }
  const seenEmails = new Map<string, number>();
  const seenBusinesses = new Map<string, number>();
  const plan: ImportPlan = { create: [], merge: [], unchanged: [], skipped: [], duplicates: [], skippedColumns };

  for (const { line, fields } of records) {
    const values = Object.fromEntries(
      IMPORT_COLUMNS.map((column) => {
        const index = columns.get(column);
        return [column, index === undefined ? null : cleanValue(column, fields[index] ?? "")];
      }),
    ) as Record<ImportColumn, string | null>;
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
    const given = fieldColumns.flatMap(({ def, header: columnName, index }) => {
      const text = cleanValue("source", fields[index] ?? "");
      return text === null ? [] : [{ def, columnName, text }];
    });
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
        const row: MergeRow = { id: match.id, line, changes };
        if (Object.keys(filled).length > 0) row.fields = filled;
        if (Object.keys(changes).length > 0 || row.fields) plan.merge.push(row);
        else plan.unchanged.push({ line, id: match.id });
        continue;
      }
    }
    // A new person: the status column (a merge never uses it) and every custom value must be usable.
    let leadStatus: LeadStatus | null = options.asLeads ? "new" : null;
    if (status !== undefined) {
      const text = cleanValue("source", fields[status] ?? "");
      if (text !== null) {
        leadStatus = leadStatusFromText(text);
        if (leadStatus === null) {
          skip(`${STATUS_COLUMN} isn't a lead status. Use new, contacted, not_now, not_a_fit, bad or qualified (or the same in words).`);
          continue;
        }
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
