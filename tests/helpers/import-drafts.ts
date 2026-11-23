// Stand-ins for the demo seed's board import drafts (scripts/seed-dev.ts, decision 0036), on a fixture-seeded
// database, so a unit test can open every path in boardRoutes. Fake people only.
import type { SqliteD1 } from "../../src/db/sqlite-d1.ts";

const NEVER = "2999-01-01T00:00:00.000Z";

const to = (key: string) => ({ kind: "builtin", key });

export async function addStandInDrafts(db: SqliteD1): Promise<void> {
  const draft = db.prepare(
    "INSERT INTO import_drafts (id, module, expires_at, mapping, options, result, change_id) VALUES (?, 'people', ?, ?, ?, ?, NULL)",
  );
  const part = db.prepare("INSERT INTO import_draft_parts (draft_id, seq, text) VALUES (?, 1, ?)");
  const mapping = JSON.stringify([to("name"), to("email"), { kind: "notes", label: "Referred by" }, { kind: "new_field", label: "Budget" }]);
  const csv = "Name,Email,Referred by,Budget\r\nNadia Fenwick,nadia.fenwick@example.com,Pat,5000\r\nBea Quinn,not-an-email,,\r\n";
  for (const id of ["im_seed01", "im_seed02"]) {
    await draft.bind(id, NEVER, mapping, "{}", null).run();
    await part.bind(id, csv).run();
  }
  const result = JSON.stringify({ created: 1, filled: 0, unchanged: 0, skipped: 1, duplicates: 0, fields: 1 });
  await draft.bind("im_seed03", NEVER, mapping, '{"asLeads":true}', result).run();
}
