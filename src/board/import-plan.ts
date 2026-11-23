// Planning a board import's draft against the data as it is now (decisions 0036, 0037), for whichever module it is:
// the preview and the apply are separate requests, and each plans once. Then the change it writes and the counts the
// draft keeps.
import type { ContactRow, Db, FieldDefRow } from "../db/db.ts";
import { listFieldDefs } from "../db/queries.ts";
import type { Draft, ImportResult } from "../import/drafts.ts";
import { type FilePlan, type MappedFile, mapFile, planRows } from "../import/engine.ts";
import { contactsOnFile, dealsOnFile, tasksOnFile } from "../import/load.ts";
import { type DealsCtx, type DealsPlan, dealsModule } from "../import/modules/deals.ts";
import { type PeoplePlan, peopleModule } from "../import/modules/people.ts";
import { type TasksCtx, type TasksPlan, tasksModule } from "../import/modules/tasks.ts";
import { plannedChange, plannedResult } from "../import/planned.ts";
import type { ChangeInput } from "../services/change.ts";
import { statusEntries } from "../services/person-status.ts";

/**
 * What the check step's boxes say: People's possible duplicates too, Deals' closed deals as history, and People's and
 * Deals' "This is my own list" (decision 0038; Tasks never read it).
 */
export type Confirmed = { duplicates: boolean; closed: boolean; ownList: boolean };

export const NOTHING_CONFIRMED: Confirmed = { duplicates: false, closed: false, ownList: false };

/** A draft planned against the data on file now: the mapped file, the plan and the records it read. */
export type DraftPlan =
  | { module: "people"; mapped: MappedFile; plan: FilePlan<PeoplePlan>; ctx: ContactRow[]; newFields: FieldDefRow[] }
  | { module: "deals"; mapped: MappedFile; plan: FilePlan<DealsPlan>; ctx: DealsCtx; newFields: FieldDefRow[] }
  | { module: "tasks"; mapped: MappedFile; plan: FilePlan<TasksPlan>; ctx: TasksCtx; newFields: FieldDefRow[] };

export async function planDraft(db: Db, draft: Draft, text: string, now: Date, confirmed: Confirmed): Promise<DraftPlan> {
  const fieldDefs = await listFieldDefs(db, { includeArchived: true });
  switch (draft.module) {
    case "people": {
      const mapped = mapFile(peopleModule, text, draft.mapping, fieldDefs, now);
      const ctx = await contactsOnFile(db);
      const statuses = await statusEntries(db);
      const options = { asLeads: draft.asLeads, allowDuplicates: confirmed.duplicates, ownList: confirmed.ownList, fieldDefs: mapped.fieldDefs, statuses };
      const plan = planRows(peopleModule, mapped.rows, ctx, options);
      return { module: "people", mapped, ctx, newFields: mapped.newFields, plan: { ...plan, skippedColumns: mapped.skippedColumns } };
    }
    case "deals": {
      const mapped = mapFile(dealsModule, text, draft.mapping, fieldDefs, now);
      const ctx = await dealsOnFile(db, mapped.rows);
      const options = { closedAsHistory: confirmed.closed, ownList: confirmed.ownList, fieldDefs: mapped.fieldDefs };
      const plan = planRows(dealsModule, mapped.rows, ctx, options);
      return { module: "deals", mapped, ctx, newFields: mapped.newFields, plan: { ...plan, skippedColumns: mapped.skippedColumns } };
    }
    case "tasks": {
      const mapped = mapFile(tasksModule, text, draft.mapping, fieldDefs, now);
      const ctx = await tasksOnFile(db, mapped.rows);
      const plan = planRows(tasksModule, mapped.rows, ctx, { fieldDefs: mapped.fieldDefs });
      return { module: "tasks", mapped, ctx, newFields: mapped.newFields, plan: { ...plan, skippedColumns: mapped.skippedColumns } };
    }
  }
}

/** The one change the planned draft writes, new fields first; null when it writes no record (shared with MCP). */
export const draftChange = (planned: DraftPlan, now: Date): ChangeInput | null => plannedChange(planned, now);

/** The counts a plan gives: what the check step forecasts and an applied draft keeps (shared with MCP). */
export const resultOf = (planned: DraftPlan, wrote: boolean): ImportResult => plannedResult(planned, wrote);
