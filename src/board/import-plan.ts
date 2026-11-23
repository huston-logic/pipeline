// Planning a board import's draft against the data as it is now (decisions 0036, 0037), for whichever module it is:
// the preview and the apply are separate requests, and each plans once. Then the change it writes and the counts the
// draft keeps.
import type { ContactRow, Db } from "../db/db.ts";
import { listFieldDefs } from "../db/queries.ts";
import type { Draft, ImportResult } from "../import/drafts.ts";
import { type FilePlan, fileChange, type MappedFile, mapFile, planRows } from "../import/engine.ts";
import { contactsOnFile, dealsOnFile, tasksOnFile } from "../import/load.ts";
import { type DealsCtx, type DealsPlan, dealsModule } from "../import/modules/deals.ts";
import { type PeoplePlan, peopleModule } from "../import/modules/people.ts";
import { type TasksCtx, type TasksPlan, tasksModule } from "../import/modules/tasks.ts";
import type { ChangeInput } from "../services/change.ts";

/** What the check step's boxes say: People's possible duplicates too, Deals' closed deals as history. */
export type Confirmed = { duplicates: boolean; closed: boolean };

export const NOTHING_CONFIRMED: Confirmed = { duplicates: false, closed: false };

/** A draft planned against the data on file now: the mapped file, the plan and the records it read. */
export type DraftPlan =
  | { module: "people"; mapped: MappedFile; plan: FilePlan<PeoplePlan>; ctx: ContactRow[] }
  | { module: "deals"; mapped: MappedFile; plan: FilePlan<DealsPlan>; ctx: DealsCtx }
  | { module: "tasks"; mapped: MappedFile; plan: FilePlan<TasksPlan>; ctx: TasksCtx };

export async function planDraft(db: Db, draft: Draft, text: string, now: Date, confirmed: Confirmed): Promise<DraftPlan> {
  const fieldDefs = await listFieldDefs(db, { includeArchived: true });
  switch (draft.module) {
    case "people": {
      const mapped = mapFile(peopleModule, text, draft.mapping, fieldDefs, now);
      const ctx = await contactsOnFile(db);
      const options = { asLeads: draft.asLeads, allowDuplicates: confirmed.duplicates, fieldDefs: mapped.fieldDefs };
      const plan = planRows(peopleModule, mapped.rows, ctx, options);
      return { module: "people", mapped, ctx, plan: { ...plan, skippedColumns: mapped.skippedColumns } };
    }
    case "deals": {
      const mapped = mapFile(dealsModule, text, draft.mapping, fieldDefs, now);
      const ctx = await dealsOnFile(db, mapped.rows);
      const plan = planRows(dealsModule, mapped.rows, ctx, { closedAsHistory: confirmed.closed, fieldDefs: mapped.fieldDefs });
      return { module: "deals", mapped, ctx, plan: { ...plan, skippedColumns: mapped.skippedColumns } };
    }
    case "tasks": {
      const mapped = mapFile(tasksModule, text, draft.mapping, fieldDefs, now);
      const ctx = await tasksOnFile(db, mapped.rows);
      const plan = planRows(tasksModule, mapped.rows, ctx, { fieldDefs: mapped.fieldDefs });
      return { module: "tasks", mapped, ctx, plan: { ...plan, skippedColumns: mapped.skippedColumns } };
    }
  }
}

/** The one change the planned draft writes, new fields first; null when it writes no record. */
export function draftChange(planned: DraftPlan, now: Date): ChangeInput | null {
  const { newFields } = planned.mapped;
  switch (planned.module) {
    case "people":
      return fileChange(peopleModule, planned.plan, planned.ctx, now, newFields);
    case "deals":
      return fileChange(dealsModule, planned.plan, planned.ctx, now, newFields);
    case "tasks":
      return fileChange(tasksModule, planned.plan, planned.ctx, now, newFields);
  }
}

/** The counts a plan gives: what the check step forecasts and an applied draft keeps. */
export function resultOf(planned: DraftPlan, wrote: boolean): ImportResult {
  const { plan, mapped } = planned;
  const base: ImportResult = {
    created: plan.create.length,
    filled: plan.merge.length,
    unchanged: plan.unchanged.length,
    skipped: plan.skipped.length,
    duplicates: 0,
    fields: wrote ? mapped.newFields.length : 0,
    people: 0,
    closed: 0,
    archived: 0,
  };
  switch (planned.module) {
    case "people":
      return { ...base, duplicates: planned.plan.duplicates.length, archived: planned.plan.archived.length };
    case "deals":
      return {
        ...base,
        people: planned.plan.people.length,
        closed: planned.plan.create.filter((row) => row.status !== "open").length,
        archived: planned.plan.archived.length,
      };
    case "tasks":
      return base;
  }
}
