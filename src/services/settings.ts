// get_settings and update_settings. Owner emails gate who can sign in, so they are shown but never changed here
// (decision 0005): the patch type has no field for them. The brief can only be sent to an owner email, so no text
// that talks the AI into a new address can redirect the brief (decision 0005, addendum).
import type { Db, SettingsRow } from "../db/db.ts";
import { getSettings as getSettingsRow } from "../db/queries.ts";
import { type ChangeResult, commitChange, type Ctx, updatedRow } from "./change.ts";
import { joinAnd } from "./describe.ts";
import { UserError } from "./errors.ts";
import { checkEmail, clean } from "./input.ts";
import { parseStringArray } from "./lookup.ts";

export interface SettingsView {
  timezone: string;
  briefHour: number;
  briefEmail: string | null;
  briefEnabled: boolean;
  ownerEmails: string[];
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
}

export interface SettingsOptions {
  /** Owner emails from the OWNER_EMAILS var, on top of settings.owner_emails. */
  extraOwnerEmails?: readonly string[];
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

  if (parts.length === 0) {
    throw new UserError("Nothing to change: every setting you gave is already set. Use get_settings to see them.");
  }
  return commitChange(ctx, {
    target: { table: "settings", id: String(before.id) },
    summary: `Updated settings: ${joinAnd(parts)}`,
    changes: [{ table: "settings", id: String(before.id), before, after: updatedRow(before, set, ctx.now) }],
  });
}
