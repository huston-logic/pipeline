// The daily brief's schedule and storage. The hourly cron calls runBrief after the rules, so tasks the rules just
// created are included. Decision 0011: composed and stored once per owner-local day whatever brief_enabled says,
// stored in `briefs` as an append-only system log (no audit row, not undoable), emailed only when every switch is on.
import type { BriefRow, Db, SettingsRow } from "../db/db.ts";
import { getSettings } from "../db/queries.ts";
import type { Env } from "../env.ts";
import { newId } from "../ids.ts";
import { untrustedFields } from "../services/labels.ts";
import { whatsDue } from "../services/read.ts";
import { listQuietDeals } from "../services/rules.ts";
import { localDate, localHour } from "../time.ts";
import { type BriefLead, type BriefQuietDeal, composeBrief } from "./compose.ts";
import { sendBlocker, sendBrief } from "./send.ts";

const DAY_MS = 86_400_000;

export type BriefRunCounts = { composed: number; sent: number; failed: number };

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

/** Composes and stores today's brief when it is due, then sends it when sending is on. Returns counts only. */
export async function runBrief(env: Env, now: Date): Promise<BriefRunCounts> {
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
  if (blocker !== null) return counts;

  const result = await sendBrief(env, brief, settings);
  await db
    .prepare("UPDATE briefs SET sent_at = ?, send_status = ? WHERE id = ?")
    .bind(result.sent ? at : null, result.sent ? "sent" : result.reason, id)
    .run();
  if (result.sent) counts.sent = 1;
  else counts.failed = 1;
  return counts;
}
