// The free plan allows 50 D1 calls per Worker invocation (docs/PAID-PLAN.md, "Run 8: campaigns"). Approving a campaign
// of the most people it may have (2,000) works the list out again and writes one row each: the whole request must stay
// at most 12 calls, and no statement may bind more than CHUNK_BYTES of JSON.
import assert from "node:assert/strict";
import { test } from "node:test";
import { countingDb } from "../../tests/helpers/counting-db.ts";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import { SqliteStatement } from "../db/sqlite-d1.ts";
import { CHUNK_BYTES, sqlBytes } from "../services/bulk.ts";
import { MAX_AUDIENCE, parseAudience, resolveAudience } from "./audience.ts";
import { addCampaignDraft } from "./drafts.ts";
import { approveCampaign, fingerprint } from "./freeze.ts";

const NOW = new Date("2026-11-24T18:00:00.000Z");
const MAX_CALLS = 12;

test("approving a 2,000-person campaign stays within 12 D1 calls and chunked statements", async (t) => {
  const raw = await timeDb(NOW);
  raw.exec("UPDATE settings SET campaigns = 1");
  const rows = Array.from({ length: MAX_AUDIENCE }, (_, n) => `('ct_big${n}', 'Big${n} Example', 'big${n}@example.com', 'partner')`);
  raw.exec(`INSERT INTO contacts (id, name, email, person_status) VALUES ${rows.join(", ")};`);
  // Some skipped, so both kinds of row are written.
  raw.exec("UPDATE contacts SET email = NULL WHERE id LIKE 'ct_big1%0'");
  raw.exec("INSERT INTO email_suppressions (id, email, reason) SELECT 'su_' || id, email, 'bounced' FROM contacts WHERE id LIKE 'ct_big2%5'");
  const added = await addCampaignDraft(
    { db: raw, now: NOW, actor: "ai", tool: "add_campaign_draft" },
    { name: "Everyone", recipients: { kind: "status", status: "partner" }, subject: "Hello {{first_name}}", body: "News inside." },
  );
  const db = countingDb(raw);
  const campaign = await db.prepare("SELECT * FROM campaigns WHERE id = ?").bind(added.campaignId).first<never>();
  const step = await db.prepare("SELECT * FROM campaign_steps WHERE campaign_id = ?").bind(added.campaignId).first<never>();
  assert.ok(campaign && step);

  db.reset();
  const resolved = await resolveAudience(db, NOW, parseAudience((campaign as { audience: string }).audience));
  const resolveCalls = db.calls;
  const print = await fingerprint(campaign, step, resolved);

  const bound: string[] = [];
  const realBind = SqliteStatement.prototype.bind;
  SqliteStatement.prototype.bind = function (this: SqliteStatement, ...values: unknown[]) {
    for (const value of values) if (typeof value === "string" && value.length > 1000) bound.push(value);
    return realBind.apply(this, values);
  };
  db.reset();
  const started = performance.now();
  try {
    await approveCampaign({ db, now: NOW, actor: "owner", tool: "campaign_approve" }, added.campaignId, {
      fingerprint: print,
      sendAfter: NOW,
      baseUrl: "https://board.example.com",
      scheduled: false,
    });
  } finally {
    SqliteStatement.prototype.bind = realBind;
  }
  const millis = performance.now() - started;
  const batch = db.log.at(-1) ?? "";
  t.diagnostic(`resolve alone: ${resolveCalls} calls; approve: ${db.calls} calls; ${batch}; ${bound.length} JSON chunks; ${millis.toFixed(0)} ms in Node`);

  assert.ok(db.calls <= MAX_CALLS, `approve made ${db.calls} D1 calls: ${db.log.join(" | ")}`);
  assert.equal(
    await db.prepare("SELECT COUNT(*) AS n FROM campaign_recipients WHERE campaign_id = ?").bind(added.campaignId).first<number>("n"),
    MAX_AUDIENCE,
  );
  assert.ok(bound.length >= 1);
  for (const json of bound) assert.ok(sqlBytes(json) <= CHUNK_BYTES, `a statement binds ${sqlBytes(json)} bytes of JSON`);
});
