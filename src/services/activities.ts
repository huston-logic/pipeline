// log_activity. Owner and AI entries never carry untrusted_text: that column is only for text from outside. Reaching a
// New lead makes them Contacted in the same change (decision 0022).
import type { ActivityRow, ActivityType, ContactRow, Db, DealRow } from "../db/db.ts";
import { newId } from "../ids.ts";
import { parseWhen } from "../time.ts";
import { type ChangeResult, commitChange, type Ctx, type RowChange, updatedRow } from "./change.ts";
import { short, withArticle } from "./describe.ts";
import { UserError } from "./errors.ts";
import { clean } from "./input.ts";
import { contactName, dealLabel } from "./labels.ts";
import { contactedIfNew, TEXT_DATA } from "./lead-change.ts";
import { LEAD_STATUS_LABELS } from "./lead-status.ts";
import { findSubject, ownerTimezone } from "./lookup.ts";

/** The activity types that count as contact: they move the deal's last_activity_at. */
export const CONTACT_TYPES = ["form", "email", "call", "meeting", "note"] as const satisfies readonly ActivityType[];

export interface ActivityInput {
  /** Deal id, title or contact name. */
  dealId?: string;
  /** Contact id or name. */
  contactId?: string;
  type: ActivityType;
  summary: string;
  /** When it happened; defaults to now. */
  occurredAt?: string;
  /** Board only (its Text button): the note was a text, so it counts as reaching the person. Never an MCP input. */
  via?: "text";
}

async function openDealsOf(db: Db, contactId: string): Promise<DealRow[]> {
  const found = await db
    .prepare("SELECT * FROM deals WHERE contact_id = ? AND status = 'open' AND archived = 0 ORDER BY created_at, id")
    .bind(contactId)
    .all<DealRow>();
  return found.results;
}

const isContactType = (type: string): type is (typeof CONTACT_TYPES)[number] =>
  (CONTACT_TYPES as readonly string[]).includes(type);

/**
 * What a contact activity moves besides itself: the last_activity_at of its deal, or with only a contact of each of
 * their open deals (decision 0009, addendum 2), and a New lead's move to Contacted. The email log (src/email/log.ts)
 * uses this too, so a logged email resets the quiet clock exactly as log_activity does.
 */
export async function activityEffects(
  db: Db,
  activity: ActivityRow,
  deal: DealRow | null,
  contact: ContactRow,
  now: Date,
): Promise<{ changes: RowChange[]; contacted: ContactRow | null }> {
  const changes: RowChange[] = [];
  const touched = deal ? [deal] : await openDealsOf(db, contact.id);
  for (const row of touched) {
    if (row.last_activity_at !== null && row.last_activity_at >= activity.occurred_at) continue;
    changes.push({
      table: "deals",
      id: row.id,
      before: row,
      after: updatedRow(row, { last_activity_at: activity.occurred_at }, now),
    });
  }
  // The contact row read by the caller is the `before`, so a write that bumped it since fails the whole change as stale.
  const contacted = contactedIfNew(contact, activity.type, activity.data, now);
  if (contacted !== null) changes.push({ table: "contacts", id: contact.id, before: contact, after: contacted });
  return { changes, contacted };
}

export async function logActivity(ctx: Ctx, input: ActivityInput): Promise<ChangeResult & { activityId: string }> {
  const { db } = ctx;
  if (input.type === "stage_change") {
    throw new UserError("Stage changes are recorded by update_deal. Move the deal with update_deal instead.");
  }
  if (!isContactType(input.type)) {
    throw new UserError(`"${input.type}" can't be logged here. Use one of: ${CONTACT_TYPES.join(", ")}.`);
  }
  if (input.via !== undefined && (input.via !== "text" || input.type !== "note")) {
    throw new UserError("Only a note can be marked as a text. Log a call, email or meeting without it.");
  }
  const data = input.via === "text" ? TEXT_DATA : null;
  const text = clean(input.summary);
  if (text === null) throw new UserError("An activity needs a summary. Say in a few words what happened.");
  const tz = await ownerTimezone(db);
  const occurred = input.occurredAt === undefined ? ctx.now : parseWhen(input.occurredAt, tz);
  if (occurred.getTime() > ctx.now.getTime()) {
    throw new UserError("An activity can't be in the future. Log it once it happens, or use add_task to plan it.");
  }
  const { deal, contact } = await findSubject(db, input);
  const occurredAt = occurred.toISOString();

  const activity: ActivityRow = {
    id: newId("ac"),
    deal_id: deal?.id ?? null,
    contact_id: contact.id,
    type: input.type,
    summary: text,
    untrusted_text: null,
    data,
    occurred_at: occurredAt,
    actor: ctx.actor,
    version: 1,
    created_at: ctx.now.toISOString(),
  };
  const effects = await activityEffects(db, activity, deal, contact, ctx.now);
  const changes: RowChange[] = [{ table: "activities", id: activity.id, before: null, after: activity }, ...effects.changes];
  const { contacted } = effects;

  const where = deal ? `on ${dealLabel(deal, contact)}` : `with ${contactName(contact)}`;
  const summary =
    `Logged ${withArticle(input.type)} ${where}: ${short(text)}` +
    (contacted === null ? "" : `; ${contactName(contact)} is now ${LEAD_STATUS_LABELS.contacted}`);
  const result = await commitChange(ctx, { target: { table: "activities", id: activity.id }, summary, changes });
  return { ...result, activityId: activity.id };
}
