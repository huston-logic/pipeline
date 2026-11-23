// The one place a person's status columns are worked out (decision 0040). A person has a person status and a
// sub-status; the lead engine (rules, reports, list_leads, the brief) still reads lead_status and lead_status_at. Every
// write that moves or creates a person takes its columns from here, so the two pairs can never drift apart:
// person_status is "lead" exactly when lead_status is an unqualified status, and then sub_status equals lead_status.
// Pure and import-light, so lead-change.ts and person-status.ts can both use it.
import type { ContactRow, PersonStatusRow, PersonSubstatusRow } from "../db/db.ts";
import { isUnqualified, type LeadStatus } from "./lead-status.ts";

/** The seeded statuses and sub-status the code itself relies on. Their keys never change; their labels may. */
export const LEAD = "lead";
export const CONTACT = "contact";
export const CLIENT = "client";

/** Where a person moves to: a status key and one of its sub-status keys (null for none). */
export interface PersonMove {
  status: string;
  sub: string | null;
}

type PersonColumns = Pick<ContactRow, "person_status" | "sub_status" | "lead_status">;

/** A lead by either pair of columns, so a row the two disagree on is still moved out of Lead properly. */
const isLead = (contact: Pick<ContactRow, "person_status" | "lead_status">) =>
  contact.person_status === LEAD || isUnqualified(contact.lead_status);

/**
 * The contact patch for a move: person_status and sub_status, plus lead_status and lead_status_at when the lead
 * engine's pair changes. To Lead with sub-status X sets lead_status X; from Lead to any other status sets Qualified
 * (the history that they were qualified); a move between two other statuses leaves lead_status alone. lead_status_at
 * is set to `now` whenever lead_status changes.
 */
export function personStatusPatch(contact: PersonColumns, to: PersonMove, now: Date): Partial<ContactRow> {
  const patch: Partial<ContactRow> = { person_status: to.status, sub_status: to.sub };
  let lead: LeadStatus | null = contact.lead_status;
  if (to.status === LEAD) {
    if (!isUnqualified(to.sub)) throw new Error(`A lead's sub-status must be a lead status key, not ${String(to.sub)}.`);
    lead = to.sub as LeadStatus;
  } else if (isLead(contact)) {
    lead = "qualified";
  }
  if (lead !== contact.lead_status) {
    patch.lead_status = lead;
    patch.lead_status_at = now.toISOString();
  }
  return patch;
}

/** The four status columns of a person created now with this status: a lead's lead_status is its sub-status. */
export function newPersonColumns(
  to: PersonMove,
  now: Date,
): Pick<ContactRow, "person_status" | "sub_status" | "lead_status" | "lead_status_at"> {
  const fresh = { person_status: "", sub_status: null, lead_status: null, lead_status_at: null };
  return { ...fresh, ...personStatusPatch(fresh, to, now) } as Pick<
    ContactRow,
    "person_status" | "sub_status" | "lead_status" | "lead_status_at"
  >;
}

/** The move a lead status means (decision 0022's keys): an unqualified one is Lead with it, Qualified is a Contact. */
export function moveForLeadStatus(contact: Pick<ContactRow, "person_status" | "sub_status" | "lead_status">, status: LeadStatus): PersonMove {
  if (isUnqualified(status)) return { status: LEAD, sub: status };
  // Qualified: a lead becomes a Contact with no sub-status; anyone else keeps the status they have.
  return isLead(contact) ? { status: CONTACT, sub: null } : { status: contact.person_status, sub: contact.sub_status };
}

/** The two status columns a snapshot from before migration 0011 would have had: what the migration gives it. */
export function migratedPersonColumns(leadStatus: unknown): { person_status: string; sub_status: string | null } {
  return typeof leadStatus === "string" && isUnqualified(leadStatus)
    ? { person_status: LEAD, sub_status: leadStatus }
    : { person_status: CONTACT, sub_status: null };
}

/** A status with its sub-statuses, as the pure code (the import plan) needs them. */
export interface StatusEntry {
  key: string;
  label: string;
  archived: boolean;
  subs: { key: string; label: string; archived: boolean }[];
}

const sub = (key: string, label: string) => ({ key, label, archived: false });

/** The statuses migration 0011 seeds: what a caller that read none (a test, a pure plan) works with. */
export const SEEDED_STATUSES: readonly StatusEntry[] = [
  {
    key: LEAD,
    label: "Lead",
    archived: false,
    subs: [sub("new", "New"), sub("contacted", "Contacted"), sub("not_now", "Not now"), sub("not_a_fit", "Not a fit"), sub("bad", "Bad lead")],
  },
  { key: CONTACT, label: "Contact", archived: false, subs: [sub(CLIENT, "Client")] },
  { key: "partner", label: "Partner", archived: false, subs: [] },
];

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A live (not archived) entry by key or label, ignoring case and outer spaces; null when none matches. */
export function liveByRef<T extends { key: string; label: string; archived: boolean }>(list: readonly T[], text: string): T | null {
  const live = list.filter((entry) => !entry.archived);
  return live.find((entry) => same(entry.key, text)) ?? live.find((entry) => same(entry.label, text)) ?? null;
}

/** The rows as StatusEntry values, in position order; the seeded three when there are none (a copy not migrated). */
export function statusEntriesOf(statuses: readonly PersonStatusRow[], subs: readonly PersonSubstatusRow[]): readonly StatusEntry[] {
  if (statuses.length === 0) return SEEDED_STATUSES;
  const byPlace = <T extends { position: number }>(a: T, b: T) => a.position - b.position;
  return [...statuses].sort(byPlace).map((status) => ({
    key: status.key,
    label: status.label,
    archived: status.archived === 1,
    subs: subs
      .filter((row) => row.status_key === status.key)
      .sort(byPlace)
      .map((row) => ({ key: row.key, label: row.label, archived: row.archived === 1 })),
  }));
}
