// Campaign drafts: add, change, duplicate and archive. A draft is one campaigns row and its step 1 (campaign_steps,
// position 1), written in one audited change. Nothing here sends, schedules or approves anything. The summaries name a
// campaign by id only (labels.ts): its name and subject may have been written by the AI.
import type { CampaignRow, CampaignStepRow, Db } from "../db/db.ts";
import { newId } from "../ids.ts";
import { type ChangeResult, commitChange, type Ctx, type RowChange, updatedRow } from "../services/change.ts";
import { joinAnd, short } from "../services/describe.ts";
import { UserError } from "../services/errors.ts";
import { campaignLabel } from "../services/labels.ts";
import { settingsRow } from "../services/memo.ts";
import { requireCampaigns } from "../services/settings.ts";
import { liveStatus } from "../services/views.ts";
import { parseWhen } from "../time.ts";
import { isHttpsUrl } from "./body.ts";

export type Audience =
  | { kind: "status"; status: string }
  | { kind: "view"; view: string }
  | { kind: "people"; people: string[] };

export interface CampaignDraftInput {
  /** 1 to 100 characters on one line. */
  name?: string;
  recipients?: Audience;
  /** 1 to 150 characters on one line; may hold {{first_name}}. */
  subject?: string;
  /** 1 to 20,000 characters of plain text (see body.ts). */
  body?: string;
  /** Button label (1 to 40) and address (https, at most 2,000): both or neither. null clears. */
  buttonLabel?: string | null;
  buttonUrl?: string | null;
  /** Used for {{first_name}} when a person has none: 1 to 40 characters, default "there". */
  firstNameFallback?: string;
  /** The AI's suggestion, in the owner's timezone and in the future; never acted on. null clears. */
  suggestedSendAt?: string | null;
}

type DraftResult = ChangeResult & { campaignId: string };

const LIMITS = { name: 100, subject: 150, body: 20_000, fallback: 40, buttonLabel: 40, buttonUrl: 2000, people: 500 };
// Control characters and line or paragraph separators only: emoji joiners and variation selectors (\p{Cf}) are fine.
const ONE_LINE = /[\p{Cc}\p{Zl}\p{Zp}]/u;

function checkText(value: string | undefined, what: string, max: number, options: { oneLine?: boolean } = {}): string {
  const text = (value ?? "").trim();
  if (text === "") throw new UserError(`A campaign needs ${/^[aeiou]/.test(what) ? "an" : "a"} ${what}.`);
  if (options.oneLine && ONE_LINE.test(text)) throw new UserError(`A campaign ${what} must be one line of plain text.`);
  const length = [...text].length;
  if (length > max) throw new UserError(`A campaign ${what} can be at most ${max} characters (this one has ${length}).`);
  return text;
}

const checkBody = (value: string | undefined) => checkText(value?.replace(/\r\n?/g, "\n"), "body", LIMITS.body);

/** The label and address, both or neither, as the draft will store them. */
function checkButton(label: string | null, url: string | null): { label: string | null; url: string | null } {
  const text = (value: string | null) => (value?.trim() ?? "") === "" ? null : (value as string).trim();
  const [shownLabel, shownUrl] = [text(label), text(url)];
  if ((shownLabel === null) !== (shownUrl === null)) throw new UserError("A button needs both a label and an address, or neither.");
  if (shownLabel === null || shownUrl === null) return { label: null, url: null };
  checkText(shownLabel, "button label", LIMITS.buttonLabel, { oneLine: true });
  if (!isHttpsUrl(shownUrl) || shownUrl.length > LIMITS.buttonUrl) {
    throw new UserError(`A button address must be a full https:// address of at most ${LIMITS.buttonUrl} characters.`);
  }
  return { label: shownLabel, url: shownUrl };
}

async function checkSendAt(ctx: Ctx, value: string | null): Promise<string | null> {
  if (value === null || value.trim() === "") return null;
  const at = parseWhen(value, (await settingsRow(ctx)).timezone);
  if (at.getTime() <= ctx.now.getTime()) throw new UserError("The suggested send time must be in the future.");
  return at.toISOString();
}

async function livePeople(db: Db, ids: string[]): Promise<Set<string>> {
  const found = await db
    .prepare("SELECT id FROM contacts WHERE archived = 0 AND id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(ids))
    .all<{ id: string }>();
  return new Set(found.results.map((row) => row.id));
}

/** The audience as canonical JSON, or a UserError. */
async function checkAudience(db: Db, input: unknown): Promise<string> {
  const audience = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  if (audience.kind === "status" && typeof audience.status === "string") {
    const key = audience.status.trim();
    if ((await liveStatus(db, key)) === null) {
      const live = await db.prepare("SELECT key FROM person_statuses WHERE archived = 0 ORDER BY position, key").all<{ key: string }>();
      throw new UserError(`There's no live person status "${short(key, 40)}". Statuses: ${live.results.map((s) => s.key).join(", ")}.`);
    }
    return JSON.stringify({ kind: "status", status: key });
  }
  if (audience.kind === "view" && typeof audience.view === "string") {
    const id = audience.view.trim();
    const view = await db.prepare("SELECT module, archived FROM views WHERE id = ?").bind(id).first<{ module: string; archived: number }>();
    if (view === null) throw new UserError(`There's no view ${short(id, 40)}. Use list_views to find one.`);
    if (view.module !== "people") throw new UserError("That view lists deals. Pick a view of people.");
    if (view.archived === 1) throw new UserError(`View ${id} is archived. Pick a live view of people.`);
    return JSON.stringify({ kind: "view", view: id });
  }
  if (audience.kind === "people" && Array.isArray(audience.people) && audience.people.every((id) => typeof id === "string")) {
    const ids = [...new Set((audience.people as string[]).map((id) => id.trim()))];
    if (ids.length > LIMITS.people) {
      throw new UserError(`A list of people can hold at most ${LIMITS.people} people, each once (got ${ids.length}).`);
    }
    const live = ids.length === 0 ? new Set<string>() : await livePeople(db, ids);
    const missing = ids.filter((id) => !live.has(id));
    if (missing.length > 0) {
      const shown = missing.slice(0, 5).map((id) => short(id, 40)).join(", ");
      throw new UserError(`These people aren't on the board, or are archived: ${shown}${missing.length > 5 ? " and more" : ""}. Use list_contacts to find them.`);
    }
    return JSON.stringify({ kind: "people", people: ids });
  }
  throw new UserError("Recipients are a status, view or people: { kind: status, status }, { kind: view, view } or { kind: people, people }.");
}

export async function loadCampaign(db: Db, id: string): Promise<{ campaign: CampaignRow; step: CampaignStepRow }> {
  const campaign = await db.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first<CampaignRow>();
  const step = campaign
    ? await db.prepare("SELECT * FROM campaign_steps WHERE campaign_id = ? AND position = 1").bind(id).first<CampaignStepRow>()
    : null;
  if (campaign === null || step === null) throw new UserError(`There's no campaign ${short(id, 40)}. Use list_campaigns to find it.`);
  return { campaign, step };
}

function requireDraft(campaign: CampaignRow, verb: "edited" | "archived"): void {
  if (campaign.status !== "draft") {
    throw new UserError(verb === "edited" ? "Only a draft can be edited. Duplicate it to make a new draft." : "Only a draft can be archived.");
  }
  if (campaign.archived === 1) throw new UserError(`${capital(campaignLabel(campaign.id))} is archived. Duplicate it to make a new draft.`);
}

export const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function newRows(
  ctx: Ctx,
  campaignFields: Pick<CampaignRow, "name" | "audience" | "first_name_fallback" | "suggested_send_at">,
  stepFields: Pick<CampaignStepRow, "subject" | "body" | "button_label" | "button_url" | "delay_days" | "stop_when">,
): { campaign: CampaignRow; step: CampaignStepRow } {
  const now = ctx.now.toISOString();
  const campaign: CampaignRow = {
    id: newId("cp"),
    status: "draft",
    send_after: null,
    approved_at: null,
    base_url: null,
    send_error: null,
    completed_at: null,
    archived: 0,
    version: 1,
    created_at: now,
    updated_at: now,
    ...campaignFields,
  };
  const step: CampaignStepRow = { id: newId("cs"), campaign_id: campaign.id, position: 1, version: 1, created_at: now, updated_at: now, ...stepFields };
  return { campaign, step };
}

const insertions = (rows: { campaign: CampaignRow; step: CampaignStepRow }): RowChange[] => [
  { table: "campaigns", id: rows.campaign.id, before: null, after: rows.campaign },
  { table: "campaign_steps", id: rows.step.id, before: null, after: rows.step },
];

export async function addCampaignDraft(ctx: Ctx, input: CampaignDraftInput): Promise<DraftResult> {
  await requireCampaigns(ctx);
  const name = checkText(input.name, "name", LIMITS.name, { oneLine: true });
  if (input.recipients === undefined) throw new UserError("A campaign needs recipients.");
  const subject = checkText(input.subject, "subject", LIMITS.subject, { oneLine: true });
  const body = checkBody(input.body);
  const fallback = input.firstNameFallback === undefined ? "there" : checkText(input.firstNameFallback, "first-name fallback", LIMITS.fallback, { oneLine: true });
  const button = checkButton(input.buttonLabel ?? null, input.buttonUrl ?? null);
  const audience = await checkAudience(ctx.db, input.recipients);
  const suggested = await checkSendAt(ctx, input.suggestedSendAt ?? null);
  const rows = newRows(
    ctx,
    { name, audience, first_name_fallback: fallback, suggested_send_at: suggested },
    { subject, body, button_label: button.label, button_url: button.url, delay_days: null, stop_when: null },
  );
  const result = await commitChange(ctx, {
    target: { table: "campaigns", id: rows.campaign.id },
    summary: `Added campaign draft ${rows.campaign.id}`,
    changes: insertions(rows),
  });
  return { ...result, campaignId: rows.campaign.id };
}

export async function updateCampaignDraft(ctx: Ctx, id: string, input: CampaignDraftInput): Promise<DraftResult> {
  await requireCampaigns(ctx);
  const { campaign, step } = await loadCampaign(ctx.db, id);
  requireDraft(campaign, "edited");
  const set: Partial<CampaignRow> = {};
  const stepSet: Partial<CampaignStepRow> = {};
  const parts: string[] = [];
  if (input.name !== undefined) {
    const name = checkText(input.name, "name", LIMITS.name, { oneLine: true });
    if (name !== campaign.name) {
      set.name = name;
      parts.push("name");
    }
  }
  if (input.recipients !== undefined) {
    const audience = await checkAudience(ctx.db, input.recipients);
    if (audience !== campaign.audience) {
      set.audience = audience;
      parts.push("audience");
    }
  }
  if (input.subject !== undefined) {
    const subject = checkText(input.subject, "subject", LIMITS.subject, { oneLine: true });
    if (subject !== step.subject) {
      stepSet.subject = subject;
      parts.push("subject");
    }
  }
  if (input.body !== undefined) {
    const body = checkBody(input.body);
    if (body !== step.body) {
      stepSet.body = body;
      parts.push("body");
    }
  }
  if (input.buttonLabel !== undefined || input.buttonUrl !== undefined) {
    const button = checkButton(
      input.buttonLabel === undefined ? step.button_label : input.buttonLabel,
      input.buttonUrl === undefined ? step.button_url : input.buttonUrl,
    );
    if (button.label !== step.button_label || button.url !== step.button_url) {
      stepSet.button_label = button.label;
      stepSet.button_url = button.url;
      parts.push("button");
    }
  }
  if (input.firstNameFallback !== undefined) {
    const fallback = checkText(input.firstNameFallback, "first-name fallback", LIMITS.fallback, { oneLine: true });
    if (fallback !== campaign.first_name_fallback) {
      set.first_name_fallback = fallback;
      parts.push("first-name fallback");
    }
  }
  if (input.suggestedSendAt !== undefined) {
    const at = await checkSendAt(ctx, input.suggestedSendAt);
    if (at !== campaign.suggested_send_at) {
      set.suggested_send_at = at;
      parts.push("suggested send time");
    }
  }
  if (parts.length === 0) {
    throw new UserError(`Nothing to change on campaign draft ${campaign.id}: every value you gave is already set.`);
  }
  const order = ["name", "audience", "subject", "body", "button", "first-name fallback", "suggested send time"];
  const changes: RowChange[] = [{ table: "campaigns", id: campaign.id, before: campaign, after: updatedRow(campaign, set, ctx.now) }];
  if (Object.keys(stepSet).length > 0) changes.push({ table: "campaign_steps", id: step.id, before: step, after: updatedRow(step, stepSet, ctx.now) });
  const result = await commitChange(ctx, {
    target: { table: "campaigns", id: campaign.id },
    summary: `Changed campaign draft ${campaign.id}: ${joinAnd(order.filter((part) => parts.includes(part)))}`,
    changes,
  });
  return { ...result, campaignId: campaign.id };
}

/** A new draft with another campaign's audience, content and fallback; any status, even archived. */
export async function duplicateCampaign(ctx: Ctx, id: string): Promise<DraftResult> {
  await requireCampaigns(ctx);
  const { campaign, step } = await loadCampaign(ctx.db, id);
  const suffix = " (copy)";
  const name = `${[...campaign.name].slice(0, LIMITS.name - suffix.length).join("")}${suffix}`;
  const rows = newRows(
    ctx,
    { name, audience: campaign.audience, first_name_fallback: campaign.first_name_fallback, suggested_send_at: null },
    { subject: step.subject, body: step.body, button_label: step.button_label, button_url: step.button_url, delay_days: step.delay_days, stop_when: step.stop_when },
  );
  const result = await commitChange(ctx, {
    target: { table: "campaigns", id: rows.campaign.id },
    summary: `Duplicated ${campaignLabel(campaign.id)} as ${rows.campaign.id}`,
    changes: insertions(rows),
  });
  return { ...result, campaignId: rows.campaign.id };
}

export async function archiveCampaign(ctx: Ctx, id: string): Promise<DraftResult> {
  await requireCampaigns(ctx);
  const { campaign } = await loadCampaign(ctx.db, id);
  if (campaign.status === "draft" && campaign.archived === 1) throw new UserError(`${capital(campaignLabel(id))} is already archived. Nothing to do.`);
  requireDraft(campaign, "archived");
  const result = await commitChange(ctx, {
    target: { table: "campaigns", id: campaign.id },
    summary: `Archived campaign draft ${campaign.id}`,
    changes: [{ table: "campaigns", id: campaign.id, before: campaign, after: updatedRow(campaign, { archived: 1 }, ctx.now) }],
  });
  return { ...result, campaignId: campaign.id };
}
