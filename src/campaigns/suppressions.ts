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

export interface BlockSpec {
  reason: EmailSuppressionRow["reason"];
  tool: string;
  summary: string;
  /** The recipient-row update that goes with the block; it runs in the same change, or alone if the address is already blocked. */
  mark: D1PreparedStatement;
}

/**
 * Blocks the recipient's address with a live suppression and runs `mark`, in one system change. An address that is
 * already blocked gets no second row; an unsubscribe is upgraded to the bounce or complaint (clearing only lifts unsubscribes), any other live block stays, and only `mark` runs, unaudited.
 */
export async function blockAddress(db: Ctx["db"], now: Date, recipient: CampaignRecipientRow, spec: BlockSpec): Promise<void> {
  const email = recipient.email.trim().toLowerCase();
  const live = () => db.prepare("SELECT * FROM email_suppressions WHERE email = ? AND cleared_at IS NULL").bind(email).first<EmailSuppressionRow>();
  const ctx: Ctx = { db, now, actor: "system", tool: spec.tool };
  // A second pass covers two blocks at once: the other one's row now stands, and may itself need the upgrade.
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await live();
    try {
      if (current === null) {
        const row: EmailSuppressionRow = {
          id: newId("su"),
          email,
          reason: spec.reason,
          contact_id: recipient.contact_id,
          campaign_id: recipient.campaign_id,
          created_at: now.toISOString(),
          cleared_at: null,
          version: 1,
        };
        await commitChange(ctx, {
          target: { table: "email_suppressions", id: row.id },
          summary: spec.summary,
          changes: [{ table: "email_suppressions", id: row.id, before: null, after: row }],
          extra: [spec.mark],
        });
        return;
      }
      if (current.reason === "unsubscribed" && spec.reason !== "unsubscribed") {
        await commitChange(ctx, {
          target: { table: "email_suppressions", id: current.id },
          summary: spec.summary,
          changes: [{ table: "email_suppressions", id: current.id, before: current, after: updatedRow(current, { reason: spec.reason }, now) }],
          extra: [spec.mark],
        });
        return;
      }
      break;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
  await spec.mark.run();
}

/**
 * Records a recipient's unsubscribe from their own link: a live `unsubscribed` block on the address and the row's
 * `unsubscribed_at`, in one system change. An address that is already blocked (any reason) gets no second block; only
 * `unsubscribed_at` is set. A repeat writes nothing. Works with campaigns off: an unsubscribe is never refused.
 */
export const suppress = (db: Ctx["db"], now: Date, recipient: CampaignRecipientRow): Promise<void> =>
  blockAddress(db, now, recipient, {
    reason: "unsubscribed",
    tool: "unsubscribe",
    summary: `Unsubscribed contact ${recipient.contact_id} from campaign emails`,
    mark: markUnsubscribed(db, recipient.id, now),
  });

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
