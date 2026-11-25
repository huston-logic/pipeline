// get_settings and update_settings. Owner emails gate who can sign in, so they are shown but never changed here
// (decision 0005): the patch type has no field for them. The brief can only be sent to an owner email, so no text
// that talks the AI into a new address can redirect the brief (decision 0005, addendum).
import type { Db, SettingsRow } from "../db/db.ts";
import { getSettings as getSettingsRow } from "../db/queries.ts";
import { checkAccent } from "./accent.ts";
import { type ChangeResult, commitChange, type Ctx, updatedRow } from "./change.ts";
import { joinAnd } from "./describe.ts";
import { UserError } from "./errors.ts";
import { checkEmail, clean } from "./input.ts";
import { parseStringArray } from "./lookup.ts";
import { type Reader, settingsRow } from "./memo.ts";

/** settings.ai_edits (decision 0045): "review" is Review first, "small" is Apply small changes. */
export type AiEdits = SettingsRow["ai_edits"];

/** The words the AI app and the owner use for each AI edits value. */
export const AI_EDITS_CHOICES = ["review_first", "apply_small"] as const;
export type AiEditsChoice = (typeof AI_EDITS_CHOICES)[number];

const AI_EDITS_STORED: Record<AiEditsChoice, AiEdits> = { review_first: "review", apply_small: "small" };
const AI_EDITS_CHOICE: Record<AiEdits, AiEditsChoice> = { review: "review_first", small: "apply_small" };
const AI_EDITS_LABELS: Record<AiEdits, string> = { review: "Review first", small: "Apply small changes" };

/** settings.ai_approval: where the owner approves what the AI app proposes ("chat" or "board"). */
export type ApproveIn = SettingsRow["ai_approval"];

/** "<origin>/pending", the board page where proposals wait; just "/pending" when the origin is unknown. */
export const pendingUrl = (origin: string | undefined): string => `${origin ?? ""}/pending`;

/** Where the owner approves AI changes: read by the proposal and apply tools. */
export async function getApproveIn(db: Db): Promise<ApproveIn> {
  return (await getSettingsRow(db)).ai_approval;
}

/** The answer every time tool and service gives while time tracking is off (decision 0049). */
export const TIME_TRACKING_OFF = "Time tracking is off. The owner can turn it on (update_settings timeTracking true).";

/** Refuses unless the owner turned time tracking on. */
export async function requireTimeTracking(src: Reader): Promise<void> {
  if ((await settingsRow(src)).time_tracking !== 1) throw new UserError(TIME_TRACKING_OFF);
}

/** The answer every campaign tool and service gives while campaigns are off. */
export const CAMPAIGNS_OFF = "Campaigns are off. The owner can turn them on (update_settings campaigns true).";

/** Refuses unless the owner turned campaigns on. */
export async function requireCampaigns(src: Reader): Promise<void> {
  if ((await settingsRow(src)).campaigns !== 1) throw new UserError(CAMPAIGNS_OFF);
}

/** The answer every project tool and service gives while projects are off. */
export const PROJECTS_OFF = "Projects are off. The owner can turn them on (update_settings projects true).";

/** Refuses unless the owner turned projects on. */
export async function requireProjects(src: Reader): Promise<void> {
  if ((await settingsRow(src)).projects !== 1) throw new UserError(PROJECTS_OFF);
}

/** How the AI app's record tools write: propose everything, or apply small changes at once. */
export async function getAiEdits(db: Db): Promise<AiEdits> {
  return (await getSettingsRow(db)).ai_edits;
}

export interface SettingsView {
  timezone: string;
  briefHour: number;
  briefEmail: string | null;
  briefEnabled: boolean;
  ownerEmails: string[];
  /** The board's app bar and page titles show it; null shows "Pipeline". */
  businessName: string | null;
  /** The board's accent colour, "#rrggbb"; null uses the default green. */
  accentColor: string | null;
  /** How the AI app's record tools write: review_first (the default) or apply_small (decision 0045). */
  aiEdits: AiEditsChoice;
  /** Where AI changes are approved: chat (the default) or board. */
  approveIn: ApproveIn;
  /** Whether the time tools and pages are on (decision 0049); off by default. */
  timeTracking: boolean;
  /** Whether campaigns are on; off by default. */
  campaigns: boolean;
  /** Whether projects are on; off by default. */
  projects: boolean;
  /** Printed in every campaign email; null until the owner adds it. */
  postalAddress: string | null;
  /** Emails a day the campaign cron may send. */
  campaignDailyLimit: number;
  /** When the latest brief was composed (the briefs log), or null before the first one. */
  lastBriefAt: string | null;
  /** When a brief last went out by email, or null when none has. */
  lastBriefSentAt: string | null;
}

export interface SettingsPatch {
  /** An IANA name such as "America/Los_Angeles". */
  timezone?: string;
  /** 0 to 23, in the owner's timezone. */
  briefHour?: number;
  /** null clears it. */
  briefEmail?: string | null;
  briefEnabled?: boolean;
  /** 1 to 60 characters on one line; null (or blank) clears it. */
  businessName?: string | null;
  /** "#rrggbb", dark enough for white text and for text on the page (src/services/accent.ts); null clears it. */
  accentColor?: string | null;
  /** review_first or apply_small (decision 0045). */
  aiEdits?: AiEditsChoice;
  /** chat or board. Only the owner (the board) may set chat again; the AI app may only set board. */
  approveIn?: ApproveIn;
  /** true turns the time tools and pages on (decision 0049). */
  timeTracking?: boolean;
  /** true turns campaigns on. */
  campaigns?: boolean;
  /** true turns projects on. */
  projects?: boolean;
  /** 1 to 300 characters, line breaks kept; null clears it (an empty string is refused). */
  postalAddress?: string | null;
  /** A whole number, 1 to 5000. */
  campaignDailyLimit?: number;
}

export interface SettingsOptions {
  /** Owner emails from the OWNER_EMAILS var, on top of settings.owner_emails. */
  extraOwnerEmails?: readonly string[];
  /** The request's origin, for the board address in the refusal to switch approval back to chat. */
  origin?: string;
}

export async function getSettings(db: Db): Promise<SettingsView> {
  const row = await getSettingsRow(db);
  const latest = await db.prepare("SELECT composed_at FROM briefs ORDER BY local_date DESC LIMIT 1").first<{ composed_at: string }>();
  const sent = await db.prepare("SELECT MAX(sent_at) AS at FROM briefs").first<{ at: string | null }>();
  return {
    timezone: row.timezone,
    briefHour: row.brief_hour,
    briefEmail: row.brief_email,
    briefEnabled: row.brief_enabled === 1,
    ownerEmails: parseStringArray(row.owner_emails),
    businessName: row.business_name,
    accentColor: row.accent_color,
    aiEdits: AI_EDITS_CHOICE[row.ai_edits],
    approveIn: row.ai_approval,
    timeTracking: row.time_tracking === 1,
    campaigns: row.campaigns === 1,
    projects: row.projects === 1,
    postalAddress: row.postal_address,
    campaignDailyLimit: row.campaign_daily_limit,
    lastBriefAt: latest?.composed_at ?? null,
    lastBriefSentAt: sent?.at ?? null,
  };
}

/** The canonical spelling of an IANA timezone name, or a UserError. */
function checkTimezone(input: string): string {
  const name = input.trim();
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    throw new UserError(
      `"${input}" isn't a timezone I know. Use an IANA name such as America/Los_Angeles or Europe/London.`,
    );
  }
}

const lower = (email: string) => email.trim().toLowerCase();

const MAX_BUSINESS_NAME = 60;

/** The trimmed name, null to clear it, or a UserError. */
function checkBusinessName(input: string | null): string | null {
  const name = clean(input);
  if (name === null) return null;
  // Controls (C0 and C1), format characters (bidi overrides, zero-width joiners) and line or paragraph separators.
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) {
    throw new UserError(
      "A business name must be one line of plain text, without line breaks, tabs or invisible formatting characters.",
    );
  }
  const length = [...name].length;
  if (length > MAX_BUSINESS_NAME) {
    throw new UserError(
      `A business name can be at most ${MAX_BUSINESS_NAME} characters (this one has ${length}). Give a shorter name.`,
    );
  }
  return name;
}

const MAX_POSTAL_ADDRESS = 300;

/** The address with each line trimmed and empty lines dropped, or a UserError. */
function checkPostalAddress(input: string): string {
  const lines = input.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim());
  while (lines[0] === "") lines.shift();
  while (lines[lines.length - 1] === "") lines.pop();
  const address = lines.join("\n");
  if (address === "") {
    throw new UserError("A postal address can't be empty. Give the address, or use null to clear it.");
  }
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(address.replace(/\n/g, ""))) {
    throw new UserError("A postal address can only be plain text with line breaks, without tabs or invisible formatting characters.");
  }
  const length = [...address].length;
  if (length > MAX_POSTAL_ADDRESS) {
    throw new UserError(
      `A postal address can be at most ${MAX_POSTAL_ADDRESS} characters (this one has ${length}). Give a shorter address.`,
    );
  }
  return address;
}

function checkOwnerEmail(email: string, owners: string[]): void {
  if (owners.includes(lower(email))) return;
  const list = owners.length > 0 ? owners.join(", ") : "none are set yet";
  throw new UserError(
    `The brief can only go to an owner email (${list}), and ${email} isn't one. Use an owner email, or null to clear it.`,
  );
}

export async function updateSettings(ctx: Ctx, patch: SettingsPatch, options: SettingsOptions = {}): Promise<ChangeResult> {
  const before = await getSettingsRow(ctx.db);
  const set: Partial<SettingsRow> = {};
  const parts: string[] = [];

  if (patch.timezone !== undefined) {
    const timezone = checkTimezone(patch.timezone);
    if (timezone !== before.timezone) {
      set.timezone = timezone;
      parts.push(`timezone to ${timezone}`);
    }
  }
  if (patch.briefHour !== undefined) {
    if (!Number.isInteger(patch.briefHour) || patch.briefHour < 0 || patch.briefHour > 23) {
      throw new UserError(`The brief hour must be a whole number between 0 and 23 (got ${patch.briefHour}); 7 means 7:00 AM.`);
    }
    if (patch.briefHour !== before.brief_hour) {
      set.brief_hour = patch.briefHour;
      parts.push(`brief hour to ${patch.briefHour}:00`);
    }
  }
  if (patch.briefEmail !== undefined) {
    const email = clean(patch.briefEmail);
    if (email !== null) {
      checkEmail(email);
      const owners = [...parseStringArray(before.owner_emails), ...(options.extraOwnerEmails ?? [])].map(lower);
      checkOwnerEmail(email, [...new Set(owners.filter((owner) => owner !== ""))]);
    }
    if (email !== before.brief_email) {
      set.brief_email = email;
      parts.push(email === null ? "brief email cleared" : `brief email to ${email}`);
    }
  }
  if (patch.briefEnabled !== undefined && (patch.briefEnabled ? 1 : 0) !== before.brief_enabled) {
    set.brief_enabled = patch.briefEnabled ? 1 : 0;
    parts.push(`the daily brief ${patch.briefEnabled ? "on" : "off"}`);
  }
  if (patch.businessName !== undefined) {
    const name = checkBusinessName(patch.businessName);
    if (name !== before.business_name) {
      set.business_name = name;
      parts.push(name === null ? "business name cleared" : `business name to "${name}"`);
    }
  }
  if (patch.accentColor !== undefined) {
    const accent = patch.accentColor === null ? null : checkAccent(patch.accentColor);
    if (accent !== before.accent_color) {
      set.accent_color = accent;
      parts.push(accent === null ? "accent colour cleared" : `accent colour to ${accent}`);
    }
  }
  if (patch.aiEdits !== undefined) {
    const stored = AI_EDITS_STORED[patch.aiEdits];
    if (stored !== before.ai_edits) {
      set.ai_edits = stored;
      parts.push(`AI edits: ${AI_EDITS_LABELS[stored]}`);
    }
  }
  if (patch.approveIn !== undefined && patch.approveIn !== before.ai_approval) {
    if (patch.approveIn === "chat" && ctx.actor === "ai") {
      throw new UserError(`Only the board can switch this back. Open ${pendingUrl(options.origin)}.`);
    }
    set.ai_approval = patch.approveIn;
    parts.push(patch.approveIn === "board" ? "AI changes are approved on the board only" : "AI changes are approved in chat");
  }
  if (patch.timeTracking !== undefined && (patch.timeTracking ? 1 : 0) !== before.time_tracking) {
    set.time_tracking = patch.timeTracking ? 1 : 0;
    parts.push(`time tracking ${patch.timeTracking ? "on" : "off"}`);
  }
  if (patch.campaigns !== undefined && (patch.campaigns ? 1 : 0) !== before.campaigns) {
    set.campaigns = patch.campaigns ? 1 : 0;
    parts.push(`campaigns ${patch.campaigns ? "on" : "off"}`);
  }
  if (patch.projects !== undefined && (patch.projects ? 1 : 0) !== before.projects) {
    set.projects = patch.projects ? 1 : 0;
    parts.push(`projects ${patch.projects ? "on" : "off"}`);
  }
  if (patch.postalAddress !== undefined) {
    const address = patch.postalAddress === null ? null : checkPostalAddress(patch.postalAddress);
    if (address !== before.postal_address) {
      set.postal_address = address;
      parts.push(address === null ? "postal address cleared" : "postal address set");
    }
  }
  if (patch.campaignDailyLimit !== undefined) {
    const limit = patch.campaignDailyLimit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
      throw new UserError(`The campaign daily limit must be a whole number between 1 and 5000 (got ${limit}).`);
    }
    if (limit !== before.campaign_daily_limit) {
      set.campaign_daily_limit = limit;
      parts.push(`campaign daily limit ${limit}`);
    }
  }

  if (parts.length === 0) {
    throw new UserError("Nothing to change: every setting you gave is already set. Use get_settings to see them.");
  }
  return commitChange(ctx, {
    target: { table: "settings", id: String(before.id) },
    summary: `Updated settings: ${joinAnd(parts)}`,
    changes: [{ table: "settings", id: String(before.id), before, after: updatedRow(before, set, ctx.now) }],
  });
}
