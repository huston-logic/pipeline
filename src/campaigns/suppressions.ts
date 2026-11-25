// A recipient's unsubscribe, and the owner lifting a campaign block (decision 0053). Only an unsubscribe can be lifted, and only from the person's page:
// a bounce or a spam complaint stays for good. No MCP tool reaches this file (layering.test.ts).
import type { CampaignRecipientRow, ContactRow, EmailSuppressionRow } from "../db/db.ts";
import { newId } from "../ids.ts";
import { type ChangeResult, commitChange, type Ctx, type RowChange, updatedRow } from "../services/change.ts";
import { UserError } from "../services/errors.ts";
import { contactName } from "../services/labels.ts";
import { requireCampaigns } from "../services/settings.ts";
import { liveSuppressions, type LiveSuppression } from "./audience.ts";

/** The person's address as campaigns match it: trimmed and lowercased, or null. */
export const campaignEmailOf = (contact: Pick<ContactRow, "email">): string | null => {
  const email = contact.email?.trim().toLowerCase() ?? "";
  return email === "" ? null : email;
};

/** Every live unsubscribe that applies to this person, by their address or by them. */
export async function liveUnsubscribes(db: Ctx["db"], contact: Pick<ContactRow, "id" | "email">): Promise<LiveSuppression[]> {
  const rows = await liveSuppressions(db, [{ email: campaignEmailOf(contact), contactId: contact.id }]);
  return rows.filter((row) => row.reason === "unsubscribed");
}

const markUnsubscribed = (db: Ctx["db"], recipientId: string, now: Date): D1PreparedStatement =>
  db
    .prepare("UPDATE campaign_recipients SET unsubscribed_at = ?, version = version + 1 WHERE id = ? AND unsubscribed_at IS NULL")
    .bind(now.toISOString(), recipientId);

/**
 * Records a recipient's unsubscribe from their own link: a live `unsubscribed` block on the address and the row's
 * `unsubscribed_at`, in one system change. An address that is already blocked (any reason) gets no second block; only
 * `unsubscribed_at` is set. A repeat writes nothing. Works with campaigns off: an unsubscribe is never refused.
 */
export async function suppress(db: Ctx["db"], now: Date, recipient: CampaignRecipientRow): Promise<void> {
  const email = recipient.email.trim().toLowerCase();
  const live = () => db.prepare("SELECT id FROM email_suppressions WHERE email = ? AND cleared_at IS NULL").bind(email).first<{ id: string }>();
  if ((await live()) === null) {
    const stamp = now.toISOString();
    const row: EmailSuppressionRow = {
      id: newId("su"),
      email,
      reason: "unsubscribed",
      contact_id: recipient.contact_id,
      campaign_id: recipient.campaign_id,
      created_at: stamp,
      cleared_at: null,
      version: 1,
    };
    const ctx: Ctx = { db, now, actor: "system", tool: "unsubscribe" };
    try {
      await commitChange(ctx, {
        target: { table: "email_suppressions", id: row.id },
        summary: `Unsubscribed contact ${recipient.contact_id} from campaign emails`,
        changes: [{ table: "email_suppressions", id: row.id, before: null, after: row }],
        extra: [markUnsubscribed(db, recipient.id, now)],
      });
      return;
    } catch (error) {
      // Two unsubscribes at once: the other one's block now stands, so fall through to the already-blocked path.
      if ((await live()) === null) throw error;
    }
  }
  await markUnsubscribed(db, recipient.id, now).run();
}

/** Allows campaign emails to this person again: every live unsubscribe that applies to them is cleared, in one change. */
export async function clearSuppression(ctx: Ctx, contactId: string): Promise<ChangeResult> {
  await requireCampaigns(ctx);
  const contact = await ctx.db.prepare("SELECT * FROM contacts WHERE id = ?").bind(contactId).first<ContactRow>();
  if (contact === null) throw new UserError(`There's no person ${contactId}.`);
  const unsubscribes = await liveUnsubscribes(ctx.db, contact);
  if (unsubscribes.length === 0) throw new UserError(`${contactName(contact)} has no unsubscribe to clear.`);
  const rows = await ctx.db
    .prepare("SELECT * FROM email_suppressions WHERE id IN (SELECT value FROM json_each(?)) AND cleared_at IS NULL")
    .bind(JSON.stringify(unsubscribes.map((row) => row.id)))
    .all<EmailSuppressionRow>();
  if (rows.results.length === 0) throw new UserError(`${contactName(contact)} has no unsubscribe to clear.`);
  const changes: RowChange[] = rows.results.map((row) => ({
    table: "email_suppressions",
    id: row.id,
    before: row,
    after: updatedRow(row, { cleared_at: ctx.now.toISOString() }, ctx.now),
  }));
  return commitChange(ctx, {
    target: { table: "email_suppressions", id: unsubscribes[0]?.id ?? "" },
    summary: `Allowed campaign emails again for contact ${contact.id}`,
    changes,
  });
}
