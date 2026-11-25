// /campaigns/new and /campaigns/<id>/edit (decision 0053): a campaign built by hand, as record forms (decision 0018).
// Edit sends only the fields the owner changed (update_campaign_draft). Both are 404 while campaigns are off; Edit is a
// 404 for anything but a live draft.
import { type Audience, type CampaignDraftInput, loadCampaign } from "../../campaigns/drafts.ts";
import type { CampaignRow, CampaignStepRow, Db } from "../../db/db.ts";
import { getSettings } from "../../db/queries.ts";
import { isCampaignId } from "../../ids.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { listPersonStatuses } from "../../services/person-status.ts";
import { listViews } from "../../services/views.ts";
import type { PageContext } from "../context.ts";
import { editShown, line, type Shown, type Spec } from "../record-form.ts";
import { type FormState, recordFormPage } from "./record-page.ts";
import { CAMPAIGNS_NEW_PATH, CAMPAIGNS_PATH, campaignPath } from "./campaigns.ts";

export const CAMPAIGN_PREFIX = "campaign";
export const campaignEditPath = (id: string): string => `${campaignPath(id)}/edit`;

const BODY_HINT =
  "Leave a blank line between paragraphs. Write a link as [text](https://…) or paste an https:// address. {{first_name}} puts in each person's first name.";
const PEOPLE = "people";

/** An audience as the Send to select's value: status.<key>, view.<vw id> or people. */
export function audienceRef(audience: string): string {
  const parsed = JSON.parse(audience) as Audience;
  if (parsed.kind === "status") return `status.${parsed.status}`;
  if (parsed.kind === "view") return `view.${parsed.view}`;
  return PEOPLE;
}

/** A Send to value as the service's audience; people start with no one picked. Null when it names nothing. */
export function audienceOf(ref: string): Audience | null {
  if (ref === PEOPLE) return { kind: "people", people: [] };
  if (ref.startsWith("status.")) return { kind: "status", status: ref.slice("status.".length) };
  if (ref.startsWith("view.")) return { kind: "view", view: ref.slice("view.".length) };
  return null;
}

/**
 * The form's fields. Send to lists the live statuses and saved people views; `stored` is the audience an edit began with,
 * kept as an option even when its status or view has gone, so leaving the field alone is never a change.
 */
export async function campaignSpecs(db: Db, stored?: string): Promise<Spec[]> {
  const [statuses, views] = await Promise.all([listPersonStatuses(db), listViews(db, { module: "people" })]);
  const live = statuses.filter((status) => !status.archived).map((status) => ({ value: `status.${status.key}`, label: status.label }));
  const saved = views.filter((view) => view.kind === "saved" && view.id !== null).map((view) => ({ value: `view.${view.id}`, label: view.name }));
  const known = new Set([...live, ...saved].map((option) => option.value));
  const plain = [{ value: PEOPLE, label: "People I pick" }];
  if (stored !== undefined && stored !== PEOPLE && !known.has(stored)) plain.push({ value: stored, label: "A status or view that is no longer there" });
  return [
    line("name", "Name", "text", "contact", { required: true, requiredMessage: "Give the campaign a name.", maxlength: 100 }),
    line("audience", "Send to", "choice", "contact", {
      required: true,
      requiredMessage: "Choose who the campaign goes to.",
      column: "audience_ref",
      groups: [
        { label: "Person status", options: live },
        ...(saved.length === 0 ? [] : [{ label: "Saved views", options: saved }]),
        { label: "", options: plain },
      ],
      blank: "Choose who it goes to",
    }),
    line("subject", "Subject", "text", "contact", { required: true, requiredMessage: "Give the campaign a subject.", maxlength: 150 }),
    line("body", "Email text", "textarea", "contact", { required: true, requiredMessage: "Write the email text.", maxlength: 20_000, hint: BODY_HINT }),
    line("first_name_fallback", "If there's no first name", "text", "contact", {
      prop: "firstNameFallback",
      required: true,
      requiredMessage: "Give a word to use when a person has no first name, such as “there”.",
      maxlength: 40,
      hint: "Used for {{first_name}} when a person has none, as in “Hi there”.",
    }),
    line("button_label", "Button text", "text", "contact", {
      prop: "buttonLabel",
      maxlength: 40,
      hint: "For an invite: a button such as “RSVP” and the page it opens. Leave both empty for no button.",
    }),
    line("button_url", "Button link", "text", "contact", {
      prop: "buttonUrl",
      maxlength: 2000,
      hint: "Both or neither: a button needs its text and its link.",
    }),
  ];
}

/** The service's input from what the form sent (only the changed fields on an edit). */
export function draftInput(input: Record<string, unknown>): CampaignDraftInput {
  const { audience, ...rest } = input;
  const recipients = typeof audience === "string" ? audienceOf(audience) : null;
  return { ...(rest as CampaignDraftInput), ...(recipients === null ? {} : { recipients }) };
}

/** A campaign and its step as the record form reads a stored row. */
export const campaignFormRow = (campaign: CampaignRow, step: CampaignStepRow) => ({
  ...campaign,
  subject: step.subject,
  body: step.body,
  button_label: step.button_label,
  button_url: step.button_url,
  audience_ref: audienceRef(campaign.audience),
  fields: "{}",
  untrusted_fields: "[]",
});

/** The campaign and its step when this is a live draft (the only thing the form edits), else null. */
export async function editableCampaign(db: Db, id: string): Promise<{ campaign: CampaignRow; step: CampaignStepRow } | null> {
  if (!isCampaignId(id) || (await getSettings(db)).campaigns !== 1) return null;
  try {
    const found = await loadCampaign(db, id);
    return found.campaign.status === "draft" && found.campaign.archived === 0 ? found : null;
  } catch {
    return null;
  }
}

export async function campaignNewPage(ctx: PageContext, state?: FormState): Promise<string | null> {
  if ((await getSettings(ctx.db)).campaigns !== 1) return null;
  const specs = await campaignSpecs(ctx.db);
  const fresh = new Map<string, Shown>(specs.map((spec) => [spec.name, { value: spec.name === "first_name_fallback" ? "there" : "", outside: false }]));
  return recordFormPage(ctx, {
    title: "New campaign",
    description: "Write a campaign email and choose who it goes to.",
    heading: "New campaign",
    lede: "Write the email and choose who it goes to. Nothing is sent from this page.",
    current: CAMPAIGNS_PATH,
    back: { href: CAMPAIGNS_PATH, text: "Back to campaigns" },
    action: CAMPAIGNS_NEW_PATH,
    cancel: CAMPAIGNS_PATH,
    submit: "Save draft",
    prefix: CAMPAIGN_PREFIX,
    groups: [{ specs }],
    shown: state?.shown ?? fresh,
    errors: state?.errors ?? [],
  });
}

export async function campaignEditPage(ctx: PageContext, id: string, state?: FormState): Promise<string | null> {
  const found = await editableCampaign(ctx.db, id);
  if (found === null) return null;
  const row = campaignFormRow(found.campaign, found.step);
  const specs = await campaignSpecs(ctx.db, row.audience_ref);
  const back = campaignPath(id);
  return recordFormPage(ctx, {
    title: "Edit campaign",
    description: "Change a campaign draft's email, button and who it goes to.",
    heading: "Edit campaign",
    lede: "Change what you need and save. Nothing is sent from this page.",
    current: CAMPAIGNS_PATH,
    back: { href: back, text: "Back to the campaign" },
    action: campaignEditPath(id),
    cancel: back,
    submit: "Save changes",
    prefix: CAMPAIGN_PREFIX,
    groups: [{ specs }],
    shown: state?.shown ?? (await editShown(specs, row, await ownerTimezone(ctx.db))),
    errors: state?.errors ?? [],
  });
}
