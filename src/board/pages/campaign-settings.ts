// /campaigns/settings (decision 0053): the postal address printed in every campaign email and the daily sending limit.
// A record form (decision 0018): only the fields the owner changes are saved (update_settings). 404 while campaigns are off.
import type { SettingsRow } from "../../db/db.ts";
import { getSettings } from "../../db/queries.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import type { PageContext } from "../context.ts";
import { editShown, line, type Spec } from "../record-form.ts";
import { type FormState, recordFormPage } from "./record-page.ts";
import { CAMPAIGNS_PATH, CAMPAIGN_SETTINGS_PATH } from "./campaigns.ts";

export const CAMPAIGN_SETTINGS_PREFIX = "campaign-settings";

/** The Postal address's own limit is the service's; the form only keeps a runaway paste out. */
export const campaignSettingsSpecs: Spec[] = [
  line("postal_address", "Postal address", "textarea", "contact", {
    column: "postal_address",
    prop: "postalAddress",
    hint: "Shown at the bottom of every campaign email.",
  }),
  line("daily_limit", "Daily limit", "number", "contact", {
    column: "campaign_daily_limit",
    prop: "campaignDailyLimit",
    hint: "The most campaign emails sent in one day. Resend's free plan allows 100 a day in all.",
  }),
];

/** The settings row as the record form reads a stored row. */
export const settingsFormRow = (row: SettingsRow) => ({ ...row, fields: "{}", untrusted_fields: "[]" });

export async function campaignSettingsPage(ctx: PageContext, state?: FormState): Promise<string | null> {
  const settings = await getSettings(ctx.db);
  if (settings.campaigns !== 1) return null;
  const shown = state?.shown ?? (await editShown(campaignSettingsSpecs, settingsFormRow(settings), await ownerTimezone(ctx.db)));
  return recordFormPage(ctx, {
    title: "Campaign settings",
    description: "The postal address shown in every campaign email, and how many campaign emails go out a day at most.",
    heading: "Campaign settings",
    lede: "Set once, used by every campaign.",
    current: CAMPAIGN_SETTINGS_PATH,
    back: { href: CAMPAIGNS_PATH, text: "Back to campaigns" },
    action: CAMPAIGN_SETTINGS_PATH,
    cancel: CAMPAIGNS_PATH,
    submit: "Save settings",
    prefix: CAMPAIGN_SETTINGS_PREFIX,
    groups: [{ specs: campaignSettingsSpecs }],
    shown,
    errors: state?.errors ?? [],
  });
}
