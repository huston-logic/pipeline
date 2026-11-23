// What the board import's pages and posts share (decisions 0036, 0037): its paths, the mapping form's names and how a
// posted mapping is read. Planning a draft is in import-plan.ts.
import type { ImportModuleKey, ModuleShape, Target } from "../import/engine.ts";

export const IMPORT_PATH = "/import";
export const draftPath = (id: string) => `${IMPORT_PATH}/${encodeURIComponent(id)}`;
export const previewPath = (id: string) => `${draftPath(id)}/preview`;
export const mapAction = (id: string) => `${draftPath(id)}/map`;
export const applyAction = (id: string) => `${draftPath(id)}/apply`;

/** Where the Import button was tapped: the module, and `as=leads` on Leads, so new people come in as leads. */
export const startPath = (module: ImportModuleKey, asLeads = false) =>
  `${IMPORT_PATH}?module=${module}${module === "people" && asLeads ? "&as=leads" : ""}`;

/** The most columns one import takes, so the matching step stays a page a phone can scroll (decision 0036). */
export const IMPORT_MAX_COLUMNS = 100;

export const FILE_FIELD = "file";
export const PASTE_FIELD = "paste";
export const MODULE_FIELD = "module";
export const AS_FIELD = "as";
export const ALLOW_DUPLICATES_FIELD = "allow_duplicates";
/** The deals check step's box: bring in deals in a Won, Lost or Not now stage (decision 0037). */
export const CLOSED_FIELD = "closed_history";
/** The People and Deals check step's box: "This is my own list" (decision 0038). */
export const OWN_LIST_FIELD = "own_list";
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

/**
 * The text the label box starts with: a stored label, else nothing. A new field's label becomes a field the board
 * trusts, so the owner types it; the header beside it is outside text and never fills it (decision 0036).
 */
export function defaultLabel(target: Target | undefined): string {
  return target?.kind === "new_field" || target?.kind === "notes" ? target.label : "";
}

/** A header cell as one short line: what an "Add to notes" line is labelled when the label box is left empty. */
function headerLabel(header: string): string {
  return header
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
}

export type PostedMapping = { targets: Target[]; asLeads: boolean; unchosen: number[]; unlabelled: number[] };

/**
 * The mapping the form posted, one target per header cell. A select value the page never offers for this module (a
 * missing or forged field, New field where the records have no fields, Add to notes where they have no notes) is
 * listed in `unchosen` by column, and a New field with no label in `unlabelled`; mapRows checks everything else. An
 * "Add to notes" column with no label is labelled with its header (notes are outside text anyway). Only People has
 * the leads choice.
 */
export function postedMapping(module: ModuleShape & { key: ImportModuleKey }, form: URLSearchParams, header: readonly string[]): PostedMapping {
  const unchosen: number[] = [];
  const unlabelled: number[] = [];
  const targets = header.map((cell, index): Target => {
    const value = form.get(columnField(index)) ?? "";
    const label = form.get(labelField(index)) ?? "";
    const [kind, key = ""] = value.split(/:(.*)/s, 2);
    if (value === "skip") return { kind: "skip" };
    if (value === "new_field" && module.entity !== null) {
      if (label.trim() === "") unlabelled.push(index);
      return { kind: "new_field", label };
    }
    if (value === "notes" && module.notes) return { kind: "notes", label: label.trim() === "" ? headerLabel(cell) : label };
    if ((kind === "builtin" && module.columns.some((column) => column.key === key)) || (kind === "field" && key !== "" && module.entity !== null)) {
      return { kind, key };
    }
    unchosen.push(index);
    return { kind: "skip" };
  });
  return { targets, asLeads: module.key === "people" && form.get(AS_FIELD) === "leads", unchosen, unlabelled };
}
