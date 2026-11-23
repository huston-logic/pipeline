// What a board import reads before it plans (decision 0036): every contact on file, archived ones included, the same
// set the CLI import reads (scripts/import-csv.ts), so the two plan alike.
import type { ContactRow, Db } from "../db/db.ts";

export async function contactsOnFile(db: Db): Promise<ContactRow[]> {
  return (await db.prepare("SELECT * FROM contacts ORDER BY rowid").all<ContactRow>()).results;
}
