// The activity a sent campaign email leaves on a person (design, "Activities on each person"). It is an email with
// `via: "campaign"`, which never counts as reaching them (isReach and the two SQL forms skip it), and it has no deal, so
// the sender does not run activityEffects and no deal's last_activity_at moves. Pure: the sender inserts the row.
import type { ActivityRow } from "../db/db.ts";
import { newId } from "../ids.ts";

const SUMMARY_MAX = 200;
const PREFIX = "Campaign: ";

/** The `data` of a campaign activity. */
export const campaignData = (campaignId: string): string => JSON.stringify({ via: "campaign", campaign: campaignId });

export function campaignActivity(contactId: string, campaign: { id: string; name: string }, at: Date): ActivityRow {
  const stamp = at.toISOString();
  return {
    id: newId("ac"),
    deal_id: null,
    contact_id: contactId,
    type: "email",
    summary: `${PREFIX}${campaign.name}`.slice(0, SUMMARY_MAX),
    untrusted_text: null,
    data: campaignData(campaign.id),
    occurred_at: stamp,
    actor: "system",
    version: 1,
    created_at: stamp,
  };
}
