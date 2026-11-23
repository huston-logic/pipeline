// The board import for People (decision 0036), in three steps and a result: choose a file (or paste one), match its
// columns, check what will happen, then the import's counts with its change and Undo. The file's values never reach a
// page: only its header names, escaped and labelled "From your file", line numbers, counts and ids of people on file.
import type { ContactRow, FieldDefRow } from "../../db/db.ts";
import { listFieldDefs } from "../../db/queries.ts";
import { deleteExpiredDrafts, type Draft, draftText, getDraft, type ImportResult } from "../../import/drafts.ts";
import { autoMatch, IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, readCsv, type Target } from "../../import/engine.ts";
import { peopleModule } from "../../import/modules/people.ts";
import { isTrusted } from "../../services/labels.ts";
import { UserError } from "../../services/errors.ts";
import { getChange } from "../../services/read.ts";
import { canUndo, undoForm } from "../banner.ts";
import type { PageContext } from "../context.ts";
import { hidden, postForm } from "../forms.ts";
import { type Html, html } from "../html.ts";
import {
  ALLOW_DUPLICATES_FIELD,
  AS_FIELD,
  applyAction,
  columnField,
  type DraftPlan,
  defaultLabel,
  draftPath,
  FILE_FIELD,
  IMPORT_PATH,
  labelField,
  mapAction,
  PASTE_FIELD,
  planDraft,
  previewPath,
  startPath,
  targetValue,
  VERSION_FIELD,
} from "../import-kit.ts";
import { checkbox, errorSummary, type FieldError } from "../inputs.ts";
import { renderPage } from "../layout.ts";
import { contactLink, count, formatNumber, pairs, section } from "../parts.ts";

const HEADING = "Import people";
const FROM_FILE = "From your file";
/** How many lines each list on the check step shows. */
const SHOWN = 20;

const step = (n: 1 | 2 | 3, name: string): Html => html`<p class="import-step">Step ${n} of 3: ${name}</p>`;

const peoplePage = (asLeads: boolean) => (asLeads ? "/leads" : "/contacts");

/** An error on the matching step: the column's select or its label box. */
export type MappingProblem = { column?: number; control?: "col" | "label"; message: string };

const problemId = (problem: MappingProblem) =>
  problem.column === undefined ? undefined : `${problem.control === "label" ? "label" : "col"}-${problem.column}`;

/** GET /import: step 1, a file or pasted rows in one multipart form. */
export function importStartPage(ctx: PageContext, asLeads: boolean, problem?: string): string {
  const errors: FieldError[] = problem === undefined ? [] : [{ id: "import-file", message: problem }];
  const cancel = peoplePage(asLeads);
  return renderPage({
    title: problem === undefined ? HEADING : `Error: ${HEADING}`,
    description: "Bring people in from a spreadsheet: choose a CSV file or paste its rows, then match the columns.",
    current: IMPORT_PATH,
    frame: ctx,
    body: html`<h1>${HEADING}</h1>
${step(1, "Choose a file")}
<p class="lede">Bring in people from a spreadsheet saved as a CSV file. You match the columns and check the result before anything is saved.</p>
${errorSummary(errors)}
${postForm(
  "record-form import-upload",
  IMPORT_PATH,
  { csrf: ctx.csrf, here: startPath(asLeads) },
  html`${hidden("module", "people")}${hidden(AS_FIELD, asLeads ? "leads" : "contacts")}
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
<a class="form-cancel" href="${cancel}">Cancel</a>
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
)}`,
  });
}

type Option = { value: string; label: string };

function mappingOptions(fieldDefs: readonly FieldDefRow[]): { group: string; options: Option[] }[] {
  const custom = fieldDefs.filter((def) => def.entity === "contact" && def.archived === 0);
  return [
    { group: "Contact details", options: peopleModule.columns.map((column) => ({ value: `builtin:${column.key}`, label: column.label })) },
    ...(custom.length === 0 ? [] : [{ group: "Your fields", options: custom.map((def) => ({ value: `field:${def.key}`, label: def.label })) }]),
    {
      group: "Other",
      options: [
        { value: "new_field", label: "New field" },
        { value: "notes", label: "Add to notes" },
        { value: "skip", label: "Don't import" },
      ],
    },
  ];
}

const errorLine = (id: string, message: string | undefined) =>
  message === undefined ? "" : html`<p class="field-error" id="${id}-error"><span class="visually-hidden">Error: </span>${message}</p>`;

const aria = (ids: (string | null)[], invalid: boolean): Html => {
  const described = ids.filter((id): id is string => id !== null);
  return html`${described.length === 0 ? "" : html` aria-describedby="${described.join(" ")}"`}${invalid ? html` aria-invalid="true"` : ""}`;
};

function columnCard(
  index: number,
  name: string,
  groups: ReturnType<typeof mappingOptions>,
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
<div class="field${labelError === undefined ? "" : " field-invalid"}">
<label for="${labelId}">Label</label>
<p class="field-hint" id="${labelId}-hint">Used by New field and Add to notes.</p>
${errorLine(labelId, labelError)}<input id="${labelId}" name="${labelField(index)}" type="text" value="${label}" maxlength="60" autocomplete="off"${aria([`${labelId}-hint`, labelError === undefined ? null : `${labelId}-error`], labelError !== undefined)}>
</div>
</fieldset>
</li>`;
}

export type MappingState = { targets: Target[]; labels: string[]; asLeads: boolean; problems: MappingProblem[] };

/** GET /import/<id> before it is applied: step 2, where each column goes. */
export function importMapPage(ctx: PageContext, draft: Draft, header: readonly string[], fieldDefs: readonly FieldDefRow[], state: MappingState): string {
  const groups = mappingOptions(fieldDefs);
  const errors: FieldError[] = state.problems.map((problem) => ({ id: problemId(problem), message: problem.message }));
  const asRadio = (value: "contacts" | "leads", text: string) =>
    html`<div class="check">
<input id="import-as-${value}" name="${AS_FIELD}" type="radio" value="${value}"${(value === "leads") === state.asLeads ? " checked" : ""}>
<label for="import-as-${value}">${text}</label>
</div>`;
  return renderPage({
    title: errors.length === 0 ? `${HEADING}: match columns` : `Error: ${HEADING}: match columns`,
    description: "Match each column of the file to a contact detail, a field or the notes, or leave it out.",
    current: IMPORT_PATH,
    frame: ctx,
    body: html`<h1>${HEADING}</h1>
${step(2, "Match columns")}
<p class="lede">Choose where each column goes. One column must go to Name. ${count(header.length, "column")} in your file.</p>
${errorSummary(errors)}
${postForm(
  "record-form import-map",
  mapAction(draft.id),
  { csrf: ctx.csrf, here: draftPath(draft.id) },
  html`${hidden(VERSION_FIELD, String(draft.version))}
<fieldset class="card import-as">
<legend>New people come in as</legend>
${asRadio("contacts", "Contacts")}
${asRadio("leads", "Leads, with the status New")}
</fieldset>
<ol class="import-columns">
${header.map((name, index) =>
  columnCard(index, name, groups, state.targets[index] === undefined ? "skip" : targetValue(state.targets[index]), state.labels[index] ?? "", state.problems),
)}
</ol>
<div class="form-actions">
<button class="button" type="submit">Next: check the import</button>
<a class="form-cancel" href="${startPath(state.asLeads)}">Start again</a>
</div>
`,
  { novalidate: true },
)}`,
  });
}

/** The stored mapping as the matching step first draws it. */
export function mappingState(draft: Draft, header: readonly string[], fallback: Target[]): MappingState {
  const targets = draft.mapping.length === header.length ? draft.mapping : fallback;
  return { targets, labels: header.map((name, i) => defaultLabel(targets[i], name)), asLeads: draft.asLeads, problems: [] };
}

const lineList = (lines: number[]): string => {
  const shown = lines.slice(0, SHOWN).map((n) => formatNumber(n));
  const more = lines.length - shown.length;
  return `${lines.length === 1 ? "Line" : "Lines"} ${shown.join(", ")}${more > 0 ? ` and ${formatNumber(more)} more` : ""}`;
};

const moreLine = (total: number): Html | "" =>
  total > SHOWN ? html`<li class="panel-note">And ${formatNumber(total - SHOWN)} more.</li>` : "";

function personOnFile(id: string, contacts: ReadonlyMap<string, ContactRow>): Html {
  const contact = contacts.get(id);
  if (contact === undefined) return html`contact ${id}`;
  return contactLink(contact.id, contact.name, !isTrusted(contact, "name"));
}

function countsList(result: ImportResult, asLeads: boolean, applied: boolean): Html | "" {
  const who = asLeads ? "New leads" : "New contacts";
  return pairs([
    { name: who, value: formatNumber(result.created) },
    { name: "Details filled in", value: formatNumber(result.filled) },
    { name: "Already up to date", value: formatNumber(result.unchanged) },
    { name: "Lines skipped", value: formatNumber(result.skipped) },
    { name: applied ? "Possible duplicates left out" : "Possible duplicates", value: formatNumber(result.duplicates) },
    result.fields > 0 && { name: applied ? "New fields added" : "New fields", value: formatNumber(result.fields) },
  ]);
}

export type PreviewData = { draft: Draft; planned: DraftPlan } | { draft: Draft; refused: string };

/** GET /import/<id>/preview: step 3, what the import would do with the people on file now, and Import. */
export function importPreviewPage(ctx: PageContext, data: PreviewData): string {
  const { draft } = data;
  const frame = (body: Html, refused: boolean) =>
    renderPage({
      title: refused ? `Error: ${HEADING}: check` : `${HEADING}: check`,
      description: "What the import would do: new people, details filled in, lines skipped and possible duplicates.",
      current: IMPORT_PATH,
      frame: ctx,
      body: html`<h1>${HEADING}</h1>
${step(3, "Check and import")}
${body}`,
    });
  if ("refused" in data) {
    return frame(
      html`<p class="lede refusal">${data.refused}</p>
<p class="card-actions"><a class="button" href="${draftPath(draft.id)}">Match the columns again</a></p>`,
      true,
    );
  }
  const { plan, mapped, contacts } = data.planned;
  const byId = new Map(contacts.map((contact) => [contact.id, contact]));
  const result: ImportResult = {
    created: plan.create.length,
    filled: plan.merge.length,
    unchanged: plan.unchanged.length,
    skipped: plan.skipped.length,
    duplicates: plan.duplicates.length,
    fields: mapped.newFields.length,
  };
  const writes = plan.create.length + plan.merge.length;
  const sections: (Html | "")[] = [
    mapped.newFields.length === 0
      ? ""
      : section(
          "import-fields",
          "New fields",
          html`<p class="section-note">Added as text fields on contacts, in the same change as the people.</p>
<ul class="panel rows">${mapped.newFields.map((def) => html`<li>${def.label} <span class="import-key">(key ${def.key})</span></li>`)}</ul>`,
        ),
    plan.skipped.length === 0
      ? ""
      : section(
          "import-skipped",
          "Lines skipped",
          html`<ul class="panel rows">${plan.skipped.slice(0, SHOWN).map((row) => html`<li>Line ${formatNumber(row.line)}: ${row.reason}.</li>`)}${moreLine(plan.skipped.length)}</ul>`,
        ),
    plan.create.length === 0
      ? ""
      : section("import-new", draft.asLeads ? "New leads" : "New contacts", html`<p class="import-lines">${lineList(plan.create.map((row) => row.line))}.</p>`),
    plan.merge.length === 0
      ? ""
      : section(
          "import-filled",
          "Details filled in",
          html`<p class="section-note">Only empty details are filled; nothing on file is replaced. Add to notes lines go after the notes on file.</p>
<ul class="panel rows">${plan.merge.slice(0, SHOWN).map((row) => html`<li>Line ${formatNumber(row.line)}: ${personOnFile(row.id, byId)}</li>`)}${moreLine(plan.merge.length)}</ul>`,
        ),
    plan.unchanged.length === 0
      ? ""
      : section("import-unchanged", "Already up to date", html`<p class="import-lines">${lineList(plan.unchanged.map((row) => row.line))}.</p>`),
    plan.duplicates.length === 0
      ? ""
      : section(
          "import-duplicates",
          "Possible duplicates",
          html`<p class="section-note">No email, and the same business as someone on file or an earlier line. Left out unless you tick the box below.</p>
<ul class="panel rows">${plan.duplicates.slice(0, SHOWN).map(
            (row) =>
              html`<li>Line ${formatNumber(row.line)}: ${row.ofId === null ? `the same business as line ${formatNumber(row.ofLine ?? 0)}` : html`the same business as ${personOnFile(row.ofId, byId)}`}</li>`,
          )}${moreLine(plan.duplicates.length)}</ul>`,
        ),
  ];
  const canApply = writes > 0 || plan.duplicates.length > 0;
  const apply = canApply
    ? postForm(
        "import-apply",
        applyAction(draft.id),
        { csrf: ctx.csrf, here: previewPath(draft.id) },
        html`${hidden(VERSION_FIELD, String(draft.version))}
${plan.duplicates.length === 0 ? "" : checkbox({ id: "import-duplicates-too", name: ALLOW_DUPLICATES_FIELD, label: "Import possible duplicates too", value: "yes", checked: false })}
<div class="form-actions">
<button class="button" type="submit">Import</button>
<a class="form-cancel" href="${draftPath(draft.id)}">Back to matching</a>
</div>`,
      )
    : html`<p class="refusal">Nothing in this file would change your people.</p>
<p class="form-actions"><a class="button button-quiet" href="${draftPath(draft.id)}">Back to matching</a><a class="form-cancel" href="${startPath(draft.asLeads)}">Start again</a></p>`;
  return frame(
    html`<p class="lede">Nothing is saved until you tap Import. The import is one change, so one Undo takes it all back.</p>
${section("import-counts", "What will happen", html`<div class="card import-counts">${countsList(result, draft.asLeads, false)}</div>`)}
${sections.filter((part) => part !== "")}
${apply}`,
    false,
  );
}

/** GET /import/<id> once applied: the counts, the change and Undo. */
export async function importDonePage(ctx: PageContext, draft: Draft, result: ImportResult): Promise<string> {
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
  return renderPage({
    title: `${HEADING}: done`,
    description: "The import's counts: new people, details filled in, lines skipped. Undo takes it all back.",
    current: IMPORT_PATH,
    frame: ctx,
    body: html`<h1>${HEADING}</h1>
<p class="import-step">Done</p>
<p class="lede">${nothing ? "Nothing in this file changed your people, so nothing was saved." : "The import is saved as one change."}</p>
<div class="card import-counts">${countsList(result, draft.asLeads, true)}</div>
${undo}
<p class="form-actions"><a class="button" href="${peoplePage(draft.asLeads)}">${draft.asLeads ? "See your leads" : "See your contacts"}</a><a class="form-cancel" href="${startPath(draft.asLeads)}">Import another file</a></p>`,
  });
}

/** An import that has expired, or never was. */
export function importGonePage(ctx: PageContext): string {
  return renderPage({
    title: "Import expired",
    description: "This import isn't kept any more. Start again with your file.",
    current: IMPORT_PATH,
    frame: ctx,
    body: html`<h1>This import has expired</h1>
<p class="lede">An import you haven't finished is kept for 2 hours. Nothing from it was saved. Start again with your file.</p>
<p class="card-actions"><a class="button" href="${startPath(false)}">Start again</a></p>`,
  });
}

/** GET /import: step 1. `as=leads` (from Leads) makes new people leads. Any module but people is not a page. */
export async function importStart(ctx: PageContext): Promise<string | null> {
  await deleteExpiredDrafts(ctx.db, ctx.now);
  const module = ctx.query.get("module");
  if (module !== null && module !== "people") return null;
  return importStartPage(ctx, ctx.query.get("as") === "leads");
}

/** GET /import/<id>: step 2 before the import is applied, the result after. Null when it has expired. */
export async function importDraft(ctx: PageContext, id: string): Promise<string | null> {
  await deleteExpiredDrafts(ctx.db, ctx.now);
  const draft = await getDraft(ctx.db, id, ctx.now);
  if (draft === null) return null;
  if (draft.result !== null) return importDonePage(ctx, draft, draft.result);
  const header = readCsv(await draftText(ctx.db, draft.id)).header;
  const fieldDefs = await listFieldDefs(ctx.db, { includeArchived: true });
  return importMapPage(ctx, draft, header, fieldDefs, mappingState(draft, header, autoMatch(peopleModule, header, fieldDefs)));
}

/** GET /import/<id>/preview: step 3, planned against the people on file now. Null when it has expired. */
export async function importPreview(ctx: PageContext, id: string): Promise<string | null> {
  await deleteExpiredDrafts(ctx.db, ctx.now);
  const draft = await getDraft(ctx.db, id, ctx.now);
  if (draft === null) return null;
  if (draft.result !== null) return importDonePage(ctx, draft, draft.result);
  try {
    const planned = await planDraft(ctx.db, draft, await draftText(ctx.db, draft.id), ctx.now, false);
    return importPreviewPage(ctx, { draft, planned });
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    return importPreviewPage(ctx, { draft, refused: error.message });
  }
}
