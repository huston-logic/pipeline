// The board import's posts and pages (decision 0036). POST /import stores the uploaded file as a draft; POST
// /import/<id>/map saves the column matches; POST /import/<id>/apply plans the file again against the people on file
// now and writes it as one audited change (actor owner, tool "import"), in the same batch that marks the draft applied,
// so a second apply writes nothing and shows the first result. Every import post first deletes expired drafts.
import { listFieldDefs } from "../db/queries.ts";
import { isImportId, newId } from "../ids.ts";
import { IMPORT_ACTOR } from "../import/change.ts";
import {
  appliedStatements,
  createDraft,
  deleteExpiredDrafts,
  type Draft,
  draftGuard,
  draftText,
  getDraft,
  markApplied,
  saveMapping,
} from "../import/drafts.ts";
import { autoMatch, fileChange, MappingError, mapRows, planNewFields, readCsv } from "../import/engine.ts";
import { peopleModule } from "../import/modules/people.ts";
import { RecordTooLargeError } from "../services/bulk.ts";
import { commitChange, isDuplicateEmailFailure, StaleWriteError } from "../services/change.ts";
import { UserError } from "../services/errors.ts";
import { type ActionContext, type ActionResult, notFound, page, pageContext, redirect, refusedPage, type Route } from "./action-kit.ts";
import {
  ALLOW_DUPLICATES_FIELD,
  AS_FIELD,
  draftPath,
  FILE_FIELD,
  IMPORT_MAX_COLUMNS,
  PASTE_FIELD,
  planDraft,
  postedMapping,
  previewPath,
  resultOf,
  startPath,
  VERSION_FIELD,
} from "./import-kit.ts";
import { importGonePage, importMapPage, importStartPage, type MappingProblem } from "./pages/import.ts";
import { withChange } from "./return-to.ts";

/** Files a spreadsheet app saves that are not CSV text. */
const SPREADSHEET_FILE = /\.(xlsx|xlsm|xls|ods|numbers)$/i;

const doneHref = (draft: Pick<Draft, "id" | "changeId">) =>
  draft.changeId === null ? draftPath(draft.id) : withChange(draftPath(draft.id), draft.changeId);

/** The header of a file as it was uploaded, plain-English refusals for one the import can't take. */
function headerOf(text: string): string[] {
  const { header } = readCsv(text);
  if (header.every((cell) => cell.trim() === "")) {
    throw new UserError("The file is empty. Export your contacts with a header row and try again.");
  }
  if (header.length === 1 && (header[0] ?? "").includes("\t")) {
    throw new UserError(
      "These rows are split by tabs, the way cells copied from a spreadsheet are. Save the sheet as a CSV file and choose that file instead.",
    );
  }
  if (header.length > IMPORT_MAX_COLUMNS) {
    throw new UserError(
      `This file has ${header.length} columns. One import takes at most ${IMPORT_MAX_COLUMNS}. Remove the columns you don't need and try again.`,
    );
  }
  return header;
}

/** POST /import: the file (or pasted text) becomes a draft with the columns matched by name, then step 2. */
async function upload(ctx: ActionContext): Promise<ActionResult> {
  await deleteExpiredDrafts(ctx.db, ctx.now);
  const asLeads = ctx.form.get(AS_FIELD) === "leads";
  const refuse = (message: string) => page(422, importStartPage(pageContext(ctx, startPath(asLeads)), asLeads, message));
  const file = ctx.upload?.get(FILE_FIELD) ?? null;
  const chosen = file !== null && typeof file !== "string" && (file.size > 0 || file.name !== "") ? file : null;
  const paste = ctx.form.get(PASTE_FIELD) ?? "";
  const pasted = paste.trim() !== "";
  if (chosen !== null && pasted) return refuse("Choose a file or paste the text, not both. Clear one and try again.");
  if (chosen === null && !pasted) return refuse("Choose a CSV file, or paste the text of one.");
  if (chosen !== null && SPREADSHEET_FILE.test(chosen.name)) {
    return refuse("That's a spreadsheet file, not a CSV file. Save it as CSV (see Getting a CSV file) and choose that file.");
  }
  const text = chosen === null ? paste : await chosen.text();
  if (text.includes("\u0000")) return refuse("That file isn't text, so it isn't a CSV file. Save your sheet as CSV and choose that file.");
  let header: string[];
  try {
    header = headerOf(text);
  } catch (error) {
    if (error instanceof UserError) return refuse(error.message);
    throw error;
  }
  const mapping = autoMatch(peopleModule, header, await listFieldDefs(ctx.db));
  const id = await createDraft(ctx.db, { module: "people", text, mapping, asLeads, now: ctx.now });
  return redirect(draftPath(id));
}

/** The draft a post names, or the answer to give instead: 404 for an id that can't be one, the expired page if gone. */
async function draftFor(ctx: ActionContext, id: string): Promise<Draft | ActionResult> {
  await deleteExpiredDrafts(ctx.db, ctx.now);
  if (!isImportId(id)) return notFound(ctx);
  const draft = await getDraft(ctx.db, id, ctx.now);
  return draft ?? page(404, importGonePage(pageContext(ctx, startPath(false))));
}

const isAnswer = (value: Draft | ActionResult): value is ActionResult => "kind" in value;

/** The mapping's problems in board words, each pointing at its column's select or label box. */
function mappingProblems(
  ctx: ActionContext,
  header: string[],
  posted: ReturnType<typeof postedMapping>,
  fieldDefs: Awaited<ReturnType<typeof listFieldDefs>>,
): MappingProblem[] {
  // Columns are named by number: the header is outside text, shown only in the column's own legend.
  const problems: MappingProblem[] = [
    ...posted.unchosen.map((column): MappingProblem => ({ column, message: `Choose where column ${column + 1} goes.` })),
    ...posted.unlabelled.map(
      (column): MappingProblem => ({ column, control: "label", message: `Type a label for the new field from column ${column + 1}.` }),
    ),
  ];
  if (problems.length > 0) return problems;
  if (!posted.targets.some((target) => target.kind === "builtin" && target.key === "name")) {
    return [{ message: "Choose Name for the column that holds each person's name." }];
  }
  try {
    const { targets, created } = planNewFields(peopleModule, header, posted.targets, fieldDefs, ctx.now);
    mapRows(peopleModule, [], targets, header, [...fieldDefs, ...created]);
  } catch (error) {
    if (error instanceof MappingError) {
      const kind = posted.targets[error.column]?.kind;
      return [{ column: error.column, control: kind === "new_field" || kind === "notes" ? "label" : "col", message: error.message }];
    }
    if (error instanceof UserError) return [{ message: error.message }];
    throw error;
  }
  return [];
}

/** POST /import/<id>/map: saves where each column goes and how new people come in, then step 3. */
async function map(ctx: ActionContext, id: string): Promise<ActionResult> {
  const found = await draftFor(ctx, id);
  if (isAnswer(found)) return found;
  const draft = found;
  if (draft.result !== null) return redirect(doneHref(draft));
  const header = readCsv(await draftText(ctx.db, draft.id)).header;
  const posted = postedMapping(ctx.form, header);
  const fieldDefs = await listFieldDefs(ctx.db, { includeArchived: true });
  const problems = mappingProblems(ctx, header, posted, fieldDefs);
  if (problems.length > 0) {
    const labels = header.map((_, i) => ctx.form.get(`label.${i}`) ?? "");
    const state = { targets: posted.targets, labels, asLeads: posted.asLeads, problems };
    return page(422, importMapPage(pageContext(ctx, draftPath(draft.id)), draft, header, fieldDefs, state));
  }
  if (!(await saveMapping(ctx.db, draft, posted.targets, posted.asLeads))) {
    const message = "This import changed in another window. Open it again and check the matches.";
    return page(422, refusedPage(ctx, "The matches weren't saved", message, draftPath(draft.id), ""));
  }
  return redirect(previewPath(draft.id));
}

/** POST /import/<id>/apply: plans the file once against the data now and writes it, marking the draft applied. */
async function apply(ctx: ActionContext, id: string): Promise<ActionResult> {
  const found = await draftFor(ctx, id);
  if (isAnswer(found)) return found;
  const draft = found;
  if (draft.result !== null) return redirect(doneHref(draft));
  const back = previewPath(draft.id);
  const refused = (message: string) => page(422, refusedPage(ctx, "The import wasn't saved", message, back, ""));
  if (ctx.form.get(VERSION_FIELD) !== String(draft.version)) {
    return refused("The column matches changed since this page was drawn. Check the import again, then import it.");
  }
  const allowDuplicates = ctx.form.get(ALLOW_DUPLICATES_FIELD) === "yes";
  let planned: Awaited<ReturnType<typeof planDraft>>;
  try {
    planned = await planDraft(ctx.db, draft, await draftText(ctx.db, draft.id), ctx.now, allowDuplicates);
  } catch (error) {
    if (error instanceof UserError) return refused(error.message);
    throw error;
  }
  const input = fileChange(peopleModule, planned.plan, planned.contacts, ctx.now, planned.mapped.newFields);
  if (input === null) {
    await markApplied(ctx.db, draft, resultOf(planned, false), ctx.now);
    return redirect(draftPath(draft.id));
  }
  const changeId = newId("chg");
  try {
    await commitChange(
      { db: ctx.db, now: ctx.now, ...IMPORT_ACTOR },
      {
        ...input,
        changeId,
        leading: [draftGuard(ctx.db, draft, ctx.now)],
        extra: appliedStatements(ctx.db, draft, resultOf(planned, true), changeId),
      },
    );
  } catch (error) {
    // Another apply of this draft may have won the race: whatever failed, show its result rather than an error.
    const latest = await getDraft(ctx.db, draft.id, ctx.now);
    if (latest?.result) return redirect(doneHref(latest));
    if (latest === null) return page(404, importGonePage(pageContext(ctx, startPath(false))));
    if (error instanceof StaleWriteError) {
      return refused("Someone in this file was changed while it was importing, so nothing was saved. Check the import again.");
    }
    if (isDuplicateEmailFailure(error)) {
      return refused("Someone with an email in this file was added while it was importing, so nothing was saved. Check the import again.");
    }
    if (error instanceof RecordTooLargeError) {
      return refused(
        "Someone on file is too large to fill in with this import in one step, so nothing was saved. " +
          "Leave out the columns that fill in details on people already on file, or shorten the longest values, and try again.",
      );
    }
    throw error;
  }
  return redirect(withChange(draftPath(draft.id), changeId));
}

export const IMPORT_ROUTES: Route[] = [
  { path: /^\/import()$/, handle: (ctx) => upload(ctx), upload: true },
  { path: /^\/import\/([^/]+)\/map$/, handle: map, big: true },
  { path: /^\/import\/([^/]+)\/apply$/, handle: apply },
];
