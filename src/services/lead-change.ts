// The pieces every lead write shares (decision 0022): setting a status, qualifying a lead that gets a deal, the
// "Check back" task, what counts as reaching someone, and the New to Contacted move. Each returns rows for the caller's
// one change, so the status always moves in the same change as the write that caused it.
import type { ActivityType, ContactRow, Db, TaskRow } from "../db/db.ts";
import { newId } from "../ids.ts";
import { type RowChange, updatedRow } from "./change.ts";
import { isTrusted } from "./labels.ts";
import { isUnqualified, type LeadStatus } from "./lead-status.ts";

/** The company a contact's `business` names: trimmed, inner spaces collapsed, ignoring case; "" for none. */
export const businessKey = (business: string | null): string => (business ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/** The contact with a new lead status, stamped now, ready to be a RowChange's `after`. */
export function withLeadStatus(contact: ContactRow, status: LeadStatus, now: Date): ContactRow {
  return updatedRow(contact, { lead_status: status, lead_status_at: now.toISOString() }, now);
}

/** Qualified, when the contact is an unqualified lead: what a write that gives them a deal adds to its change. */
export function qualifyIfLead(contact: ContactRow, now: Date): RowChange | null {
  if (!isUnqualified(contact.lead_status)) return null;
  return { table: "contacts", id: contact.id, before: contact, after: withLeadStatus(contact, "qualified", now) };
}

/** "Check back with {contact}", on the contact alone. A name from outside makes the title outside text too. */
export function followUpTask(contact: ContactRow, due: Date, now: Date): TaskRow {
  const stamp = now.toISOString();
  return {
    id: newId("tk"),
    deal_id: null,
    contact_id: contact.id,
    title: `Check back with ${contact.name}`,
    due_at: due.toISOString(),
    done_at: null,
    snoozed_until: null,
    source: "owner",
    untrusted_fields: isTrusted(contact, "name") ? "[]" : '["title"]',
    version: 1,
    created_at: stamp,
    updated_at: stamp,
  };
}

const REACH_TYPES: readonly ActivityType[] = ["form", "email", "call", "meeting"];

/** An activity data value marked as a text, as the board's Text button logs it. */
export const TEXT_DATA = JSON.stringify({ via: "text" });

function isText(data: string | null): boolean {
  if (data === null) return false;
  try {
    const value: unknown = JSON.parse(data);
    return typeof value === "object" && value !== null && (value as { via?: unknown }).via === "text";
  } catch {
    return false;
  }
}

/** Whether the activity reached the person: a form, email, call or meeting, or a note that was a text. */
export function isReach(type: ActivityType, data: string | null): boolean {
  return REACH_TYPES.includes(type) || (type === "note" && isText(data));
}

/** The auto-advance: a New lead reached by this activity becomes Contacted. Null when nothing moves. */
export function contactedIfNew(contact: ContactRow, type: ActivityType, data: string | null, now: Date): ContactRow | null {
  if (contact.lead_status !== "new" || !isReach(type, data)) return null;
  return withLeadStatus(contact, "contacted", now);
}

/** A write_guard statement that fails the batch unless the person has no open, unarchived deal (invariant 1). */
export function noOpenDeal(db: Db, contactId: string): D1PreparedStatement {
  return db
    .prepare("INSERT INTO write_guard (ok) SELECT COUNT(*) = 0 FROM deals WHERE contact_id = ? AND status = 'open' AND archived = 0")
    .bind(contactId);
}

export async function openDealCount(db: Db, contactId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM deals WHERE contact_id = ? AND status = 'open' AND archived = 0")
    .bind(contactId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
