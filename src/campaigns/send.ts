// The campaign cron's job (design, "Sending"). Hard rule 5 is the point of this file: nobody gets the same campaign email
// twice, on retry, pause or resume. Three things hold that:
//   1. Rows are claimed for a batch in one atomic statement set, and a batch is sent under its own id as Resend's
//      Idempotency-Key, with a payload rebuilt byte for byte from the frozen rows.
//   2. Only an answer that proves nothing was sent (resend.ts: "returned") puts rows back in the queue. Any answer that
//      might have sent something is retried with the same key, or ends as "uncertain" and is never sent again.
//   3. Every state change of a batch is conditional on the batch still being in_flight, so two overlapping runs can't
//      both resolve it.
// Reads go in one db.batch; a run makes a handful of D1 calls (a test holds it to 12). Nothing here logs: runScheduled
// logs the counts, which are numbers only.
import type { CampaignBatchRow, CampaignRecipientRow, CampaignRow, CampaignStepRow, Db, SettingsRow } from "../db/db.ts";
import type { Env } from "../env.ts";
import { DEFAULT_NAME } from "../board/layout.ts";
import { newId } from "../ids.ts";
import { type ChangeInput, commitChange, type Ctx, StaleWriteError, updatedRow } from "../services/change.ts";
import { campaignLabel } from "../services/labels.ts";
import { campaignActivity } from "./activities.ts";
import { recipientSuppression } from "./audience.ts";
import { replyTo, sendingBlocker } from "./readiness.ts";
import { type EmailFrame, renderEmail } from "./render.ts";
import { type ResendEmail, type SendOutcome, sendBatch } from "./resend.ts";

const MAX_PER_BATCH = 100;
const MAX_IN_FLIGHT_PER_RUN = 2;
const MAX_PROMOTIONS_PER_RUN = 3;
const UNCERTAIN_AFTER_MS = 20 * 3_600_000;
const DAY_MS = 86_400_000;
const BULK_OVER = 50;

type Counts = Record<string, number>;
type CampaignWithQueue = CampaignRow & { queued: number };

const MANY = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

/** The UTC day `now` falls in, as the two ISO strings the room count compares to (Resend counts UTC days). */
export function utcDay(now: Date): [start: string, end: string] {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return [new Date(start).toISOString(), new Date(start + DAY_MS).toISOString()];
}

interface Loaded {
  settings: SettingsRow;
  inFlight: CampaignBatchRow[];
  rows: CampaignRecipientRow[];
  campaigns: CampaignWithQueue[];
  /** The campaigns of the batches in flight, however many campaigns there are (the list above is capped). */
  inFlightCampaigns: CampaignWithQueue[];
  steps: CampaignStepRow[];
  usedToday: number;
}

const CAMPAIGN_SET = "c.status = 'sending' OR (c.status = 'scheduled' AND c.send_after <= ?)";
const IN_FLIGHT = `SELECT id FROM campaign_batches WHERE kind = 'send' AND status = 'in_flight' ORDER BY created_at, id LIMIT ${MAX_IN_FLIGHT_PER_RUN}`;
const IN_FLIGHT_CAMPAIGNS = `SELECT campaign_id FROM campaign_batches WHERE id IN (${IN_FLIGHT})`;

/** Everything the run reads, in one D1 call. */
async function load(db: Db, now: Date): Promise<Loaded> {
  const [dayStart, dayEnd] = utcDay(now);
  const at = now.toISOString();
  const results = await db.batch<unknown>([
    db.prepare("SELECT * FROM settings WHERE id = 1"),
    db.prepare(`SELECT * FROM campaign_batches WHERE id IN (${IN_FLIGHT}) ORDER BY created_at, id`),
    db.prepare(`SELECT * FROM campaign_recipients WHERE batch_id IN (${IN_FLIGHT}) AND status = 'sending' ORDER BY id`),
    db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'queued') AS queued ` +
          `FROM campaigns c WHERE ${CAMPAIGN_SET} ORDER BY c.approved_at, c.id LIMIT 50`,
      )
      .bind(at),
    db
      .prepare(`SELECT * FROM campaign_steps WHERE position = 1 AND (campaign_id IN (SELECT c.id FROM campaigns c WHERE ${CAMPAIGN_SET}) OR campaign_id IN (${IN_FLIGHT_CAMPAIGNS}))`)
      .bind(at),
    db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM campaign_recipients WHERE claimed_at >= ? AND claimed_at < ?) + " +
          "(SELECT COUNT(*) FROM campaign_batches WHERE kind = 'test' AND created_at >= ? AND created_at < ?) AS used",
      )
      .bind(dayStart, dayEnd, dayStart, dayEnd),
    db.prepare(`SELECT c.*, 0 AS queued FROM campaigns c WHERE c.id IN (${IN_FLIGHT_CAMPAIGNS})`),
  ]);
  const rowsOf = <T>(i: number): T[] => (results[i]?.results ?? []) as T[];
  const settings = rowsOf<SettingsRow>(0)[0];
  if (settings === undefined) throw new Error("The settings row is missing. Load seed/defaults.sql into the database.");
  return {
    settings,
    inFlight: rowsOf<CampaignBatchRow>(1),
    rows: rowsOf<CampaignRecipientRow>(2),
    campaigns: rowsOf<CampaignWithQueue>(3),
    inFlightCampaigns: rowsOf<CampaignWithQueue>(6),
    steps: rowsOf<CampaignStepRow>(4),
    usedToday: rowsOf<{ used: number }>(5)[0]?.used ?? 0,
  };
}

/** The row as the campaigns table holds it (the read adds a `queued` count). */
function campaignRow(campaign: CampaignWithQueue): CampaignRow {
  const row: Partial<CampaignWithQueue> = { ...campaign };
  delete row.queued;
  return row as CampaignRow;
}

/** Marks the campaign sent when no one is left queued or being sent. Conditional, so it is safe in any batch. */
const completeIfDone = (db: Db, campaignId: string, now: Date) =>
  db
    .prepare(
      "UPDATE campaigns SET status = 'sent', completed_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND status = 'sending' " +
        "AND NOT EXISTS (SELECT 1 FROM campaign_recipients WHERE campaign_id = ? AND status IN ('queued', 'sending'))",
    )
    .bind(now.toISOString(), now.toISOString(), campaignId, campaignId);

interface Sender {
  env: Env;
  db: Db;
  now: Date;
  settings: SettingsRow;
  counts: Counts;
}

const bump = (counts: Counts, key: string, by = 1) => {
  counts[key] = (counts[key] ?? 0) + by;
};

function payload(sender: Sender, rows: CampaignRecipientRow[], campaign: CampaignRow, step: CampaignStepRow): ResendEmail[] {
  const { env, settings } = sender;
  const from = env.CAMPAIGN_FROM;
  const reply = replyTo(env, settings);
  if (campaign.base_url === null || from === undefined || reply === null) throw new Error("A campaign is missing what it needs to send.");
  const frame: EmailFrame = {
    business: settings.business_name ?? DEFAULT_NAME,
    postal: settings.postal_address ?? "",
    baseUrl: campaign.base_url,
    fallback: campaign.first_name_fallback,
    accent: settings.accent_color ?? "",
  };
  const base = campaign.base_url.replace(/\/$/, "");
  return rows.map((row) => {
    if (row.unsub_token === null) throw new Error("A campaign row to send has no unsubscribe token.");
    const email = renderEmail(step, { firstName: row.first_name, token: row.unsub_token }, frame);
    return {
      from,
      to: [row.email],
      reply_to: reply,
      subject: email.subject,
      html: email.html,
      text: email.text,
      headers: { "List-Unsubscribe": `<${base}/unsubscribe/${row.unsub_token}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      tags: [{ name: "campaign", value: campaign.id }],
    };
  });
}

/**
 * The rows go back to the queue, only while the batch is still in_flight and on its first attempt: once another run has
 * taken it over to send it again, the first attempt may have been accepted, so its answer must not undo anything.
 */
const returnRows = (db: Db, batchId: string): D1PreparedStatement[] => [
  db
    .prepare(
      "UPDATE campaign_recipients SET status = 'queued', batch_id = NULL, claimed_at = NULL, version = version + 1 " +
        "WHERE batch_id = ? AND status = 'sending' AND EXISTS (SELECT 1 FROM campaign_batches WHERE id = ? AND status = 'in_flight' AND attempts = 1)",
    )
    .bind(batchId, batchId),
];

const closeBatch = (db: Db, batchId: string, status: "returned" | "uncertain", lastStatus: string, firstAttemptOnly = false) =>
  db
    .prepare(`UPDATE campaign_batches SET status = ?, last_status = ? WHERE id = ? AND status = 'in_flight'${firstAttemptOnly ? " AND attempts = 1" : ""}`)
    .bind(status, lastStatus, batchId);

/** Rows `uncertain` (never sent again) and the batch with them, as statements. */
function uncertainStatements(sender: Sender, batch: CampaignBatchRow, lastStatus: string): D1PreparedStatement[] {
  const { db, now } = sender;
  return [
    db
      .prepare(
        "UPDATE campaign_recipients SET status = 'uncertain', version = version + 1 " +
          "WHERE batch_id = ? AND status = 'sending' AND EXISTS (SELECT 1 FROM campaign_batches WHERE id = ? AND status = 'in_flight')",
      )
      .bind(batch.id, batch.id),
    closeBatch(db, batch.id, "uncertain", lastStatus),
    completeIfDone(db, batch.campaign_id, now),
  ];
}

async function markUncertain(sender: Sender, batch: CampaignBatchRow, lastStatus: string): Promise<void> {
  await sender.db.batch(uncertainStatements(sender, batch, lastStatus));
  bump(sender.counts, "uncertain");
}

async function markSent(
  sender: Sender,
  batch: CampaignBatchRow,
  rows: CampaignRecipientRow[],
  ids: string[],
  campaign: CampaignRow,
): Promise<void> {
  const { db, now } = sender;
  const at = now.toISOString();
  const ctx: Ctx = { db, now, actor: "system", tool: "campaign_send" };
  const sent = JSON.stringify(rows.map((row, i) => ({ id: row.id, r: ids[i] })));
  const changes = rows.map((row) => {
    const activity = campaignActivity(row.contact_id, campaign, now);
    return { table: "activities" as const, id: activity.id, before: null, after: activity };
  });
  const input: ChangeInput = {
    target: { table: "campaigns", id: campaign.id },
    summary: `Sent ${campaignLabel(campaign.id)} to ${MANY(rows.length)}`,
    changes,
    leading: [
      db.prepare("INSERT INTO write_guard (ok) SELECT COUNT(*) = 1 FROM campaign_batches WHERE id = ? AND status = 'in_flight'").bind(batch.id),
    ],
    extra: [
      db
        .prepare(
          "UPDATE campaign_recipients SET status = 'sent', resend_id = json_extract(j.value, '$.r'), sent_at = ?, version = version + 1 " +
            "FROM json_each(?) AS j WHERE campaign_recipients.id = json_extract(j.value, '$.id') AND campaign_recipients.batch_id = ? AND campaign_recipients.status = 'sending'",
        )
        .bind(at, sent, batch.id),
      db.prepare("UPDATE campaign_batches SET status = 'done', last_status = '200' WHERE id = ?").bind(batch.id),
      completeIfDone(db, campaign.id, now),
    ],
    bulk: rows.length > BULK_OVER,
  };
  try {
    await commitChange(ctx, input);
    bump(sender.counts, "sent", rows.length);
  } catch (error) {
    // Another run resolved this batch first: it wrote the activities and the rows, so there is nothing left to do.
    if (!(error instanceof StaleWriteError)) throw error;
    bump(sender.counts, "stale");
  }
}

/** Sends the batch and settles it by what Resend answered. Returns true when the run may go on (the batch ended). */
async function deliver(
  sender: Sender,
  batch: CampaignBatchRow,
  attempts: number,
  rows: CampaignRecipientRow[],
  campaign: CampaignWithQueue,
  step: CampaignStepRow,
): Promise<boolean> {
  const { env, db, now } = sender;
  const apiKey = env.CAMPAIGN_RESEND_API_KEY;
  if (apiKey === undefined) throw new Error("The Resend key is missing.");
  const outcome: SendOutcome = await sendBatch(apiKey, payload(sender, rows, campaignRow(campaign), step), batch.id);
  switch (outcome.kind) {
    case "sent":
      await markSent(sender, batch, rows, outcome.ids, campaignRow(campaign));
      return true;
    case "retry_later":
      await db.prepare("UPDATE campaign_batches SET last_status = ? WHERE id = ? AND status = 'in_flight'").bind(outcome.status, batch.id).run();
      bump(sender.counts, "retry_later");
      return false;
    case "uncertain":
      await markUncertain(sender, batch, outcome.status);
      return true;
    case "returned": {
      // "Nothing was sent" is only true of a first attempt. A resend may follow one that Resend accepted, and a refusal
      // before its idempotency lookup (a rotated key, a 429) says nothing about that: the rows must never be queued again.
      const first = attempts === 1;
      if (!first && !outcome.pause) {
        await db.prepare("UPDATE campaign_batches SET last_status = ? WHERE id = ? AND status = 'in_flight'").bind(outcome.status, batch.id).run();
        bump(sender.counts, "retry_later");
        return false;
      }
      const settle = first
        ? [...returnRows(db, batch.id), closeBatch(db, batch.id, "returned", outcome.status, true)]
        : uncertainStatements(sender, batch, outcome.status);
      bump(sender.counts, first ? "returned" : "uncertain");
      if (!outcome.pause || campaign.status !== "sending") {
        await db.batch(settle);
        return false;
      }
      const ctx: Ctx = { db, now, actor: "system", tool: "campaign_send" };
      const before = campaignRow(campaign);
      const send_error = first
        ? `Resend refused the last batch (status ${outcome.status}). Nothing in it was sent. Resume to try again.`
        : `Resend refused a retry of the last batch (status ${outcome.status}). It may have been sent, so it will not be sent again. Resume to continue with the rest.`;
      try {
        await commitChange(ctx, {
          target: { table: "campaigns", id: campaign.id },
          summary: `Paused ${campaignLabel(campaign.id)}: Resend refused a batch`,
          changes: [{ table: "campaigns", id: campaign.id, before, after: updatedRow(before, { status: "paused", send_error }, now) }],
          extra: settle,
        });
        bump(sender.counts, "paused");
      } catch (error) {
        // The owner changed the campaign meanwhile: still settle the rows, and leave the campaign as they left it.
        if (!(error instanceof StaleWriteError)) throw error;
        await db.batch(settle);
      }
      return false;
    }
  }
}

/** Step 2: batches already handed to Resend. Over 20 hours old they become uncertain; younger ones are sent again. */
async function resolveInFlight(sender: Sender, loaded: Loaded): Promise<boolean> {
  for (const batch of loaded.inFlight) {
    const rows = loaded.rows.filter((row) => row.batch_id === batch.id);
    const campaign = loaded.inFlightCampaigns.find((c) => c.id === batch.campaign_id);
    const step = loaded.steps.find((s) => s.campaign_id === batch.campaign_id);
    const attempts = batch.attempts + 1;
    if (Date.parse(batch.created_at) + UNCERTAIN_AFTER_MS < sender.now.getTime()) {
      await markUncertain(sender, batch, "over 20 hours");
      bump(sender.counts, "expired");
      continue;
    }
    if (rows.length === 0 || campaign === undefined || step === undefined) {
      await markUncertain(sender, batch, "no rows");
      continue;
    }
    // Take the batch over before sending it again: if another run already did, it is theirs this time.
    const took = await sender.db
      .prepare("UPDATE campaign_batches SET attempts = attempts + 1 WHERE id = ? AND attempts = ? AND status = 'in_flight'")
      .bind(batch.id, batch.attempts)
      .run();
    if (!(took.meta.changes > 0)) continue;
    bump(sender.counts, "resent");
    if (!(await deliver(sender, batch, attempts, rows, campaign, step))) return false;
  }
  return true;
}

/** Step 3: a scheduled campaign whose time has come starts sending. Returns the campaigns as they are now. */
async function promote(sender: Sender, campaigns: CampaignWithQueue[]): Promise<CampaignWithQueue[]> {
  const ctx: Ctx = { db: sender.db, now: sender.now, actor: "system", tool: "campaign_send" };
  let promoted = 0;
  const result: CampaignWithQueue[] = [];
  for (const campaign of campaigns) {
    if (campaign.status !== "scheduled" || promoted >= MAX_PROMOTIONS_PER_RUN) {
      result.push(campaign);
      continue;
    }
    const before = campaignRow(campaign);
    const after = updatedRow(before, { status: "sending" }, sender.now);
    try {
      await commitChange(ctx, {
        target: { table: "campaigns", id: campaign.id },
        summary: `Started sending ${campaignLabel(campaign.id)}`,
        changes: [{ table: "campaigns", id: campaign.id, before, after }],
      });
      promoted += 1;
      bump(sender.counts, "promoted");
      result.push({ ...after, queued: campaign.queued });
    } catch (error) {
      if (!(error instanceof StaleWriteError)) throw error;
      bump(sender.counts, "stale");
      result.push(campaign);
    }
  }
  return result;
}

/**
 * Step 5, one atomic batch: skip the people who were archived or suppressed since approval, create the batch and claim
 * up to the day's room (worked out inside the claim, so overlapping runs can't both spend it) of queued rows for it, close the campaign if nothing is left, and read the claimed rows. A batch row exists
 * only if there was something to claim, and the claim names it, so two overlapping runs claim different rows.
 */
async function claim(sender: Sender, campaign: CampaignRow): Promise<{ batch: CampaignBatchRow; rows: CampaignRecipientRow[] } | null> {
  const { db, now } = sender;
  const id = newId("cb");
  const at = now.toISOString();
  const suppression = recipientSuppression("campaign_recipients");
  const queued = "campaign_id = ? AND status = 'queued'";
  const [dayStart, dayEnd] = utcDay(now);
  // The day's room as SQL, with its bound values: the limit less rows claimed today and today's test sends, at most one batch.
  const room = {
    sql:
      `MAX(0, MIN(${MAX_PER_BATCH}, ? - (SELECT COUNT(*) FROM campaign_recipients WHERE claimed_at >= ? AND claimed_at < ?) - ` +
      "(SELECT COUNT(*) FROM campaign_batches WHERE kind = 'test' AND created_at >= ? AND created_at < ?)))",
    params: [sender.settings.campaign_daily_limit, dayStart, dayEnd, dayStart, dayEnd],
  };
  const results = await db.batch<unknown>([
    db
      .prepare(
        "UPDATE campaign_recipients SET status = 'skipped', skip_reason = 'archived', unsub_token = NULL, version = version + 1 " +
          `WHERE ${queued} AND contact_id IN (SELECT id FROM contacts WHERE archived = 1)`,
      )
      .bind(campaign.id),
    db
      .prepare(
        `UPDATE campaign_recipients SET status = 'skipped', skip_reason = ${suppression.reason}, unsub_token = NULL, version = version + 1 ` +
          `WHERE ${queued} AND ${suppression.applies}`,
      )
      .bind(campaign.id),
    db
      .prepare(
        "INSERT INTO campaign_batches (id, campaign_id, kind, status, created_at, attempts) SELECT ?, ?, 'send', 'in_flight', ?, 1 " +
          `WHERE EXISTS (SELECT 1 FROM campaigns WHERE id = ? AND status = 'sending') AND EXISTS (SELECT 1 FROM campaign_recipients WHERE ${queued} AND unsub_token IS NOT NULL) AND (${room.sql}) > 0`,
      )
      .bind(id, campaign.id, at, campaign.id, campaign.id, ...room.params),
    db
      .prepare(
        "UPDATE campaign_recipients SET status = 'sending', batch_id = ?, claimed_at = ?, version = version + 1 " +
          `WHERE id IN (SELECT id FROM campaign_recipients WHERE ${queued} AND unsub_token IS NOT NULL ORDER BY id LIMIT (${room.sql})) ` +
          "AND EXISTS (SELECT 1 FROM campaign_batches WHERE id = ?)",
      )
      .bind(id, at, campaign.id, ...room.params, id),
    completeIfDone(db, campaign.id, now),
    db.prepare("SELECT * FROM campaign_batches WHERE id = ?").bind(id),
    db.prepare("SELECT * FROM campaign_recipients WHERE batch_id = ? ORDER BY id").bind(id),
  ]);
  const batch = (results[5]?.results as CampaignBatchRow[] | undefined)?.[0];
  const rows = (results[6]?.results ?? []) as CampaignRecipientRow[];
  return batch === undefined || rows.length === 0 ? null : { batch, rows };
}

/**
 * The campaign cron's one job. Returns counts (numbers only) for the log line. A pause, a cancel or campaigns turned off
 * stops new batches but never a batch already handed to Resend (ruling 7).
 */
export async function runCampaigns(env: Env, now: Date): Promise<Counts> {
  const db = env.DB;
  const loaded = await load(db, now);
  const { settings } = loaded;
  if (settings.campaigns !== 1 || sendingBlocker(env, settings) !== null) return { skipped: 1 };
  const counts: Counts = {};
  const sender: Sender = { env, db, now, settings, counts };

  if (!(await resolveInFlight(sender, loaded))) return counts;

  const campaigns = await promote(sender, loaded.campaigns);
  const room = Math.min(MAX_PER_BATCH, settings.campaign_daily_limit - loaded.usedToday);
  if (room <= 0) {
    counts.no_room = 1;
    return counts;
  }
  const target = campaigns.find((campaign) => campaign.status === "sending" && campaign.queued > 0);
  const step = target === undefined ? undefined : loaded.steps.find((s) => s.campaign_id === target.id);
  if (target === undefined || step === undefined) return counts;

  const claimed = await claim(sender, campaignRow(target));
  if (claimed === null) return counts;
  bump(counts, "claimed", claimed.rows.length);
  await deliver(sender, claimed.batch, 1, claimed.rows, target, step);
  return counts;
}
