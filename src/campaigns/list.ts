// The campaigns the board lists: every live (not archived) campaign with its step 1 subject, newest first.
import type { CampaignRow, Db } from "../db/db.ts";

export type CampaignListItem = Pick<CampaignRow, "id" | "name" | "status" | "send_after" | "approved_at" | "completed_at"> & { subject: string };

export async function listCampaignItems(db: Db): Promise<CampaignListItem[]> {
  const found = await db
    .prepare(
      `SELECT c.id, c.name, c.status, c.send_after, c.approved_at, c.completed_at, s.subject
       FROM campaigns c JOIN campaign_steps s ON s.campaign_id = c.id AND s.position = 1
       WHERE c.archived = 0 ORDER BY c.created_at DESC, c.id`,
    )
    .all<CampaignListItem>();
  return found.results;
}
