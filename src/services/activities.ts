// log_activity. Owner and AI entries never carry untrusted_text: that column is only for text from outside.
import type { ActivityRow, ActivityType } from "../db/db.ts";
import { newId } from "../ids.ts";
import { parseWhen } from "../time.ts";
import { type ChangeResult, commitChange, type Ctx, type RowChange, updatedRow } from "./change.ts";
import { short, withArticle } from "./describe.ts";
import { UserError } from "./errors.ts";
import { clean } from "./input.ts";
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
}

const isContactType = (type: string): type is (typeof CONTACT_TYPES)[number] =>
  (CONTACT_TYPES as readonly string[]).includes(type);

export async function logActivity(ctx: Ctx, input: ActivityInput): Promise<ChangeResult & { activityId: string }> {
  const { db } = ctx;
  if (input.type === "stage_change") {
    throw new UserError("Stage changes are recorded by update_deal. Move the deal with update_deal instead.");
  }
  if (!isContactType(input.type)) {
    throw new UserError(`"${input.type}" can't be logged here. Use one of: ${CONTACT_TYPES.join(", ")}.`);
  }
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
    data: null,
    occurred_at: occurredAt,
    actor: ctx.actor,
    version: 1,
    created_at: ctx.now.toISOString(),
  };
  const changes: RowChange[] = [{ table: "activities", id: activity.id, before: null, after: activity }];
  if (deal && (deal.last_activity_at === null || deal.last_activity_at < occurredAt)) {
    changes.push({
      table: "deals",
      id: deal.id,
      before: deal,
      after: updatedRow(deal, { last_activity_at: occurredAt }, ctx.now),
    });
  }

  const where = deal ? `on "${deal.title}" (${contact.name})` : `with ${contact.name}`;
  const summary = `Logged ${withArticle(input.type)} ${where}: ${short(text)}`;
  const result = await commitChange(ctx, { target: { table: "activities", id: activity.id }, summary, changes });
  return { ...result, activityId: activity.id };
}
