// "Send test to me": one email to the signed-in owner, with "Test: " before the subject and an unsubscribe link that
// changes nothing. A test counts against the day's sending room and against 10 tests a UTC day. It writes no audit
// change (no record changes); its `campaign_batches` row of kind `test` is the record, and the cron never picks it up
// (it only resolves kind `send`), so a test is never sent twice.
import { DEFAULT_NAME } from "../board/layout.ts";
import type { CampaignRow, CampaignStepRow, Db, SettingsRow } from "../db/db.ts";
import { newId } from "../ids.ts";
import { type CampaignEnv, replyTo, sendingBlocker } from "./readiness.ts";
import { utcDay } from "./send.ts";
import { renderEmail } from "./render.ts";
import { type ResendEmail, type SendOutcome, sendOne } from "./resend.ts";

const MAX_TESTS_PER_DAY = 10;

export type TestSendResult = { ok: true } | { ok: false; message: string };

async function usedToday(db: Db, now: Date): Promise<{ tests: number; claimed: number }> {
  const [start, end] = utcDay(now);
  const row = await db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM campaign_batches WHERE kind = 'test' AND created_at >= ? AND created_at < ?) AS tests, " +
        "(SELECT COUNT(*) FROM campaign_recipients WHERE claimed_at >= ? AND claimed_at < ?) AS claimed",
    )
    .bind(start, end, start, end)
    .first<{ tests: number; claimed: number }>();
  return { tests: row?.tests ?? 0, claimed: row?.claimed ?? 0 };
}

const settle = (db: Db, id: string, outcome: SendOutcome) => {
  if (outcome.kind === "sent") return db.prepare("UPDATE campaign_batches SET status = 'done', last_status = '200' WHERE id = ?").bind(id).run();
  if (outcome.kind === "retry_later") return db.prepare("UPDATE campaign_batches SET last_status = ? WHERE id = ?").bind(outcome.status, id).run();
  const status = outcome.kind === "returned" ? "returned" : "uncertain";
  return db.prepare("UPDATE campaign_batches SET status = ?, last_status = ? WHERE id = ?").bind(status, outcome.status, id).run();
};

export async function sendTestEmail(
  env: CampaignEnv,
  db: Db,
  now: Date,
  input: { campaign: CampaignRow; step: CampaignStepRow; settings: SettingsRow; to: string; baseUrl: string },
  fetchImpl: typeof fetch = fetch,
): Promise<TestSendResult> {
  const { campaign, step, settings, to, baseUrl } = input;
  const blocker = sendingBlocker(env, settings);
  if (blocker !== null) return { ok: false, message: blocker };
  const used = await usedToday(db, now);
  if (used.tests >= MAX_TESTS_PER_DAY) return { ok: false, message: "You've sent 10 tests today. Try again tomorrow." };
  if (settings.campaign_daily_limit - used.claimed - used.tests <= 0) return { ok: false, message: "Today's sending limit is used up. Try again tomorrow." };
  const from = env.CAMPAIGN_FROM;
  const reply = replyTo(env, settings);
  const apiKey = env.CAMPAIGN_RESEND_API_KEY;
  if (from === undefined || reply === null || apiKey === undefined) return { ok: false, message: "Sending isn't set up for this copy yet." };

  const email = renderEmail(
    step,
    { firstName: null, token: "test" },
    { business: settings.business_name ?? DEFAULT_NAME, postal: settings.postal_address ?? "", baseUrl, fallback: campaign.first_name_fallback, accent: settings.accent_color ?? "" },
  );
  const payload: ResendEmail = {
    from,
    to: [to],
    reply_to: reply,
    subject: `Test: ${email.subject}`,
    html: email.html,
    text: email.text,
    headers: { "List-Unsubscribe": `<${baseUrl.replace(/\/$/, "")}/unsubscribe/test>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    tags: [{ name: "campaign", value: campaign.id }],
  };
  const id = newId("cb");
  await db
    .prepare("INSERT INTO campaign_batches (id, campaign_id, kind, status, created_at, attempts) VALUES (?, ?, 'test', 'in_flight', ?, 1)")
    .bind(id, campaign.id, now.toISOString())
    .run();
  const outcome = await sendOne(apiKey, payload, id, fetchImpl);
  await settle(db, id, outcome);
  if (outcome.kind === "sent") return { ok: true };
  return { ok: false, message: `The test didn't go out (${outcome.status}). Try again in a minute.` };
}
