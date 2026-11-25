// The owner lifting a campaign block (decision 0053). Only an unsubscribe can be lifted, and only from the person's page:
// a bounce or a spam complaint stays for good. No MCP tool reaches this file (layering.test.ts).
import type { ContactRow, EmailSuppressionRow } from "../db/db.ts";
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

/** Allows campaign emails to this person again: every live unsubscribe that applies to them is cleared, in one change. */
export async function clearSuppression(ctx: Ctx, contactId: string): Promise<ChangeResult> {
  await requireCampaigns(ctx);
  const contact = await ctx.db.prepare("SELECT * FROM contacts WHERE id = ?").bind(contactId).first<ContactRow>();
  if (contact === null) throw new UserError(`There's no contact ${contactId}. Use list_contacts to find the person.`);
  const unsubscribes = await liveUnsubscribes(ctx.db, contact);
  if (unsubscribes.length === 0) throw new UserError(`${contactName(contact)} has no unsubscribe to clear.`);
  const rows = await ctx.db
    .prepare("SELECT * FROM email_suppressions WHERE id IN (SELECT value FROM json_each(?)) AND cleared_at IS NULL")
    .bind(JSON.stringify(unsubscribes.map((row) => row.id)))
    .all<EmailSuppressionRow>();
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
