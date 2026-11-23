// The CSV import's one audited change (actor owner, tool "import"): the change a module builds from its plan (for
// contacts, src/import/modules/people.ts), with the same row snapshots, write_guard checks and audit row that
// commitChange writes, rendered as a SQL file for `wrangler d1 execute --file`. Undo reverses it like any other change
// (undo_change).
import { buildChange, type Ctx, type ChangeInput } from "../services/change.ts";
import { renderScript } from "./sql.ts";

export { importSummary, peopleChange as importChange } from "./modules/people.ts";

export const IMPORT_ACTOR = { actor: "owner", tool: "import" } as const satisfies Pick<Ctx, "actor" | "tool">;

export interface RenderedImport {
  changeId: string;
  summary: string;
  sql: string;
}

/** The change as a SQL file: the guards and writes, then the audit row, exactly as commitChange would batch them. */
export function renderImport(input: ChangeInput, now: Date): RenderedImport {
  const { changeId, summary, writes, audit } = buildChange({ ...IMPORT_ACTOR, now }, input);
  return { changeId, summary, sql: renderScript([...writes, ...audit]) };
}
