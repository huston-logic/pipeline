// What a board import reads before it plans (decisions 0036, 0037). People: every contact on file, archived ones
// included, the same set the CLI import reads (scripts/import-csv.ts), so the two plan alike. Deals and tasks: every
// contact too (a row may name its person by email or name), the stages and the owner's timezone, and only the deals
// and tasks the file's ids name, each list in one statement with the ids as one JSON parameter, so a file of any size
// is a fixed number of reads.
import type { ContactRow, Db, DealRow, SettingsRow, StageRow, TaskRow } from "../db/db.ts";
import { isDealId, isTaskId } from "../ids.ts";
import type { MappedRow } from "./engine.ts";
import type { DealsCtx } from "./modules/deals.ts";
import type { TasksCtx } from "./modules/tasks.ts";

const ALL_CONTACTS = "SELECT * FROM contacts ORDER BY rowid";

export async function contactsOnFile(db: Db): Promise<ContactRow[]> {
  return (await db.prepare(ALL_CONTACTS).all<ContactRow>()).results;
}

/** The well-formed ids in one column of the file, each once. */
function idsIn(rows: readonly MappedRow[], column: string, isId: (text: string) => boolean): string {
  const ids = new Set<string>();
  for (const row of rows) {
    const text = row.values[column] ?? null;
    if (text !== null && isId(text)) ids.add(text);
  }
  return JSON.stringify([...ids]);
}

const byIds = (table: "deals" | "tasks") => `SELECT * FROM ${table} WHERE id IN (SELECT value FROM json_each(?)) ORDER BY rowid`;

export async function dealsOnFile(db: Db, rows: readonly MappedRow[]): Promise<DealsCtx> {
  const [contacts, deals, stages, settings] = await db.batch<unknown>([
    db.prepare(ALL_CONTACTS),
    db.prepare(byIds("deals")).bind(idsIn(rows, "id", isDealId)),
    db.prepare("SELECT * FROM stages ORDER BY position, key"),
    db.prepare("SELECT * FROM settings WHERE id = 1"),
  ]);
  return {
    contacts: (contacts?.results ?? []) as ContactRow[],
    deals: (deals?.results ?? []) as DealRow[],
    stages: (stages?.results ?? []) as StageRow[],
    tz: timezoneOf(settings?.results),
  };
}

export async function tasksOnFile(db: Db, rows: readonly MappedRow[]): Promise<TasksCtx> {
  const [contacts, deals, tasks, settings] = await db.batch<unknown>([
    db.prepare(ALL_CONTACTS),
    db.prepare(byIds("deals")).bind(idsIn(rows, "deal_id", isDealId)),
    db.prepare(byIds("tasks")).bind(idsIn(rows, "id", isTaskId)),
    db.prepare("SELECT * FROM settings WHERE id = 1"),
  ]);
  return {
    contacts: (contacts?.results ?? []) as ContactRow[],
    deals: (deals?.results ?? []) as DealRow[],
    tasks: (tasks?.results ?? []) as TaskRow[],
    tz: timezoneOf(settings?.results),
  };
}

function timezoneOf(rows: unknown[] | undefined): string {
  const settings = rows?.[0] as SettingsRow | undefined;
  if (!settings) throw new Error("The settings row is missing. Load seed/defaults.sql into the database.");
  return settings.timezone;
}
