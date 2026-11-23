// The board import (decisions 0036, 0037) for People, Deals and Tasks, in three steps and a result: choose a file (or
// paste one), match its columns, check what will happen (import-check.ts), then the import's counts with its change and
// Undo. The file's values never reach a page: only its header names, escaped and labelled "From your file" in each
// column's legend (never in a message or a link), line numbers, counts and records on file. These GET pages never
// write; expired drafts are deleted by the import posts and the hourly run.
import type { FieldDefRow } from "../../db/db.ts";
import { listFieldDefs } from "../../db/queries.ts";
import { type Draft, draftText, getDraft, type ImportResult } from "../../import/drafts.ts";
import { autoMatch, IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, type ImportModuleKey, readCsv, type Target } from "../../import/engine.ts";
import { IMPORT_MODULES, isImportModuleKey } from "../../import/modules/index.ts";
import { UserError } from "../../services/errors.ts";
import { getChange } from "../../services/read.ts";
import { canUndo, undoForm } from "../banner.ts";
import type { PageContext } from "../context.ts";
import { hidden, postForm } from "../forms.ts";
import { type Html, html } from "../html.ts";
import {
  AS_FIELD,
  columnField,
  defaultLabel,
  draftPath,
  FILE_FIELD,
  IMPORT_PATH,
  labelField,
  mapAction,
  MODULE_FIELD,
  PASTE_FIELD,
  startPath,
  targetValue,
  VERSION_FIELD,
} from "../import-kit.ts";
import { NOTHING_CONFIRMED, planDraft } from "../import-plan.ts";
import { IMPORT_TEXT } from "../import-text.ts";
import { errorSummary, type FieldError } from "../inputs.ts";
import { renderPage } from "../layout.ts";
import { count, formatNumber, section } from "../parts.ts";
import { countsList, importPreviewPage, step } from "./import-check.ts";

const FROM_FILE = "From your file";

/** An error on the matching step: the column's select or its label box. */
export type MappingProblem = { column?: number; control?: "col" | "label"; message: string };

const problemId = (problem: MappingProblem) =>
  problem.column === undefined ? undefined : `${problem.control === "label" ? "label" : "col"}-${problem.column}`;

/** GET /import: step 1, a file or pasted rows in one multipart form. */
export function importStartPage(ctx: PageContext, module: ImportModuleKey, asLeads: boolean, problem?: string): string {
  const text = IMPORT_TEXT[module];
  const errors: FieldError[] = problem === undefined ? [] : [{ id: "import-file", message: problem }];
  return renderPage({
    title: problem === undefined ? text.heading : `Error: ${text.heading}`,
    description: text.descriptions.start,
    current: IMPORT_PATH,
    frame: ctx,
    body: html`<h1>${text.heading}</h1>
${step(1, "Choose a file")}
<p class="lede">${text.lede}</p>
${errorSummary(errors)}
${postForm(
  "record-form import-upload",
  IMPORT_PATH,
  { csrf: ctx.csrf, here: startPath(module, asLeads) },
  html`${hidden(MODULE_FIELD, module)}${hidden(AS_FIELD, asLeads ? "leads" : "contacts")}
<div class="card form-card">
<div class="field${problem === undefined ? "" : " field-invalid"}">
<label for="import-file">CSV file</label>
<p class="field-hint" id="import-file-hint">At most ${formatNumber(IMPORT_MAX_ROWS)} rows and ${IMPORT_MAX_BYTES / 1_048_576} MB, with a header row naming the columns.</p>
${errorLine("import-file", problem)}<input id="import-file" name="${FILE_FIELD}" type="file" accept=".csv,text/csv"${aria(["import-file-hint", problem === undefined ? null : "import-file-error"], problem !== undefined)}>
</div>
<div class="field">
<label for="import-paste">Or paste the text of a CSV file</label>
<p class="field-hint" id="import-paste-hint">Use one or the other, not both.</p>
<textarea id="import-paste" name="${PASTE_FIELD}" rows="4" aria-describedby="import-paste-hint"></textarea>
</div>
</div>
<div class="form-actions">
<button class="button" type="submit">Next: match columns</button>
<a class="form-cancel" href="${text.back(asLeads).href}">Cancel</a>
</div>
`,
  { novalidate: true, multipart: true },
)}
${section(
  "csv-help",
  "Getting a CSV file",
  html`<ul class="panel rows import-help">
<li><strong>Google Sheets:</strong> File &gt; Download &gt; Comma-separated values (.csv).</li>
<li><strong>Excel:</strong> File &gt; Save as, then choose CSV UTF-8 (.csv).</li>
</ul>`,
)}
${otherImports(module)}`,
  });
}

const IMPORT_NAMES: Record<ImportModuleKey, string> = { people: "people", deals: "deals", tasks: "tasks" };

/** The other modules' first steps, so Import in More reaches all three. */
function otherImports(module: ImportModuleKey): Html {
  const others = (Object.keys(IMPORT_NAMES) as ImportModuleKey[]).filter((key) => key !== module);
  return section(
    "import-other",
    "Something else to import",
    html`<p class="page-action">${others.map((key) => html`<a class="button button-quiet" href="${startPath(key)}">Import ${IMPORT_NAMES[key]}</a>`)}</p>`,
  );
}

type Option = { value: string; label: string };

/** The choices for each column: the module's own columns, its live custom fields, and what else it takes. */
function mappingOptions(module: ImportModuleKey, fieldDefs: readonly FieldDefRow[]): { group: string; options: Option[] }[] {
  const shape = IMPORT_MODULES[module];
  const custom = shape.entity === null ? [] : fieldDefs.filter((def) => def.entity === shape.entity && def.archived === 0);
  const other: Option[] = [
    ...(shape.entity === null ? [] : [{ value: "new_field", label: "New field" }]),
    ...(shape.notes ? [{ value: "notes", label: "Add to notes" }] : []),
    { value: "skip", label: "Don't import" },
  ];
  return [
    { group: IMPORT_TEXT[module].group, options: shape.columns.map((column) => ({ value: `builtin:${column.key}`, label: column.label })) },
    ...(custom.length === 0 ? [] : [{ group: "Your fields", options: custom.map((def) => ({ value: `field:${def.key}`, label: def.label })) }]),
    { group: "Other", options: other },
  ];
}

const errorLine = (id: string, message: string | undefined) =>
  message === undefined ? "" : html`<p class="field-error" id="${id}-error"><span class="visually-hidden">Error: </span>${message}</p>`;

const aria = (ids: (string | null)[], invalid: boolean): Html => {
  const described = ids.filter((id): id is string => id !== null);
  return html`${described.length === 0 ? "" : html` aria-describedby="${described.join(" ")}"`}${invalid ? html` aria-invalid="true"` : ""}`;
};

/** The label box's hint, for a module with New field, Add to notes or both; null when it has neither. */
function labelHint(module: ImportModuleKey): string | null {
  const shape = IMPORT_MODULES[module];
  if (shape.entity !== null && shape.notes) return "New field needs one. Add to notes uses the column's name if you leave it empty.";
  if (shape.entity !== null) return "New field needs one.";
  return shape.notes ? "Add to notes uses the column's name if you leave it empty." : null;
}

function columnCard(
  index: number,
  name: string,
  groups: ReturnType<typeof mappingOptions>,
  hint: string | null,
  selected: string,
  label: string,
  problems: MappingProblem[],
): Html {
  const colId = `col-${index}`;
  const labelId = `label-${index}`;
  const colError = problems.find((p) => p.column === index && p.control !== "label")?.message;
  const labelError = problems.find((p) => p.column === index && p.control === "label")?.message;
  const offered = groups.some((group) => group.options.some((option) => option.value === selected));
  const value = offered ? selected : "skip";
  const header = name.trim() === "" ? html`<span class="import-noname">No name</span>` : html`<span class="import-header">${name}</span>`;
  const labelBox =
    hint === null
      ? ""
      : html`<div class="field${labelError === undefined ? "" : " field-invalid"}">
<label for="${labelId}">Label</label>
<p class="field-hint" id="${labelId}-hint">${hint}</p>
${errorLine(labelId, labelError)}<input id="${labelId}" name="${labelField(index)}" type="text" value="${label}" maxlength="60" autocomplete="off"${aria([`${labelId}-hint`, labelError === undefined ? null : `${labelId}-error`], labelError !== undefined)}>
</div>
`;
  return html`<li class="card import-column">
<fieldset>
<legend>Column ${index + 1}: <span class="outside">${FROM_FILE}</span> ${header}</legend>
<div class="field${colError === undefined ? "" : " field-invalid"}">
<label for="${colId}">Goes to</label>
${errorLine(colId, colError)}<select id="${colId}" name="${columnField(index)}"${aria([colError === undefined ? null : `${colId}-error`], colError !== undefined)}>
${groups.map(
  (group) => html`<optgroup label="${group.group}">
${group.options.map((option) => html`<option value="${option.value}"${option.value === value ? " selected" : ""}>${option.label}</option>\n`)}</optgroup>
`,
)}</select>
</div>
${labelBox}</fieldset>
</li>`;
}

export type MappingState = { targets: Target[]; labels: string[]; asLeads: boolean; problems: MappingProblem[] };

/** The column every row needs, as the matching step names it ("Name", "Title"). */
export const requiredLabel = (module: ImportModuleKey): string =>
  IMPORT_MODULES[module].columns.find((column) => column.required)?.label ?? "Name";

/** GET /import/<id> before it is applied: step 2, where each column goes. Only People asks how new people come in. */
export function importMapPage(ctx: PageContext, draft: Draft, header: readonly string[], fieldDefs: readonly FieldDefRow[], state: MappingState): string {
  const text = IMPORT_TEXT[draft.module];
  const groups = mappingOptions(draft.module, fieldDefs);
  const hint = labelHint(draft.module);
  const errors: FieldError[] = state.problems.map((problem) => ({ id: problemId(problem), message: problem.message }));
  const asRadio = (value: "contacts" | "leads", words: string) =>
    html`<div class="check">
<input id="import-as-${value}" name="${AS_FIELD}" type="radio" value="${value}"${(value === "leads") === state.asLeads ? " checked" : ""}>
<label for="import-as-${value}">${words}</label>
</div>`;
  const asChoice =
    draft.module === "people"
      ? html`<fieldset class="card import-as">
<legend>New people come in as</legend>
${asRadio("contacts", "Contacts")}
${asRadio("leads", "Leads, with the status New")}
</fieldset>
`
      : "";
  return renderPage({
    title: errors.length === 0 ? `${text.heading}: match columns` : `Error: ${text.heading}: match columns`,
    description: text.descriptions.map,
    current: IMPORT_PATH,
    frame: ctx,
    body: html`<h1>${text.heading}</h1>
${step(2, "Match columns")}
<p class="lede">Choose where each column goes. One column must go to ${requiredLabel(draft.module)}. ${count(header.length, "column")} in your file.</p>
${errorSummary(errors)}
${postForm(
  "record-form import-map",
  mapAction(draft.id),
  { csrf: ctx.csrf, here: draftPath(draft.id) },
  html`${hidden(VERSION_FIELD, String(draft.version))}
${asChoice}<ol class="import-columns">
${header.map((name, index) =>
  columnCard(
    index,
    name,
    groups,
    hint,
    state.targets[index] === undefined ? "skip" : targetValue(state.targets[index]),
    state.labels[index] ?? "",
    state.problems,
  ),
)}
</ol>
<div class="form-actions">
<button class="button" type="submit">Next: check the import</button>
<a class="form-cancel" href="${startPath(draft.module, state.asLeads)}">Start again</a>
</div>
`,
  { novalidate: true },
)}`,
  });
}

/** The stored mapping as the matching step first draws it. */
export function mappingState(draft: Draft, header: readonly string[], fallback: Target[]): MappingState {
  const targets = draft.mapping.length === header.length ? draft.mapping : fallback;
  return { targets, labels: header.map((_, i) => defaultLabel(targets[i])), asLeads: draft.asLeads, problems: [] };
}

/** GET /import/<id> once applied: the counts, the change and Undo. */
export async function importDonePage(ctx: PageContext, draft: Draft, result: ImportResult): Promise<string> {
  const text = IMPORT_TEXT[draft.module];
  const change = draft.changeId === null ? null : await getChange(ctx.db, draft.changeId);
  const bannerShown = ctx.query.get("change") === draft.changeId;
  let undo: Html | "" = "";
  if (change !== null && change.undone) undo = html`<p class="import-undone">This import was undone.</p>`;
  else if (change !== null && canUndo(change) && !bannerShown) {
    undo = html`<div class="import-change">
<p>Saved as change ${change.changeId}.</p>
${undoForm(change.changeId, { csrf: ctx.csrf, here: draftPath(draft.id) }, "import-undo")}
</div>`;
  }
  const nothing = draft.changeId === null;
  const back = text.back(draft.asLeads);
  return renderPage({
    title: `${text.heading}: done`,
    description: text.descriptions.done,
    current: IMPORT_PATH,
    frame: ctx,
    body: html`<h1>${text.heading}</h1>
<p class="import-step">Done</p>
<p class="lede">${nothing ? `Nothing in this file changed ${text.yours}, so nothing was saved.` : "The import is saved as one change."}</p>
<div class="card import-counts">${countsList(draft.module, result, draft.asLeads, true)}</div>
${undo}
<p class="form-actions"><a class="button" href="${back.href}">${back.label}</a><a class="form-cancel" href="${startPath(draft.module, draft.asLeads)}">Import another file</a></p>`,
  });
}

/** An import that has expired, or never was. */
export function importGonePage(ctx: PageContext): string {
  return renderPage({
    title: "Import finished or expired",
    description: "This import isn't open any more. If you finished it, it's in Changes; if not, start again.",
    current: IMPORT_PATH,
    frame: ctx,
    body: html`<h1>This import has finished or expired</h1>
<p class="lede">An import is kept open for 2 hours. If you finished it, it's in Changes. If you didn't, nothing from it was saved: start again with your file.</p>
<p class="form-actions"><a class="button" href="${startPath("people")}">Start again</a><a class="form-cancel" href="/changes">See Changes</a></p>`,
  });
}

/** GET /import: step 1 for `module` (people when left out). `as=leads` (from Leads) makes new people leads. */
export async function importStart(ctx: PageContext): Promise<string | null> {
  const module = ctx.query.get("module") ?? "people";
  if (!isImportModuleKey(module)) return null;
  return importStartPage(ctx, module, module === "people" && ctx.query.get("as") === "leads");
}

/** GET /import/<id>: step 2 before the import is applied, the result after. Null when it has expired. */
export async function importDraft(ctx: PageContext, id: string): Promise<string | null> {
  const draft = await getDraft(ctx.db, id, ctx.now);
  if (draft === null) return null;
  if (draft.result !== null) return importDonePage(ctx, draft, draft.result);
  const header = readCsv(await draftText(ctx.db, draft.id)).header;
  const fieldDefs = await listFieldDefs(ctx.db, { includeArchived: true });
  const fallback = autoMatch(IMPORT_MODULES[draft.module], header, fieldDefs);
  return importMapPage(ctx, draft, header, fieldDefs, mappingState(draft, header, fallback));
}

/** GET /import/<id>/preview: step 3, planned against the records on file now. Null when it has expired. */
export async function importPreview(ctx: PageContext, id: string): Promise<string | null> {
  const draft = await getDraft(ctx.db, id, ctx.now);
  if (draft === null) return null;
  if (draft.result !== null) return importDonePage(ctx, draft, draft.result);
  try {
    const planned = await planDraft(ctx.db, draft, await draftText(ctx.db, draft.id), ctx.now, NOTHING_CONFIRMED);
    return importPreviewPage(ctx, { draft, planned });
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    return importPreviewPage(ctx, { draft, refused: error.message });
  }
}
