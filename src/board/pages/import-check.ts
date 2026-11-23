// Step 3 of the board import (decisions 0036, 0037): what the import would do with the records on file now, and
// Import. Every list shows line numbers, counts, field and stage labels and records on file (by their links), never a
// value from the file. People may tick "Import possible duplicates too"; Deals "Bring in closed deals as history";
// both "This is my own list" (decision 0038), unticked by default.
import type { ContactRow, DealRow } from "../../db/db.ts";
import type { Draft, ImportResult } from "../../import/drafts.ts";
import type { ImportModuleKey } from "../../import/engine.ts";
import { closedSentence } from "../../import/modules/deals.ts";
import { isTrusted } from "../../services/labels.ts";
import type { PageContext } from "../context.ts";
import { hidden, postForm } from "../forms.ts";
import { type Html, html } from "../html.ts";
import {
  ALLOW_DUPLICATES_FIELD,
  applyAction,
  CLOSED_FIELD,
  draftPath,
  IMPORT_PATH,
  OWN_LIST_FIELD,
  previewPath,
  startPath,
  VERSION_FIELD,
} from "../import-kit.ts";
import { type DraftPlan, resultOf } from "../import-plan.ts";
import { IMPORT_TEXT } from "../import-text.ts";
import { checkbox } from "../inputs.ts";
import { renderPage } from "../layout.ts";
import { contactLink, dealLink, formatNumber, pairs, section } from "../parts.ts";

/** How many lines each list on the check step shows. */
const SHOWN = 20;

export const step = (n: 1 | 2 | 3, name: string): Html => html`<p class="import-step">Step ${n} of 3: ${name}</p>`;

/** The counts of an import, as the check step forecasts them (`applied` false) or the done step shows them. */
export function countsList(module: ImportModuleKey, result: ImportResult, asLeads: boolean, applied: boolean): Html | "" {
  const shared = [
    { name: "Details filled in", value: formatNumber(result.filled) },
    { name: "Already up to date", value: formatNumber(result.unchanged) },
    { name: "Lines skipped", value: formatNumber(result.skipped) },
  ];
  const fields = result.fields > 0 && { name: applied ? "New fields added" : "New fields", value: formatNumber(result.fields) };
  // Also among the lines skipped: the file marks them archived, so nothing of theirs comes in.
  const archived = result.archived > 0 && { name: "Archived in the file, left out", value: formatNumber(result.archived) };
  switch (module) {
    case "people":
      return pairs([
        { name: asLeads ? "New leads" : "New contacts", value: formatNumber(result.created) },
        ...shared,
        { name: applied ? "Possible duplicates left out" : "Possible duplicates", value: formatNumber(result.duplicates) },
        archived,
        fields,
      ]);
    case "deals":
      return pairs([
        { name: "New deals", value: formatNumber(result.created) },
        { name: "New people", value: formatNumber(result.people) },
        ...shared,
        { name: applied ? "Closed deals brought in" : "Closed deals in the file", value: formatNumber(result.closed) },
        archived,
        fields,
      ]);
    case "tasks":
      return pairs([{ name: "New tasks", value: formatNumber(result.created) }, ...shared]);
  }
}

const lineList = (lines: number[]): string => {
  const shown = lines.slice(0, SHOWN).map((n) => formatNumber(n));
  const more = lines.length - shown.length;
  return `${lines.length === 1 ? "Line" : "Lines"} ${shown.join(", ")}${more > 0 ? ` and ${formatNumber(more)} more` : ""}`;
};

const moreLine = (total: number): Html | "" =>
  total > SHOWN ? html`<li class="panel-note">And ${formatNumber(total - SHOWN)} more.</li>` : "";

const lines = (id: string, heading: string, list: number[]): Html | "" =>
  list.length === 0 ? "" : section(id, heading, html`<p class="import-lines">${lineList(list)}.</p>`);

function personOnFile(id: string, contacts: ReadonlyMap<string, ContactRow>): Html {
  const contact = contacts.get(id);
  if (contact === undefined) return html`contact ${id}`;
  return contactLink(contact.id, contact.name, !isTrusted(contact, "name"));
}

function dealOnFile(id: string, deals: ReadonlyMap<string, DealRow>): Html {
  const deal = deals.get(id);
  if (deal === undefined) return html`deal ${id}`;
  return dealLink(deal.id, deal.title, !isTrusted(deal, "title"));
}

/** Each "Line n: record" item of a list, the first SHOWN of them. */
const recordList = <T extends { line: number }>(rows: readonly T[], item: (row: T) => Html): Html =>
  html`<ul class="panel rows">${rows.slice(0, SHOWN).map((row) => html`<li>Line ${formatNumber(row.line)}: ${item(row)}</li>`)}${moreLine(rows.length)}</ul>`;

/**
 * "This is my own list" (decision 0038): what it confirms, said on the box. Shown only when the import writes people,
 * never for Tasks, and never ticked until the owner ticks it.
 */
function ownListBox(planned: DraftPlan): Html | "" {
  switch (planned.module) {
    case "people":
      if (planned.plan.create.length + planned.plan.merge.length + planned.plan.duplicates.length === 0) return "";
      return ownListCheck("This is my own list: show names, businesses, emails, phones and sources as mine.");
    case "deals":
      if (planned.plan.people.length + planned.plan.closed.length === 0) return "";
      return ownListCheck("This is my own list: show the people's names, businesses and emails as mine.");
    case "tasks":
      return "";
  }
}

const ownListCheck = (label: string): Html =>
  checkbox({ id: "import-own-list", name: OWN_LIST_FIELD, label, value: "yes", checked: false, hint: "Leave it unticked if someone else made this file." });

/** The sections only this module's check step has, and the box it may ask the owner to tick. */
function moduleSections(planned: DraftPlan, asLeads: boolean): { sections: (Html | "")[]; box: Html | "" } {
  switch (planned.module) {
    case "people": {
      const { plan, ctx } = planned;
      const byId = new Map(ctx.map((contact) => [contact.id, contact]));
      return {
        sections: [
          lines("import-new", asLeads ? "New leads" : "New contacts", plan.create.map((row) => row.line)),
          plan.merge.length === 0
            ? ""
            : section(
                "import-filled",
                "Details filled in",
                html`<p class="section-note">Only empty details are filled; nothing on file is replaced. Add to notes lines go after the notes on file.</p>
${recordList(plan.merge, (row) => personOnFile(row.id, byId))}`,
              ),
          lines("import-unchanged", "Already up to date", plan.unchanged.map((row) => row.line)),
          plan.duplicates.length === 0
            ? ""
            : section(
                "import-duplicates",
                "Possible duplicates",
                html`<p class="section-note">No email, and the same business as someone on file or an earlier line. Left out unless you tick the box below.</p>
${recordList(plan.duplicates, (row) => (row.ofId === null ? html`the same business as line ${formatNumber(row.ofLine ?? 0)}` : html`the same business as ${personOnFile(row.ofId, byId)}`))}`,
              ),
        ],
        box:
          plan.duplicates.length === 0
            ? ""
            : checkbox({ id: "import-duplicates-too", name: ALLOW_DUPLICATES_FIELD, label: "Import possible duplicates too", value: "yes", checked: false }),
      };
    }
    case "deals": {
      const { plan, ctx } = planned;
      const contacts = new Map(ctx.contacts.map((contact) => [contact.id, contact]));
      const deals = new Map(ctx.deals.map((deal) => [deal.id, deal]));
      return {
        sections: [
          plan.closed.length === 0
            ? ""
            : section(
                "import-closed",
                "Closed deals",
                html`<p>${closedSentence(plan.closed, ctx.stages)}.</p>
<p class="section-note">They come in as history only if you tick the box below. Left unticked, those lines are skipped.</p>
<p class="import-lines">${lineList(plan.closed.map((row) => row.line))}.</p>`,
              ),
          lines("import-new", "New deals", plan.create.map((row) => row.line)),
          plan.people.length === 0
            ? ""
            : section(
                "import-people",
                "New people",
                html`<p class="section-note">Added as contacts for their deals. The first line that names each one is listed.</p>
<p class="import-lines">${lineList(plan.people.map((row) => row.line))}.</p>`,
              ),
          plan.qualify.length === 0
            ? ""
            : section(
                "import-qualified",
                "Leads who become Qualified",
                html`<p class="section-note">They get an open deal, so they stop being leads in the same change.</p>
<ul class="panel rows">${plan.qualify.slice(0, SHOWN).map((id) => html`<li>${personOnFile(id, contacts)}</li>`)}${moreLine(plan.qualify.length)}</ul>`,
              ),
          plan.merge.length === 0
            ? ""
            : section(
                "import-filled",
                "Details filled in",
                html`<p class="section-note">Deals matched by their id. Only empty details are filled; the stage, the title and the person stay as they are.</p>
${recordList(plan.merge, (row) => dealOnFile(row.id, deals))}`,
              ),
          lines("import-unchanged", "Already up to date", plan.unchanged.map((row) => row.line)),
        ],
        box:
          plan.closed.length === 0
            ? ""
            : checkbox({ id: "import-closed-too", name: CLOSED_FIELD, label: "Bring in closed deals as history", value: "yes", checked: false }),
      };
    }
    case "tasks": {
      const { plan } = planned;
      return {
        sections: [
          lines("import-new", "New tasks", plan.create.map((row) => row.line)),
          plan.merge.length === 0
            ? ""
            : section(
                "import-filled",
                "Details filled in",
                html`<p class="section-note">Tasks matched by their id. Only an empty due date is filled.</p>
${recordList(plan.merge, (row) => html`task ${row.id}`)}`,
              ),
          lines("import-unchanged", "Already up to date", plan.unchanged.map((row) => row.line)),
        ],
        box: "",
      };
    }
  }
}

export type PreviewData = { draft: Draft; planned: DraftPlan } | { draft: Draft; refused: string };

/** GET /import/<id>/preview: step 3, what the import would do with the records on file now, and Import. */
export function importPreviewPage(ctx: PageContext, data: PreviewData): string {
  const { draft } = data;
  const text = IMPORT_TEXT[draft.module];
  const frame = (body: Html, refused: boolean) =>
    renderPage({
      title: refused ? `Error: ${text.heading}: check` : `${text.heading}: check`,
      description: text.descriptions.check,
      current: IMPORT_PATH,
      frame: ctx,
      body: html`<h1>${text.heading}</h1>
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
  const { planned } = data;
  const { plan, mapped } = planned;
  const result = { ...resultOf(planned, false), fields: mapped.newFields.length };
  if (planned.module === "deals") result.closed = planned.plan.closed.length;
  const { sections, box } = moduleSections(planned, draft.asLeads);
  const entity = mapped.newFields[0]?.entity === "deal" ? "deals" : "contacts";
  const records = draft.module === "people" ? "the people" : `the ${draft.module}`;
  const all: (Html | "")[] = [
    mapped.newFields.length === 0
      ? ""
      : section(
          "import-fields",
          "New fields",
          html`<p class="section-note">Added as text fields on ${entity}, in the same change as ${records}.</p>
<ul class="panel rows">${mapped.newFields.map((def) => html`<li>${def.label} <span class="import-key">(key ${def.key})</span></li>`)}</ul>`,
        ),
    plan.skipped.length === 0
      ? ""
      : section(
          "import-skipped",
          "Lines skipped",
          html`<ul class="panel rows">${plan.skipped.slice(0, SHOWN).map((row) => html`<li>Line ${formatNumber(row.line)}: ${row.reason}.</li>`)}${moreLine(plan.skipped.length)}</ul>`,
        ),
    ...sections,
  ];
  const canApply = plan.create.length + plan.merge.length > 0 || box !== "";
  const own = canApply ? ownListBox(planned) : "";
  const apply = canApply
    ? postForm(
        "import-apply",
        applyAction(draft.id),
        { csrf: ctx.csrf, here: previewPath(draft.id) },
        html`${hidden(VERSION_FIELD, String(draft.version))}
${box}
${own}
<div class="form-actions">
<button class="button" type="submit">Import</button>
<a class="form-cancel" href="${draftPath(draft.id)}">Back to matching</a>
</div>`,
      )
    : html`<p class="refusal">Nothing in this file would change ${text.yours}.</p>
<p class="form-actions"><a class="button button-quiet" href="${draftPath(draft.id)}">Back to matching</a><a class="form-cancel" href="${startPath(draft.module, draft.asLeads)}">Start again</a></p>`;
  return frame(
    html`<p class="lede">Nothing is saved until you tap Import. The import is one change, so one Undo takes it all back.</p>
${section("import-counts", "What will happen", html`<div class="card import-counts">${countsList(draft.module, result, draft.asLeads, false)}</div>`)}
${all.filter((part) => part !== "")}
${apply}`,
    false,
  );
}
