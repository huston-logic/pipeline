// log_activity. Owner and AI entries never carry untrusted_text: that column is only for text from outside. Reaching a
// New lead makes them Contacted in the same change (decision 0022).
import type { ActivityRow, ActivityType, ContactRow, DealRow } from "../db/db.ts";
import { newId } from "../ids.ts";
import { parseWhen } from "../time.ts";
import { type ChangeResult, commitChange, type Ctx, type RowChange, updatedRow } from "./change.ts";
import { short, withArticle } from "./describe.ts";
import { UserError } from "./errors.ts";
import { clean } from "./input.ts";
import { contactName, dealLabel, projectLabel } from "./labels.ts";
import { contactedIfNew, TEXT_DATA } from "./lead-change.ts";
import { findSubject, openDealsOf, ownerTimezone, type Source } from "./lookup.ts";
import { projectSubject } from "./project-links.ts";
import { statusLabels } from "./status-labels.ts";

/** The activity types that count as contact: they move the deal's last_activity_at. */
export const CONTACT_TYPES = ["form", "email", "call", "meeting", "note"] as const satisfies readonly ActivityType[];

export interface ActivityInput {
  /** Deal id, title or contact name. */
  dealId?: string;
  /** Contact id or name. */
  contactId?: string;
  /** Project id or exact name: the note is the project's and its person's, with no deal. */
  project?: string;
  type: ActivityType;
  summary: string;
  /** When it happened; defaults to now. */
  occurredAt?: string;
  /** Board only (its Text button): the note was a text, so it counts as reaching the person. Never an MCP input. */
  via?: "text";
}

const isContactType = (type: string): type is (typeof CONTACT_TYPES)[number] =>
  (CONTACT_TYPES as readonly string[]).includes(type);

/**
 * What a contact activity moves besides itself: the last_activity_at of its deal, or with only a contact of each of
 * their open deals (decision 0009, addendum 2), and a New lead's move to Contacted. The email log (src/email/log.ts)
 * uses this too, so a logged email resets the quiet clock exactly as log_activity does.
 */
export async function activityEffects(
  src: Source,
  activity: ActivityRow,
  deal: DealRow | null,
  contact: ContactRow,
  now: Date,
): Promise<{ changes: RowChange[]; contacted: ContactRow | null }> {
  const changes: RowChange[] = [];
  // A project's note is delivery work: it never resets a sale's quiet clock (decision 0055).
  const touched = deal ? [deal] : activity.project_id ? [] : await openDealsOf(src, contact.id);
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
  const tz = await ownerTimezone(ctx);
  const occurred = input.occurredAt === undefined ? ctx.now : parseWhen(input.occurredAt, tz);
  if (occurred.getTime() > ctx.now.getTime()) {
    throw new UserError("An activity can't be in the future. Log it once it happens, or use add_task to plan it.");
  }
  const { deal, contact, project } =
    input.project === undefined
      ? { ...(await findSubject(ctx, input)), project: null }
      : { deal: null, ...(await projectSubject(ctx, input.project, input)) };
  const occurredAt = occurred.toISOString();

  const activity: ActivityRow = {
    id: newId("ac"),
    deal_id: deal?.id ?? null,
    contact_id: contact.id,
    project_id: project?.id ?? null,
    type: input.type,
    summary: text,
    untrusted_text: null,
    data,
    occurred_at: occurredAt,
    actor: ctx.actor,
    version: 1,
    created_at: ctx.now.toISOString(),
  };
  const effects = await activityEffects(ctx, activity, deal, contact, ctx.now);
  const changes: RowChange[] = [{ table: "activities", id: activity.id, before: null, after: activity }, ...effects.changes];
  const { contacted } = effects;

  const where = project ? `on ${projectLabel(project, contact)}` : deal ? `on ${dealLabel(deal, contact)}` : `with ${contactName(contact)}`;
  const summary =
    `Logged ${withArticle(input.type)} ${where}: ${short(text)}` +
    (contacted === null ? "" : `; ${contactName(contact)} is now ${(await statusLabels(ctx)).lead("contacted")}`);
  const result = await commitChange(ctx, { target: { table: "activities", id: activity.id }, summary, changes });
  return { ...result, activityId: activity.id };
}
