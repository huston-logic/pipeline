// The daily brief's schedule and storage. The hourly cron calls runBrief after the rules, so tasks the rules just
// created are included. Decision 0011: composed and stored once per owner-local day whatever brief_enabled says,
// stored in `briefs` as an append-only system log (no audit row, not undoable), emailed only when every switch is on.
import type { BriefRow, Db, SettingsRow } from "../db/db.ts";
import { getSettings } from "../db/queries.ts";
import type { Env } from "../env.ts";
import { newId } from "../ids.ts";
import { type PushOptions, sendBriefPush } from "../push/send.ts";
import { untrustedFields } from "../services/labels.ts";
import { leadCounts } from "../services/leads-read.ts";
import { whatsDue } from "../services/read.ts";
import { listQuietDeals } from "../services/rules.ts";
import { localDate, localHour } from "../time.ts";
import { type BriefInput, type BriefLead, type BriefQuietDeal, composeBrief } from "./compose.ts";
import { sendBlocker, sendBrief } from "./send.ts";

const DAY_MS = 86_400_000;

/** `sent` and `failed` are the email; the push counts are there only when this copy has push keys (decision 0030). */
export type BriefRunCounts = { composed: number; sent: number; failed: number } & Partial<PushRunCounts>;

type PushRunCounts = { pushed: number; push_gone: number; push_failed: number };

/** The phone notification for a stored brief. A failure here never stops the brief or its email. */
async function pushBrief(env: Env, now: Date, options: PushOptions): Promise<PushRunCounts | null> {
  try {
    const result = await sendBriefPush(env.DB, env, now, options);
    if (result.skipped === "no_keys") return null;
    return { pushed: result.sent, push_gone: result.gone, push_failed: result.failed };
  } catch {
    return { pushed: 0, push_gone: 0, push_failed: 1 };
  }
}

/** True once per owner-local day: at or after the brief hour, and no brief stored for that date or a later one. */
export function shouldRunBrief(
  now: Date,
  settings: Pick<SettingsRow, "timezone" | "brief_hour">,
  lastBriefLocalDate: string | null,
): boolean {
  if (lastBriefLocalDate !== null && lastBriefLocalDate >= localDate(now, settings.timezone)) return false;
  return localHour(now, settings.timezone) >= settings.brief_hour;
}

type LeadJoin = {
  deal_id: string;
  title: string;
  untrusted_fields: string;
  created_at: string;
  contact_id: string;
  contact_name: string;
  contact_untrusted: string;
};

/** Deals added after `since` (and not after now), oldest first. */
async function newLeads(db: Db, since: string, now: Date): Promise<BriefLead[]> {
  const found = await db
    .prepare(
      `SELECT d.id AS deal_id, d.title, d.untrusted_fields, d.created_at, c.id AS contact_id, c.name AS contact_name,
         c.untrusted_fields AS contact_untrusted
       FROM deals d JOIN contacts c ON c.id = d.contact_id
       WHERE d.archived = 0 AND d.created_at > ? AND d.created_at <= ? ORDER BY d.created_at, d.id`,
    )
    .bind(since, now.toISOString())
    .all<LeadJoin>();
  return found.results.map((row) => ({
    dealId: row.deal_id,
    contactId: row.contact_id,
    title: row.title,
    contactName: row.contact_name,
    createdAt: row.created_at,
    untrusted_fields: [
      ...(untrustedFields({ untrusted_fields: row.untrusted_fields }).has("title") ? ["title"] : []),
      ...(untrustedFields({ untrusted_fields: row.contact_untrusted }).has("name") ? ["contactName"] : []),
    ],
  }));
}

/** One entry per deal (the longest quiet spell when two rules flag it), longest quiet first. */
async function quietList(db: Db, now: Date): Promise<BriefQuietDeal[]> {
  const byDeal = new Map<string, BriefQuietDeal>();
  for (const flag of await listQuietDeals(db, now)) {
    const known = byDeal.get(flag.dealId);
    if (known && known.quietDays >= flag.quietDays) continue;
    byDeal.set(flag.dealId, {
      id: flag.dealId,
      title: flag.title,
      contactName: flag.contactName,
      quietDays: flag.quietDays,
      untrusted_fields: flag.untrusted_fields,
    });
  }
  return [...byDeal.values()].sort((a, b) => b.quietDays - a.quietDays || a.id.localeCompare(b.id));
}

/** New, Contacted and Not now people; null when there are none, so an owner with no leads sees no new line. */
async function openLeadCounts(db: Db): Promise<BriefInput["leads"]> {
  const counts = await leadCounts(db);
  const leads = { new: counts.new, contacted: counts.contacted, notNow: counts.not_now };
  return leads.new + leads.contacted + leads.notNow === 0 ? null : leads;
}

/**
 * Composes and stores today's brief when it is due, emails it when sending is on, then pushes the phone notification
 * when push is set up. Returns counts only.
 */
export async function runBrief(env: Env, now: Date, push: PushOptions = {}): Promise<BriefRunCounts> {
  const { DB: db } = env;
  const counts: BriefRunCounts = { composed: 0, sent: 0, failed: 0 };
  const settings = await getSettings(db);
  const previous = await db
    .prepare("SELECT local_date, composed_at FROM briefs ORDER BY local_date DESC LIMIT 1")
    .first<Pick<BriefRow, "local_date" | "composed_at">>();
  if (!shouldRunBrief(now, settings, previous?.local_date ?? null)) return counts;

  const tz = settings.timezone;
  const due = await whatsDue(db, now, tz);
  const brief = composeBrief({
    now,
    tz,
    tasks: { overdue: due.overdueTasks, today: due.todayTasks },
    quietDeals: await quietList(db, now),
    newLeads: await newLeads(db, previous?.composed_at ?? new Date(now.getTime() - DAY_MS).toISOString(), now),
    leads: await openLeadCounts(db),
  });

  // "pending" is overwritten once the send finishes; it stays only if the Worker dies in between, and the brief is
  // then not sent again (no double emails).
  const blocker = sendBlocker(env, settings);
  const id = newId("br");
  const at = now.toISOString();
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO briefs (id, local_date, composed_at, text, items, send_status) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (local_date) DO NOTHING`,
      )
      .bind(id, brief.localDate, at, brief.text, JSON.stringify(brief.items), blocker ?? "pending"),
  ]);
  // Another run stored today's brief first: it owns the send.
  if (!inserted || inserted.meta.changes === 0) return counts;
  counts.composed = 1;

  // The email and its status first, so a slow push service can never hold it back or leave it "pending".
  if (blocker === null) {
    const result = await sendBrief(env, brief, settings);
    await db
      .prepare("UPDATE briefs SET sent_at = ?, send_status = ? WHERE id = ?")
      .bind(result.sent ? at : null, result.sent ? "sent" : result.reason, id)
      .run();
    if (result.sent) counts.sent = 1;
    else counts.failed = 1;
  }

  // Only the run that stored the brief gets here, so each device is told once a day.
  const pushed = await pushBrief(env, now, push);
  if (pushed !== null) Object.assign(counts, pushed);
  return counts;
}
