// An import's plan, whichever door it came in by (the board, decision 0036; MCP, decision 0039): the one change it
// writes and the counts it gives, shared so the two can't drift. Each door plans with its own options; nothing here
// reads or sets them.
import type { ContactRow, FieldDefRow } from "../db/db.ts";
import type { ChangeInput } from "../services/change.ts";
import type { ImportResult } from "./drafts.ts";
import { fileChange } from "./engine.ts";
import { type DealsCtx, type DealsPlan, dealsModule } from "./modules/deals.ts";
import { type PeoplePlan, peopleModule } from "./modules/people.ts";
import { type TasksCtx, type TasksPlan, tasksModule } from "./modules/tasks.ts";

/** A module's plan against the records it read, with the fields its mapping creates (not yet written). */
export type PlannedImport =
  | { module: "people"; plan: PeoplePlan; ctx: readonly ContactRow[]; newFields: readonly FieldDefRow[] }
  | { module: "deals"; plan: DealsPlan; ctx: DealsCtx; newFields: readonly FieldDefRow[] }
  | { module: "tasks"; plan: TasksPlan; ctx: TasksCtx; newFields: readonly FieldDefRow[] };

/** The one change the plan writes, new fields first; null when it writes no record. */
export function plannedChange(planned: PlannedImport, now: Date): ChangeInput | null {
  switch (planned.module) {
    case "people":
      return fileChange(peopleModule, planned.plan, planned.ctx, now, planned.newFields);
    case "deals":
      return fileChange(dealsModule, planned.plan, planned.ctx, now, planned.newFields);
    case "tasks":
      return fileChange(tasksModule, planned.plan, planned.ctx, now, planned.newFields);
  }
}

/** The counts a plan gives: what a preview forecasts (`wrote` false) and an applied draft keeps. */
export function plannedResult(planned: PlannedImport, wrote: boolean): ImportResult {
  const { plan } = planned;
  const base: ImportResult = {
    created: plan.create.length,
    filled: plan.merge.length,
    unchanged: plan.unchanged.length,
    skipped: plan.skipped.length,
    duplicates: 0,
    fields: wrote ? planned.newFields.length : 0,
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
