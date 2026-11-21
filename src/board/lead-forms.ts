// The board's lead forms (decisions 0022, 0028): where Add a lead and Add a deal go back to, a lead's status line and
// status menu, the Qualify form's fields, and Back to leads on a deal. Plain forms that work without JavaScript.
import type { StageRow } from "../db/db.ts";
import { LEAD_STATUS_LABELS, UNQUALIFIED_STATUSES } from "../services/lead-status.ts";
import type { LeadStatus } from "../services/lead-status.ts";
import { formatLocal } from "../time.ts";
import { type FormContext, postForm } from "./forms.ts";
import { type Html, html } from "./html.ts";
import type { FormState } from "./pages/record-page.ts";
import { contactHref, dealHref, when } from "./parts.ts";
import { dealSpecs, line, type Spec } from "./record-form.ts";
import { formErrorSummary, specFields } from "./record-fields.ts";

/** The pages the Add a lead and Add a deal buttons sit on, by their ?from= value. */
const FROM: Record<string, string> = { today: "/", pipeline: "/pipeline", contacts: "/contacts", leads: "/leads" };
const BACK: Record<string, string> = {
  "/": "Back to today",
  "/pipeline": "Back to the pipeline",
  "/contacts": "Back to contacts",
  "/leads": "Back to leads",
};

/** Where Cancel goes: the page the button was on (?from=), else `fallback`. */
export const addCancel = (from: string | null, fallback: string): string =>
  from !== null && Object.hasOwn(FROM, from) ? (FROM[from] ?? fallback) : fallback;

/** A posted return_to, kept only when it is one of those pages. */
export const addReturn = (path: string | null, fallback: string): string => (path !== null && Object.hasOwn(BACK, path) ? path : fallback);

export const backText = (path: string): string => BACK[path] ?? "Back to the pipeline";

export const STATUS_OPTIONS = UNQUALIFIED_STATUSES.map((status) => ({ value: status, label: LEAD_STATUS_LABELS[status] }));

/** "Lead status: Not now, since Thu Nov 19", the day in the owner's timezone. */
export function statusLine(status: LeadStatus, at: string | null, tz: string): Html {
  const since = at === null ? "" : html`, since ${when(at, formatLocal(at, tz).split(",")[0] ?? "")}`;
  return html`<p class="lead-status-line">Lead status: ${LEAD_STATUS_LABELS[status]}${since}</p>`;
}

export const statusAction = (contactId: string): string => `${contactHref(contactId)}/lead-status`;

export const statusSpecs = (): Spec[] => [
  line("lead_status", "Change lead status", "choice", "contact", { prop: "leadStatus", options: STATUS_OPTIONS }),
  line("follow_up", "Check back on (optional)", "date", "contact", {
    prop: "followUpDate",
    hint: "Only for Not now. Adds a task to check back that day.",
  }),
];

/** The status menu: one of the five statuses that are not Qualified, an optional check-back date, and Save status. */
export function statusMenu(contactId: string, current: LeadStatus, form: FormContext, state?: FormState): Html {
  const prefix = `status-${contactId}`;
  const specs = statusSpecs();
  const shown = state?.shown ?? new Map([["lead_status", { value: current, outside: false }]]);
  const inner = postForm(
    "lead-status-form",
    statusAction(contactId),
    form,
    html`${specFields(specs, shown, prefix)}
<button class="button button-small" type="submit">Save status</button>`,
    { novalidate: true },
  );
  if (state === undefined) return inner;
  return html`${formErrorSummary(state.errors, specs, prefix)}<div class="card refused-form">${inner}</div>`;
}

export const qualifyPath = (contactId: string): string => `${contactHref(contactId)}/qualify`;

/** The Qualify form's deal fields: an open stage (the first by default), title, value, next step and next date. */
export function qualifySpecs(stages: StageRow[]): Spec[] {
  const open = stages.filter((stage) => stage.kind === "open").map((stage) => ({ value: stage.key, label: stage.label }));
  return [
    line("stage", "Stage", "choice", "deal", { options: open }),
    ...dealSpecs([], { titleRequired: false, notes: false, titleProp: "dealTitle" }),
  ];
}

export const returnAction = (dealId: string): string => `${dealHref(dealId)}/return-to-lead`;

/** Back to leads on a deal page: posting it without confirm=yes asks first. */
export const backToLeadsForm = (dealId: string, form: FormContext): Html =>
  postForm("return-form", returnAction(dealId), form, html`<button class="button button-quiet button-small" type="submit">Back to leads</button>`);
