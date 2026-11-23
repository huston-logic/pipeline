// The CSV contact import's plan (pure), kept as a wrapper over the import engine and its People module (decision
// 0034): the same exports and the same behaviour as before the engine. Nothing is written here; the import script
// shows the plan as a dry run, and only `--apply` turns it into one audited change (src/import/change.ts).
import { type FilePlan, type ImportOptions, mapCsv } from "./engine.ts";
import { type ExistingContact, type PeoplePlan, peopleModule, planPeople } from "./modules/people.ts";

export type { ImportOptions } from "./engine.ts";
export {
  type CreateRow,
  type DuplicateRow,
  type ExistingContact,
  FILL_COLUMNS,
  type FillColumn,
  IMPORT_COLUMNS,
  IMPORT_LIMITS,
  type ImportColumn,
  type ImportValues,
  type MergeRow,
  STATUS_COLUMN,
} from "./modules/people.ts";

export type ImportPlan = FilePlan<PeoplePlan>;

const NO_OPTIONS: ImportOptions = { asLeads: false, allowDuplicates: false, fieldDefs: [] };

export function planImport(
  csvText: string,
  existing: readonly ExistingContact[],
  options: ImportOptions = NO_OPTIONS,
): ImportPlan {
  const { rows, skippedColumns } = mapCsv(peopleModule, csvText, options.fieldDefs);
  return { ...planPeople(rows, existing, options), skippedColumns };
}
