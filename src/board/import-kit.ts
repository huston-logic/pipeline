// What the board import's pages and posts share (decision 0036): its paths, the mapping form's names and how a posted
// mapping is read, and planning a draft against the data as it is now. Only the People module is on the board yet.
import type { ContactRow, Db, FieldDefRow } from "../db/db.ts";
import { listFieldDefs } from "../db/queries.ts";
import type { Draft, ImportResult } from "../import/drafts.ts";
import { type FilePlan, type MappedFile, mapFile, type Target } from "../import/engine.ts";
import { type PeoplePlan, peopleModule } from "../import/modules/people.ts";

export const IMPORT_PATH = "/import";
export const draftPath = (id: string) => `${IMPORT_PATH}/${encodeURIComponent(id)}`;
export const previewPath = (id: string) => `${draftPath(id)}/preview`;
export const mapAction = (id: string) => `${draftPath(id)}/map`;
export const applyAction = (id: string) => `${draftPath(id)}/apply`;

/** Where the Import button was tapped: `as=leads` on Leads, so new people come in as leads. */
export const startPath = (asLeads: boolean) => `${IMPORT_PATH}?module=people${asLeads ? "&as=leads" : ""}`;

/** The most columns one import takes, so the matching step stays a page a phone can scroll (decision 0036). */
export const IMPORT_MAX_COLUMNS = 100;

export const FILE_FIELD = "file";
export const PASTE_FIELD = "paste";
export const AS_FIELD = "as";
export const ALLOW_DUPLICATES_FIELD = "allow_duplicates";
export const VERSION_FIELD = "version";

export const columnField = (index: number) => `col.${index}`;
export const labelField = (index: number) => `label.${index}`;

/** The select's value for a target. A new field and a notes line keep their label in the label box. */
export function targetValue(target: Target): string {
  switch (target.kind) {
    case "builtin":
    case "field":
      return `${target.kind}:${target.key}`;
    default:
      return target.kind;
  }
}

/** The text the label box starts with: a stored label, else the header cell as one short line. */
export function defaultLabel(target: Target | undefined, header: string): string {
  if (target?.kind === "new_field" || target?.kind === "notes") return target.label;
  return header
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
}

export type PostedMapping = { targets: Target[]; asLeads: boolean; unchosen: number[] };

/**
 * The mapping the form posted, one target per header cell. A select value the page never offers (a missing or forged
 * field) is listed in `unchosen` by column; mapRows checks everything else.
 */
export function postedMapping(form: URLSearchParams, header: readonly string[]): PostedMapping {
  const unchosen: number[] = [];
  const targets = header.map((_, index): Target => {
    const value = form.get(columnField(index)) ?? "";
    const label = form.get(labelField(index)) ?? "";
    const [kind, key = ""] = value.split(/:(.*)/s, 2);
    if (value === "skip") return { kind: "skip" };
    if (value === "new_field") return { kind: "new_field", label };
    if (value === "notes") return { kind: "notes", label };
    if ((kind === "builtin" && peopleModule.columns.some((column) => column.key === key)) || (kind === "field" && key !== "")) {
      return { kind, key };
    }
    unchosen.push(index);
    return { kind: "skip" };
  });
  return { targets, asLeads: form.get(AS_FIELD) === "leads", unchosen };
}

/** A draft planned against the people and fields on file now: the mapped file, the plan and the people it read. */
export interface DraftPlan {
  mapped: MappedFile;
  plan: FilePlan<PeoplePlan>;
  contacts: ContactRow[];
}

/** Plans the draft once (the preview and the apply are separate requests, and each plans once). */
export async function planDraft(db: Db, draft: Draft, text: string, now: Date, allowDuplicates: boolean): Promise<DraftPlan> {
  if (draft.module !== "people") throw new Error(`The board can't import ${draft.module} yet.`);
  const fieldDefs: FieldDefRow[] = await listFieldDefs(db, { includeArchived: true });
  const contacts = (await db.prepare("SELECT * FROM contacts ORDER BY rowid").all<ContactRow>()).results;
  const mapped = mapFile(peopleModule, text, draft.mapping, fieldDefs, now);
  const plan = peopleModule.plan(mapped.rows, contacts, { asLeads: draft.asLeads, allowDuplicates, fieldDefs: mapped.fieldDefs });
  return { mapped, plan: { ...plan, skippedColumns: mapped.skippedColumns }, contacts };
}

/** The counts an applied import keeps. */
export function resultOf({ plan, mapped }: Pick<DraftPlan, "plan" | "mapped">, wrote: boolean): ImportResult {
  return {
    created: plan.create.length,
    filled: plan.merge.length,
    unchanged: plan.unchanged.length,
    skipped: plan.skipped.length,
    duplicates: plan.duplicates.length,
    fields: wrote ? mapped.newFields.length : 0,
  };
}
