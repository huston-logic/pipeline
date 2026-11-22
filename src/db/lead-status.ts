// Lead statuses (decision 0022). The keys are stored and never change; the labels live here so they can become a
// setting later. Import-free so the board, the services and the scripts can all use it.

export const LEAD_STATUSES = ["new", "contacted", "not_now", "not_a_fit", "bad", "qualified"] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Every status but qualified: a person with one of these is a lead who has no deal. */
export const UNQUALIFIED_STATUSES: readonly LeadStatus[] = ["new", "contacted", "not_now", "not_a_fit", "bad"];

/** The statuses the leads views and list_leads show by default. */
export const OPEN_LEAD_STATUSES: readonly LeadStatus[] = ["new", "contacted", "not_now"];

export const CLOSED_OUT_STATUSES: readonly LeadStatus[] = ["not_a_fit", "bad"];

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  not_now: "Not now",
  not_a_fit: "Not a fit",
  bad: "Bad lead",
  qualified: "Qualified",
};

export function isLeadStatus(value: unknown): value is LeadStatus {
  return typeof value === "string" && (LEAD_STATUSES as readonly string[]).includes(value);
}

export function isUnqualified(status: string | null): boolean {
  return status !== null && (UNQUALIFIED_STATUSES as readonly string[]).includes(status);
}

/** Reads outside or typed text: an exact key or an exact label (after trimming), nothing else. */
export function leadStatusFromText(value: string): LeadStatus | null {
  const text = value.trim();
  if (isLeadStatus(text)) return text;
  return LEAD_STATUSES.find((status) => LEAD_STATUS_LABELS[status] === text) ?? null;
}
