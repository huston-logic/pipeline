// The campaign posts (decision 0053). Each calls the service the matching MCP tool calls as the owner under that tool's
// name. While campaigns are off every path here is a 404. A refused form is drawn again (422) with the values kept.
import { addCampaignDraft, updateCampaignDraft } from "../campaigns/drafts.ts";
import { clearSuppression, liveUnsubscribes } from "../campaigns/suppressions.ts";
import { getContact, getSettings } from "../db/queries.ts";
import { isContactId } from "../ids.ts";
import { contactName } from "../services/labels.ts";
import { ownerTimezone } from "../services/lookup.ts";
import { updateSettings, type SettingsPatch } from "../services/settings.ts";
import { type ActionContext, type ActionResult, asOwner, fieldError, notFound, page, redirect, refusal, refusedPage, type Route, stateOf } from "./action-kit.ts";
import { confirmPage } from "./campaign-emails.ts";
import { CAMPAIGN_SEND_ROUTES, campaignContext } from "./campaign-send-actions.ts";
import { CAMPAIGN_SETTINGS_PATH, CAMPAIGNS_NEW_PATH, campaignPath } from "./pages/campaigns.ts";
import {
  audienceRef,
  campaignEditPage,
  campaignEditPath,
  campaignFormRow,
  campaignNewPage,
  campaignSpecs,
  draftInput,
  editableCampaign,
} from "./pages/campaign-form.ts";
import { campaignPeoplePage, campaignPeoplePath, pickedOf, QUERY_MAX } from "./pages/campaign-people.ts";
import { campaignSettingsPage, campaignSettingsSpecs, settingsFormRow } from "./pages/campaign-settings.ts";
import { type Collected, collectEdit, collectNew } from "./record-form.ts";
import { withChange } from "./return-to.ts";

const NOTHING_TO_SAVE = "Nothing to save: every field is as it was. Change a value, or cancel to go back.";

const campaignsOn = async (ctx: ActionContext): Promise<boolean> => (await getSettings(ctx.db)).campaigns === 1;

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

/** The form field a service refusal is about, from the words it uses; none for a refusal that is about no field. */
const FIELD_WORDS: [RegExp, string][] = [
  [/first-name fallback/i, "first_name_fallback"],
  [/button address/i, "button_url"],
  [/button/i, "button_label"],
  [/subject/i, "subject"],
  [/body/i, "body"],
  [/status|view|people|recipients/i, "audience"],
  [/\bname\b/i, "name"],
];

/** Marks the field a refusal is about, or returns it as a message for the top of the form. */
function refuseOnField(collected: Collected, error: unknown): string[] {
  const message = refusal(error, "campaign");
  const field = /both a label and an address/i.test(message)
    ? (collected.shown.get("button_label")?.value.trim() === "" ? "button_label" : "button_url")
    : FIELD_WORDS.find(([words]) => words.test(message))?.[1];
  if (field === undefined) return [message];
  fieldError(collected, field, message);
  return [];
}

/** POST /campaigns/new: add_campaign_draft. "People I pick" goes on to the picker, since no one is picked yet. */
async function createCampaign(ctx: ActionContext): Promise<ActionResult> {
  if (!(await campaignsOn(ctx))) return notFound(ctx);
  const collected = collectNew(await campaignSpecs(ctx.db), ctx.form);
  const refused = async (extra: string[] = []) =>
    page(422, (await campaignNewPage(campaignContext(ctx, CAMPAIGNS_NEW_PATH), stateOf(collected, extra))) ?? "");
  if (collected.errors.length > 0) return refused();
  try {
    const input = draftInput(collected.input);
    const result = await addCampaignDraft(asOwner(ctx, "add_campaign_draft"), input);
    const next = input.recipients?.kind === "people" ? campaignPeoplePath(result.campaignId) : campaignPath(result.campaignId);
    return redirect(withChange(next, result.changeId));
  } catch (error) {
    return refused(refuseOnField(collected, error));
  }
}

/** POST /campaigns/<id>/edit: update_campaign_draft with only the fields the owner changed. */
async function editCampaign(ctx: ActionContext, id: string): Promise<ActionResult> {
  const found = await editableCampaign(ctx.db, id);
  if (found === null) return notFound(ctx);
  const specs = await campaignSpecs(ctx.db, audienceRef(found.campaign.audience));
  const collected = await collectEdit(specs, ctx.form, campaignFormRow(found.campaign, found.step), await ownerTimezone(ctx.db));
  const refused = async (extra: string[] = []) =>
    page(422, (await campaignEditPage(campaignContext(ctx, campaignEditPath(id)), id, stateOf(collected, extra))) ?? "");
  if (collected.errors.length > 0) return refused();
  if (Object.keys(collected.input).length === 0) return refused([NOTHING_TO_SAVE]);
  try {
    const result = await updateCampaignDraft(asOwner(ctx, "update_campaign_draft"), id, draftInput(collected.input));
    return redirect(withChange(campaignPath(id), result.changeId));
  } catch (error) {
    return refused(refuseOnField(collected, error));
  }
}

const MAX_PEOPLE = 500;

/** The search the picker form was posted from, kept across the post. */
const searchOf = (ctx: ActionContext): string => (ctx.form.get("q") ?? "").trim().slice(0, QUERY_MAX);

/** The picker drawn again with a refusal (422), with the search it was posted from. */
async function pickerRefused(ctx: ActionContext, id: string, message: string): Promise<ActionResult> {
  const q = searchOf(ctx);
  const view = { ...campaignContext(ctx, campaignPeoplePath(id)), query: new URLSearchParams(q === "" ? {} : { q }) };
  return page(422, (await campaignPeoplePage(view, id, [message])) ?? "");
}

/** Writes the picked list as the owner and goes back to the picker (keeping the search), or draws it again with the refusal. */
async function savePeople(ctx: ActionContext, id: string, people: string[]): Promise<ActionResult> {
  const path = campaignPeoplePath(id);
  const q = searchOf(ctx);
  try {
    const result = await updateCampaignDraft(asOwner(ctx, "update_campaign_draft"), id, { recipients: { kind: "people", people } });
    return redirect(withChange(q === "" ? path : `${path}?${new URLSearchParams({ q }).toString()}`, result.changeId));
  } catch (error) {
    return pickerRefused(ctx, id, refusal(error, "campaign"));
  }
}

/** POST /campaigns/<id>/people/add: the ticked people join the list, once each, in the order ticked. */
async function addPeople(ctx: ActionContext, id: string): Promise<ActionResult> {
  const picked = await pickedOf(ctx.db, id);
  if (picked === null) return notFound(ctx);
  const ticked = [...new Set(ctx.form.getAll("person").map((person) => person.trim()).filter((person) => person !== ""))];
  const fresh = ticked.filter((person) => !picked.includes(person));
  const message =
    ticked.length === 0
      ? "Tick at least one person to add."
      : fresh.length === 0
        ? "Everyone you ticked is already picked."
        : picked.length + fresh.length > MAX_PEOPLE
          ? `A campaign can go to at most ${MAX_PEOPLE} people picked by hand: ${picked.length} are picked and you ticked ${fresh.length} more.`
          : null;
  if (message !== null) return pickerRefused(ctx, id, message);
  return savePeople(ctx, id, [...picked, ...fresh]);
}

/** POST /campaigns/<id>/people/remove: one person off the list. */
async function removePerson(ctx: ActionContext, id: string): Promise<ActionResult> {
  const picked = await pickedOf(ctx.db, id);
  if (picked === null) return notFound(ctx);
  const person = (ctx.form.get("person") ?? "").trim();
  if (!picked.includes(person)) {
    const q = searchOf(ctx);
    const path = campaignPeoplePath(id);
    return redirect(q === "" ? path : `${path}?${new URLSearchParams({ q }).toString()}`);
  }
  return savePeople(ctx, id, picked.filter((one) => one !== person));
}

/** POST /contacts/<id>/campaign-emails/allow: asks first unless confirm=yes, then clear_suppression as the owner. */
async function allowAgain(ctx: ActionContext, id: string): Promise<ActionResult> {
  if (!isContactId(id) || !(await campaignsOn(ctx))) return notFound(ctx);
  const contact = await getContact(ctx.db, id);
  if (contact === null) return notFound(ctx);
  const back = `/contacts/${id}`;
  const refused = (message: string) => page(422, refusedPage(ctx, "Campaign emails weren't changed", message, back, "", back));
  if (ctx.form.get("confirm") !== "yes") {
    if ((await liveUnsubscribes(ctx.db, contact)).length === 0) return refused(`${contactName(contact)} has no unsubscribe to clear.`);
    return page(200, confirmPage({ csrf: ctx.csrf, look: ctx.look, campaigns: true }, contact));
  }
  try {
    const result = await clearSuppression(asOwner(ctx, "clear_suppression"), id);
    return redirect(withChange(back, result.changeId));
  } catch (error) {
    return refused(refusal(error, "person"));
  }
}

export const CAMPAIGN_ROUTES: Route[] = [
  { path: /^\/contacts\/([^/]+)\/campaign-emails\/allow$/, handle: allowAgain },
  { path: /^\/campaigns\/(settings)$/, handle: (ctx) => saveSettings(ctx), big: true },
  { path: /^\/campaigns\/(new)$/, handle: (ctx) => createCampaign(ctx), big: true },
  { path: /^\/campaigns\/([^/]+)\/edit$/, handle: editCampaign, big: true },
  { path: /^\/campaigns\/([^/]+)\/people\/add$/, handle: addPeople },
  { path: /^\/campaigns\/([^/]+)\/people\/remove$/, handle: removePerson },
  ...CAMPAIGN_SEND_ROUTES,
];
