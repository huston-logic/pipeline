// The board's lead forms (decisions 0022, 0028): where Add a lead and Add a deal go back to, a lead's status line and
// status menu, the Qualify form's fields, and Back to leads on a deal. Plain forms that work without JavaScript.
import type { Db, DealStatus, StageRow } from "../db/db.ts";
import { openDealCount } from "../services/lead-change.ts";
import { UNQUALIFIED_STATUSES } from "../services/lead-status.ts";
import type { LeadStatus } from "../services/lead-status.ts";
import type { StatusLabels } from "../services/status-labels.ts";
import { formatLocal } from "../time.ts";
import { fingerprint } from "./edit-state.ts";
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
  "/pipeline": "Back to deals",
  "/contacts": "Back to contacts",
  "/leads": "Back to leads",
};

/** Where Cancel goes: the page the button was on (?from=), else `fallback`. */
export const addCancel = (from: string | null, fallback: string): string =>
  from !== null && Object.hasOwn(FROM, from) ? (FROM[from] ?? fallback) : fallback;

/** A posted return_to, kept only when it is one of those pages. */
export const addReturn = (path: string | null, fallback: string): string => (path !== null && Object.hasOwn(BACK, path) ? path : fallback);

export const backText = (path: string): string => BACK[path] ?? "Back to deals";

/** The five statuses that are not Qualified, by the owner's current labels (decision 0041). */
export const statusOptions = (labels: StatusLabels): { value: string; label: string }[] =>
  UNQUALIFIED_STATUSES.map((status) => ({ value: status, label: labels.lead(status) }));

/** "Lead status: Not now, since Thu Nov 19", the day in the owner's timezone. */
export function statusLine(status: LeadStatus, at: string | null, tz: string, labels: StatusLabels): Html {
  const since = at === null ? "" : html`, since ${when(at, formatLocal(at, tz).split(",")[0] ?? "")}`;
  return html`<p class="lead-status-line">Lead status: ${labels.lead(status)}${since}</p>`;
}

export const statusAction = (contactId: string): string => `${contactHref(contactId)}/lead-status`;

export const statusSpecs = (labels: StatusLabels): Spec[] => [
  line("lead_status", "Change lead status", "choice", "contact", { prop: "leadStatus", options: statusOptions(labels) }),
  line("follow_up", "Check back on (optional)", "date", "contact", {
    prop: "followUpDate",
    hint: "Only for Not now. Adds a task to check back that day.",
  }),
];

/** The fingerprint of the status a menu was drawn with (`was.lead_status`, the 0018 pattern). */
export const statusFingerprint = (status: string): Promise<string> => fingerprint(status, "line");

/**
 * The status menu: one of the five statuses that are not Qualified, an optional check-back date, and Save status. The
 * select carries the fingerprint of the status it was drawn with, so a post from a stale page sends the status only
 * when the owner changed the select (lead-actions.ts).
 */
export async function statusMenu(
  contactId: string,
  current: LeadStatus,
  form: FormContext,
  labels: StatusLabels,
  state?: FormState,
): Promise<Html> {
  const prefix = `status-${contactId}`;
  const specs = statusSpecs(labels);
  const shown = state?.shown ?? new Map([["lead_status", { value: current, was: await statusFingerprint(current), outside: false }]]);
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

/**
 * Back to leads is offered on an open, Lost or Not now deal that is not archived, whose person has no other open deal
 * (return_to_lead would refuse that after the confirm step).
 */
export async function offersBackToLeads(db: Db, deal: { id: string; contactId: string; status: DealStatus; archived: boolean }): Promise<boolean> {
  if (deal.archived || deal.status === "won") return false;
  const others = (await openDealCount(db, deal.contactId)) - (deal.status === "open" ? 1 : 0);
  return others <= 0;
}

/** Back to leads on a deal page: posting it without confirm=yes asks first. */
export const backToLeadsForm = (dealId: string, form: FormContext): Html =>
  postForm("return-form", returnAction(dealId), form, html`<button class="button button-quiet button-small" type="submit">Back to leads</button>`);
