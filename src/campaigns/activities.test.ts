import assert from "node:assert/strict";
import { test } from "node:test";
import { openTestDb } from "../db/sqlite-d1.ts";
import { isReach } from "../services/lead-change.ts";
import { listLeads, leadCounts } from "../services/leads-read.ts";
import { addLead } from "../services/leads.ts";
import { addRule, previewRuleFor, runRules } from "../services/rules.ts";
import { campaignActivity } from "./activities.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const campaign = { id: "cp_test01", name: "Autumn news" };

test("campaignActivity is a system email on the person with no deal and the campaign in its data", () => {
  const row = campaignActivity("ct_one", campaign, NOW);
  assert.match(row.id, /^ac_[a-z0-9]+$/);
  assert.equal(row.type, "email");
  assert.equal(row.contact_id, "ct_one");
  assert.equal(row.deal_id, null, "no deal, so no deal's last_activity_at can move");
  assert.equal(row.summary, "Campaign: Autumn news");
  assert.equal(row.untrusted_text, null);
  assert.equal(row.data, '{"via":"campaign","campaign":"cp_test01"}');
  assert.equal(row.occurred_at, NOW.toISOString());
  assert.equal(row.actor, "system");
  assert.equal(row.version, 1);
  assert.equal(row.created_at, NOW.toISOString());
});

test("campaignActivity keeps a long name inside 200 characters", () => {
  const row = campaignActivity("ct_one", { id: "cp_test01", name: "x".repeat(500) }, NOW);
  assert.equal(row.summary.length, 200);
  assert.ok(row.summary.startsWith("Campaign: xxx"));
});

test("a campaign email does not reach the person; a plain email does", () => {
  const { type, data } = campaignActivity("ct_one", campaign, NOW);
  assert.equal(isReach(type, data), false);
  assert.equal(isReach("email", null), true);
  assert.equal(isReach("email", '{"via":"other"}'), true);
});

async function insert(db: Awaited<ReturnType<typeof openTestDb>>, contactId: string, at: Date): Promise<void> {
  const a = campaignActivity(contactId, campaign, at);
  await db
    .prepare("INSERT INTO activities (id, deal_id, contact_id, type, summary, untrusted_text, data, occurred_at, actor, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(a.id, a.deal_id, a.contact_id, a.type, a.summary, a.untrusted_text, a.data, a.occurred_at, a.actor, a.version, a.created_at)
    .run();
}

test("a New lead with only a campaign email stays New, uncontacted and caught by lead_followup", async () => {
  const db = await openTestDb();
  const { contactId } = await addLead({ db, now: NOW, actor: "owner", tool: "add_lead" }, { name: "Pat Example" });
  await insert(db, contactId, day(1));
  await addRule({ db, now: NOW, actor: "owner", tool: "add_rule" }, { type: "lead_followup", status: "new", days: 2 });

  const preview = await previewRuleFor(db, day(2), { type: "lead_followup", status: "new", days: 1 });
  assert.deepEqual(preview.hits.map((hit) => hit.contactId), [contactId]);
  assert.equal((await runRules(db, day(3))).fired, 1);

  const list = await listLeads(db, day(3), "America/Los_Angeles");
  assert.equal(list.items[0]?.leadStatus, "new");
  assert.equal(list.items[0]?.lastContactAt, null);
  assert.equal((await leadCounts(db)).new, 1);
});

test("a campaign email on the person does not reset a deal's stage_followup preview", async () => {
  const db = await openTestDb();
  const { addDeal } = await import("../services/add-deal.ts");
  const { updateDeal } = await import("../services/deals.ts");
  const made = await addDeal({ db, now: day(-10), actor: "owner", tool: "add_deal" }, { name: "Sam Example", dealTitle: "Site" });
  await updateDeal({ db, now: day(-10), actor: "owner", tool: "update_deal" }, made.dealId, { stage: "proposal_sent" });
  const contact = await db.prepare("SELECT contact_id AS id FROM deals WHERE id = ?").bind(made.dealId).first<{ id: string }>();
  const settings = { type: "stage_followup", stage: "Proposal sent", days: 3 } as const;
  const before = await previewRuleFor(db, NOW, settings);
  assert.equal(before.hits.length, 1);
  await insert(db, contact?.id ?? "", day(-9));
  const after = await previewRuleFor(db, NOW, settings);
  assert.deepEqual(after.hits, before.hits);
});
