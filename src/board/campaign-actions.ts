// The campaign posts (decision 0053). Each calls the service the matching MCP tool calls as the owner under that tool's
// name. While campaigns are off every path here is a 404. A refused form is drawn again (422) with the values kept.
import { getSettings } from "../db/queries.ts";
import { ownerTimezone } from "../services/lookup.ts";
import { updateSettings, type SettingsPatch } from "../services/settings.ts";
import { type ActionContext, type ActionResult, asOwner, fieldError, notFound, page, pageContext, redirect, refusal, type Route, stateOf } from "./action-kit.ts";
import type { PageContext } from "./context.ts";
import { CAMPAIGN_SETTINGS_PATH } from "./pages/campaigns.ts";
import { campaignSettingsPage, campaignSettingsSpecs, settingsFormRow } from "./pages/campaign-settings.ts";
import { collectEdit } from "./record-form.ts";
import { withChange } from "./return-to.ts";

const NOTHING_TO_SAVE = "Nothing to save: every field is as it was. Change a value, or cancel to go back.";

const campaignsOn = async (ctx: ActionContext): Promise<boolean> => (await getSettings(ctx.db)).campaigns === 1;

/** A campaign form's page context: campaigns are on (the paths 404 otherwise), so More lists Campaigns on a refused form too. */
export const campaignContext = (ctx: ActionContext, here: string): PageContext => ({ ...pageContext(ctx, here), campaigns: true });

/** POST /campaigns/settings: update_settings with the postal address and daily limit, only those the owner changed. */
async function saveSettings(ctx: ActionContext): Promise<ActionResult> {
  if (!(await campaignsOn(ctx))) return notFound(ctx);
  const row = await getSettings(ctx.db);
  const collected = await collectEdit(campaignSettingsSpecs, ctx.form, settingsFormRow(row), await ownerTimezone(ctx.db));
  const refused = async (extra: string[] = []) =>
    page(422, (await campaignSettingsPage(campaignContext(ctx, CAMPAIGN_SETTINGS_PATH), stateOf(collected, extra))) ?? "");
  if (collected.errors.length > 0) return refused();
  if (Object.keys(collected.input).length === 0) return refused([NOTHING_TO_SAVE]);
  const patch = collected.input as SettingsPatch;
  try {
    const result = await updateSettings(asOwner(ctx, "update_settings"), patch);
    return redirect(withChange(CAMPAIGN_SETTINGS_PATH, result.changeId));
  } catch (error) {
    const message = refusal(error, "setting");
    const field = /daily limit/.test(message) ? "daily_limit" : /postal address/.test(message) ? "postal_address" : undefined;
    if (field !== undefined) fieldError(collected, field, message);
    return refused(field === undefined ? [message] : []);
  }
}

export const CAMPAIGN_ROUTES: Route[] = [{ path: /^\/campaigns\/(settings)$/, handle: (ctx) => saveSettings(ctx), big: true }];
