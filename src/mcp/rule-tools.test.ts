import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDevSeed } from "../../scripts/seed-dev.ts";
import { CHANGE_LINE, connectInMemory, fails, ok } from "../../tests/helpers/mcp-client.ts";
import { createTestDb, openTestDb } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import { createMcpServer } from "./server.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");

async function setup(seeded = true) {
  const db = seeded ? await createTestDb() : null;
  db?.exec(buildDevSeed(NOW, DEFAULT_TZ));
  const database = db ?? (await openTestDb());
  return { db: database, c: await connectInMemory(createMcpServer({ db: database, now: () => NOW })) };
}

type RuleItem = { id: string; type: string; description: string; active: boolean; stageLabel: string | null; timesFired: number };
type Preview = { ruleId: string | null; description: string; hits: { dealId: string; label: string; wouldFireAt: string }[]; dealCount: number };

test("preview_rule shows what a new rule would have caught, then add_rule adds it (spec sentence 10)", async () => {
  const { db, c } = await setup();
  const audit = async () => (await db.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>())?.n;
  const before = await audit();
  const preview = await ok(c, "preview_rule", { type: "stage_followup", stage: "Proposal sent", days: 3 });
  assert.equal(preview.headline, "This rule would have caught 1 deal in the last 30 days (1 time). Nothing was changed.");
  const data = preview.data as Preview;
  assert.equal(data.ruleId, null);
  assert.deepEqual(data.hits.map((h) => [h.dealId, h.label]), [["dl_seed05", '"Cafe website and menu" (Taylor Testcase)']]);
  assert.equal(await audit(), before);

  const added = await ok(c, "add_rule", { type: "stage_followup", stage: "Proposal sent", days: 3 });
  assert.match(added.headline, /^Added rule ru_[a-z2-7]{12}: When a deal has sat in Proposal sent for 3 days with no contact logged, add a follow-up task\./);
  assert.match(added.headline, CHANGE_LINE);
  const { ruleId } = added.data as { ruleId: string; changeId: string };

  const saved = await ok(c, "preview_rule", { rule: ruleId });
  assert.equal((saved.data as Preview).ruleId, ruleId);
  assert.equal((saved.data as Preview).dealCount, 1);
});

test("list_rules lists every rule with its description, state and stage label", async () => {
  const { c } = await setup();
  const answer = await ok(c, "list_rules");
  assert.equal(answer.headline, "2 rules: 1 active, 1 paused.");
  const { rules } = answer.data as { rules: RuleItem[] };
  assert.deepEqual(rules.map((r) => [r.id, r.type, r.active, r.stageLabel]), [
    ["ru_seed01", "gone_quiet", true, null],
    ["ru_seed02", "stage_followup", false, "Call done"],
  ]);
  const empty = await setup(false);
  assert.equal((await ok(empty.c, "list_rules")).headline, "There are no rules yet. Preview one with preview_rule, then add it with add_rule.");
});

test("update_rule, pause_rule and resume_rule answer one line with the change id and refuse no-ops", async () => {
  const { c } = await setup();
  const updated = await ok(c, "update_rule", { rule: "ru_seed02", days: 4 });
  assert.match(updated.headline, /^Updated rule ru_seed02: days; now: When a deal has sat in Call done for 4 days with no contact logged, add the task "Follow up with \{contact\}"\. \(change chg_[a-z0-9]{12}\)$/);
  const resumed = await ok(c, "resume_rule", { rule: "ru_seed02" });
  assert.match(resumed.headline, /^Resumed rule ru_seed02: /);
  assert.match(await fails(c, "resume_rule", { rule: "ru_seed02" }), /^Rule ru_seed02 is already active\. Pause it with pause_rule\.$/);
  const paused = await ok(c, "pause_rule", { rule: "ru_seed02" });
  assert.match(paused.headline, CHANGE_LINE);
  const { changeId } = paused.data as { changeId: string };
  await ok(c, "undo_change", { changeId });
  const { rules } = (await ok(c, "list_rules")).data as { rules: RuleItem[] };
  assert.equal(rules.find((r) => r.id === "ru_seed02")?.active, true);
});

test("rule tools refuse bad input in plain English", async () => {
  const { c } = await setup();
  assert.match(await fails(c, "add_rule", { type: "sometimes", days: 3 }), /"type" must be one of: stage_followup, on_stage_enter, gone_quiet/);
  assert.match(await fails(c, "add_rule", { type: "gone_quiet", days: 0 }), /^Fix the rule: "days" must be a whole number of days from 1 to 365\./);
  assert.match(await fails(c, "add_rule", { type: "stage_followup", stage: "Won", days: 3 }), /^Rules only watch open deals/);
  assert.match(await fails(c, "add_rule", { type: "stage_followup", stage: "Nope", days: 3 }), /^There's no stage "Nope"\. Stages: New inquiry/);
  assert.match(await fails(c, "preview_rule", {}), /^Give a rule id \(ru_\.\.\.\) to preview a saved rule/);
  assert.match(await fails(c, "update_rule", { rule: "ru_seed01", stage: "Replied" }), /A gone_quiet rule doesn't take "stage"/);
  assert.match(await fails(c, "pause_rule", { rule: "ru_nope" }), /^There's no rule "ru_nope"/);
});

test("preview_rule's headline for a rule that would have caught nothing", async () => {
  const { c } = await setup();
  const answer = await ok(c, "preview_rule", { type: "on_stage_enter", stage: "Call done", title: "Send notes", dueInDays: 1 });
  assert.match(answer.headline, /^This rule would have caught 1 deal/);
  const none = await ok(c, "preview_rule", { type: "stage_followup", stage: "Replied", days: 30 });
  assert.equal(none.headline, "This rule would not have caught any deal in the last 30 days. Nothing was changed.");
});
