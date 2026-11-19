// The CSV contact import's plan (pure): which rows become new contacts, which fill in details on a contact already on
// file (matched by email, ignoring case), and which are skipped and why. Nothing is written here; the import script
// shows this plan as a dry run, and only `--apply` turns it into one audited change (src/import/change.ts).
// Every imported value is outside text: the change lists it in the contact's untrusted_fields.
import { parseCsvRecords } from "../http/csv.ts";
import { UserError } from "../services/errors.ts";

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
};

export type ImportValues = { name: string } & { [K in Exclude<ImportColumn, "name">]: string | null };

export interface CreateRow extends ImportValues {
  line: number;
}

export interface MergeRow {
  id: string;
  line: number;
  changes: Partial<Record<FillColumn, string>>;
}

export interface ImportPlan {
  create: CreateRow[];
  merge: MergeRow[];
  /** Rows matching a contact whose fields are all set already. */
  unchanged: { line: number; id: string }[];
  skipped: { line: number; reason: string }[];
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

function readHeader(fields: string[]): { columns: Map<ImportColumn, number>; skippedColumns: string[] } {
  const columns = new Map<ImportColumn, number>();
  const skippedColumns: string[] = [];
  fields.forEach((field, index) => {
    const name = field.trim();
    const key = name.toLowerCase();
    const known = IMPORT_COLUMNS.find((column) => column === key);
    if (known === undefined) {
      if (name !== "") skippedColumns.push(name);
      return;
    }
    if (columns.has(known)) {
      throw new UserError(`The header row names "${known}" twice. Keep one column of each name and try again.`);
    }
    columns.set(known, index);
  });
  if (!columns.has("name")) {
    throw new UserError(
      `The first line must be a header row naming the columns, with at least "name" (${IMPORT_COLUMNS.join(", ")}). ` +
        "Add one and try again.",
    );
  }
  return { columns, skippedColumns };
}

export function planImport(csvText: string, existing: readonly ExistingContact[]): ImportPlan {
  const [header, ...records] = parseCsvRecords(csvText);
  if (!header) throw new UserError("The CSV file is empty. Export your contacts with a header row and try again.");
  const { columns, skippedColumns } = readHeader(header.fields);

  const byEmail = new Map<string, ExistingContact>();
  for (const contact of existing) if (contact.email) byEmail.set(contact.email.trim().toLowerCase(), contact);
  const seenEmails = new Map<string, number>();
  const plan: ImportPlan = { create: [], merge: [], unchanged: [], skipped: [], skippedColumns };

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
        if (Object.keys(changes).length > 0) plan.merge.push({ id: match.id, line, changes });
        else plan.unchanged.push({ line, id: match.id });
        continue;
      }
    }
    plan.create.push({ line, ...values, name });
  }
  return plan;
}
