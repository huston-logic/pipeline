import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDevSeed } from "../../scripts/seed-dev.ts";
import { racing } from "../../tests/helpers/race-db.ts";
import type { AuditRow, Db, RuleFiringRow, RuleRow, TaskRow } from "../db/db.ts";
import { createTestDb, openTestDb } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import type { Ctx } from "./change.ts";
import { updateDeal } from "./deals.ts";
import { logActivity } from "./activities.ts";
import { addLead } from "./leads.ts";
import { listDealsFiltered } from "./read.ts";
import { addRule, listQuietDeals, listRules, pauseRule, previewRuleFor, resumeRule, runRules, updateRule } from "./rules.ts";
import { archiveStage } from "./stages.ts";
import { undoChange } from "./undo.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const DAY = 86_400_000;
const later = (days: number, from = NOW) => new Date(from.getTime() + days * DAY);
const ctxFor = (db: Db, tool = "add_rule", now = NOW): Ctx => ({ db, now, actor: "ai", tool });

async function seededDb(): Promise<Db> {
  const db = await createTestDb();
  db.exec(buildDevSeed(NOW, DEFAULT_TZ));
  return db;
}

const one = async <T>(db: Db, sql: string, ...params: unknown[]) => {
  const row = await db.prepare(sql).bind(...params).first<T>();
  assert.ok(row, sql);
  return row;
};
const rows = async <T>(db: Db, sql: string, ...params: unknown[]) =>
  (await db.prepare(sql).bind(...params).all<T>()).results;
const countOf = async (db: Db, table: string) =>
  (await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table}`)).n;

/** A lead moved into Proposal sent at `at`. */
async function proposal(db: Db, at: Date, name = "Pat Example") {
  const lead = await addLead(ctxFor(db, "add_lead", at), { name, dealTitle: `${name} website` });
  await updateDeal(ctxFor(db, "update_deal", at), lead.dealId, { stage: "Proposal sent" });
  return lead;
}

test("addRule stores a stage_followup by stage key with a generated description, as one audited change", async () => {
  const db = await openTestDb();
  const result = await addRule(ctxFor(db), { type: "stage_followup", stage: "Proposal sent", days: 3 });
  const description = "When a deal has sat in Proposal sent for 3 days with no contact logged, add a follow-up task.";
  assert.equal(result.summary, `Added rule ${result.ruleId}: ${description} (change ${result.changeId})`);
  const row = await one<RuleRow>(db, "SELECT * FROM rules WHERE id = ?", result.ruleId);
  assert.match(row.id, /^ru_[a-z2-7]{12}$/);
  assert.deepEqual(JSON.parse(row.params), { type: "stage_followup", stage: "proposal_sent", days: 3 });
  assert.equal(row.description, description);
  assert.equal(row.active, 1);
  assert.equal(row.created_by, "ai");
  const audit = await one<AuditRow>(db, "SELECT * FROM audit_log WHERE id = ?", result.changeId);
  assert.equal(audit.target_table, "rules");
  assert.equal(audit.tool, "add_rule");
});

test("addRule keeps the owner's own description and describes the other two types", async () => {
  const db = await openTestDb();
  const own = await addRule(ctxFor(db), { type: "gone_quiet", days: 7, description: "Tell me about quiet deals." });
  assert.equal((await one<RuleRow>(db, "SELECT * FROM rules WHERE id = ?", own.ruleId)).description, "Tell me about quiet deals.");
  const quiet = await addRule(ctxFor(db), { type: "gone_quiet", days: 1 });
  assert.match(quiet.summary, /: Flag any open deal with no contact logged for 1 day in the daily brief\. \(change/);
  const enter = await addRule(ctxFor(db), { type: "on_stage_enter", stage: "call_booked", title: "Prepare for {contact}", dueInDays: 0 });
  assert.match(enter.summary, /: When a deal enters Call booked, add the task "Prepare for \{contact\}", due the same day\. \(change/);
  const custom = await addRule(ctxFor(db), { type: "stage_followup", stage: "replied", days: 2, title: "Nudge {contact}" });
  assert.match(custom.summary, /sat in Replied for 2 days with no contact logged, add the task "Nudge \{contact\}"\./);
});

test("addRule refuses bad parameters in plain English, naming the fix", async () => {
  const db = await openTestDb();
  const refuse = (input: Parameters<typeof addRule>[1], pattern: RegExp) => assert.rejects(addRule(ctxFor(db), input), { message: pattern });
  await refuse({ type: "stage_followup", stage: "Nowhere", days: 3 }, /^There's no stage "Nowhere"\. Stages: New inquiry \(new_inquiry\),.*Use one of those\.$/);
  await refuse({ type: "stage_followup", stage: "won", days: 3 }, /Rules only watch open deals, so a rule can't use Won.*Pick an open stage: New inquiry/);
  await refuse({ type: "stage_followup", stage: "replied", days: 0 }, /^Fix the rule: "days" must be a whole number of days from 1 to 365\./);
  await refuse({ type: "gone_quiet", days: 366 }, /"days" must be a whole number of days from 1 to 365/);
  await refuse({ type: "stage_followup", stage: "replied", days: 1.5 }, /"days" must be a whole number/);
  await refuse({ type: "on_stage_enter", stage: "replied", dueInDays: 1 }, /^Fix the rule: An on_stage_enter rule needs "title" \(the task title/);
  await refuse({ type: "on_stage_enter", stage: "replied", title: "x", dueInDays: -1 }, /"dueInDays" must be a whole number of days from 0 to 365/);
  await refuse({ type: "gone_quiet", days: 5, stage: "replied" }, /A gone_quiet rule doesn't take "stage"\. A gone_quiet rule takes only days\./);
  await refuse({ type: "stage_followup", days: 3 }, /needs "stage"/);
  await refuse({ type: "stage_followup", stage: "replied", days: 3, title: "Hi {name}" }, /can use \{deal\}, \{contact\} and \{stage\} only; \{name\} isn't one/);
  await refuse({ type: "stage_followup", stage: "replied", days: 3, title: "   " }, /"title" must be the task title/);
  assert.equal(await countOf(db, "rules"), 0);
  assert.equal(await countOf(db, "audit_log"), 0);
});

test("an archived stage is refused like an unknown one", async () => {
  const db = await openTestDb();
  await archiveStage(ctxFor(db, "archive_stage"), "Call done");
  await assert.rejects(
    addRule(ctxFor(db), { type: "stage_followup", stage: "Call done", days: 3 }),
    (error: Error) => /^There's no stage "Call done"/.test(error.message) && !/call_done/.test(error.message),
  );
});

test("updateRule changes parameters, rewrites a generated description, and refuses a no-op or another type's field", async () => {
  const db = await openTestDb();
  const { ruleId } = await addRule(ctxFor(db), { type: "stage_followup", stage: "proposal_sent", days: 3 });
  const updated = await updateRule(ctxFor(db, "update_rule"), ruleId, { days: 5, stage: "Replied" });
  assert.match(updated.summary, new RegExp(`^Updated rule ${ruleId}: stage and days; now: When a deal has sat in Replied for 5 days`));
  const row = await one<RuleRow>(db, "SELECT * FROM rules WHERE id = ?", ruleId);
  assert.deepEqual(JSON.parse(row.params), { type: "stage_followup", stage: "replied", days: 5 });
  assert.equal(row.version, 2);

  const described = await updateRule(ctxFor(db, "update_rule"), ruleId, { description: "Chase quiet replies." });
  assert.match(described.summary, /^Updated rule ru_[a-z2-7]{12}: description; now: Chase quiet replies\./);
  await assert.rejects(updateRule(ctxFor(db, "update_rule"), ruleId, { days: 5 }), /Nothing to change on rule ru_[a-z2-7]{12}: every value you gave is already set\./);
  await assert.rejects(updateRule(ctxFor(db, "update_rule"), ruleId, { dueInDays: 2 }), /A stage_followup rule doesn't take "dueInDays"/);
  await assert.rejects(updateRule(ctxFor(db, "update_rule"), "ru_nope", { days: 2 }), { message: /^There's no rule "ru_nope"\. Use list_rules/ });

  const undone = await undoChange(ctxFor(db, "undo_change"), described.changeId);
  assert.match(undone.summary, /^Undid chg_[a-z0-9]{12}: Put back the earlier description on rule "When a deal has sat in Replied/);
});

test("pauseRule and resumeRule flip active, refuse a no-op, and listRules shows every rule with its stage label", async () => {
  const db = await openTestDb();
  const { ruleId } = await addRule(ctxFor(db), { type: "stage_followup", stage: "proposal_sent", days: 3 });
  const paused = await pauseRule(ctxFor(db, "pause_rule"), ruleId);
  assert.match(paused.summary, new RegExp(`^Paused rule ${ruleId}: When a deal has sat in Proposal sent`));
  await assert.rejects(pauseRule(ctxFor(db, "pause_rule"), ruleId), /is already paused\. Resume it with resume_rule/);
  const [view] = await listRules(db);
  assert.equal(view?.active, false);
  assert.equal(view?.stageLabel, "Proposal sent");
  assert.equal(view?.timesFired, 0);
  assert.deepEqual(view?.params, { type: "stage_followup", stage: "proposal_sent", days: 3 });
  const resumed = await resumeRule(ctxFor(db, "resume_rule"), ruleId);
  assert.match(resumed.summary, /^Resumed rule /);
  await assert.rejects(resumeRule(ctxFor(db, "resume_rule"), ruleId), /is already active\. Pause it with pause_rule/);
});

test("runRules fires once per stage entry as a system change that creates the task and its firing row", async () => {
  const db = await openTestDb();
  const lead = await proposal(db, NOW);
  const { ruleId } = await addRule(ctxFor(db), { type: "stage_followup", stage: "proposal_sent", days: 3 });

  assert.deepEqual(await runRules(db, later(2)), { rules: 1, fired: 0, alreadyFired: 0, failed: 0 });
  assert.deepEqual(await runRules(db, later(3)), { rules: 1, fired: 1, alreadyFired: 0, failed: 0 });
  assert.deepEqual(await runRules(db, later(3.1)), { rules: 1, fired: 0, alreadyFired: 0, failed: 0 });

  const [task, ...others] = await rows<TaskRow>(db, "SELECT * FROM tasks");
  assert.equal(others.length, 0);
  assert.equal(task?.title, "Follow up with Pat Example about Pat Example website");
  assert.equal(task?.source, ruleId);
  assert.equal(task?.deal_id, lead.dealId);
  assert.equal(task?.due_at, later(3).toISOString());
  assert.equal(task?.untrusted_fields, "[]");
  const firing = await one<RuleFiringRow>(db, "SELECT * FROM rule_firings");
  assert.equal(firing.fire_key, `${ruleId}:${lead.dealId}:${NOW.toISOString()}`);
  assert.equal(firing.task_id, task?.id);
  const audit = await one<AuditRow>(db, "SELECT * FROM audit_log WHERE target_table = 'tasks'");
  assert.equal(audit.actor, "system");
  assert.equal(audit.tool, "rules");
  assert.match(audit.summary, new RegExp(`^Rule ${ruleId} added task "Follow up with Pat Example about Pat Example website" for "Pat Example website" \\(Pat Example\\), due Sun Nov 22, 10:00 AM \\(change chg_`));
  assert.deepEqual(Object.keys(JSON.parse(audit.after_json)), [`tasks:${task?.id}`], "the firing row stays out of the snapshot");
});

test("undoing a rule's task never re-fires it; a later re-entry into the stage fires again", async () => {
  const db = await openTestDb();
  const lead = await proposal(db, NOW);
  await addRule(ctxFor(db), { type: "stage_followup", stage: "proposal_sent", days: 3 });
  await runRules(db, later(3));
  const audit = await one<AuditRow>(db, "SELECT * FROM audit_log WHERE tool = 'rules'");
  await undoChange(ctxFor(db, "undo_change", later(3.2)), audit.id);
  assert.equal(await countOf(db, "tasks"), 0);
  assert.equal((await one<RuleFiringRow>(db, "SELECT * FROM rule_firings")).task_id, null);
  assert.equal((await runRules(db, later(4))).fired, 0);

  await updateDeal(ctxFor(db, "update_deal", later(5)), lead.dealId, { stage: "Replied" });
  await updateDeal(ctxFor(db, "update_deal", later(6)), lead.dealId, { stage: "Proposal sent" });
  assert.equal((await runRules(db, later(8))).fired, 0);
  assert.equal((await runRules(db, later(9))).fired, 1);
  assert.equal(await countOf(db, "rule_firings"), 2);
});

test("contact logged after the stage entry stops a stage_followup; paused rules don't fire", async () => {
  const db = await openTestDb();
  const lead = await proposal(db, NOW);
  const { ruleId } = await addRule(ctxFor(db), { type: "stage_followup", stage: "proposal_sent", days: 3 });
  await pauseRule(ctxFor(db, "pause_rule"), ruleId);
  assert.deepEqual(await runRules(db, later(4)), { rules: 0, fired: 0, alreadyFired: 0, failed: 0 });
  await resumeRule(ctxFor(db, "resume_rule"), ruleId);
  await logActivity(ctxFor(db, "log_activity", later(1)), { dealId: lead.dealId, type: "email", summary: "They replied." });
  assert.equal((await runRules(db, later(4))).fired, 0);
});

test("on_stage_enter fires only for entries after the rule was added, due N days after the entry", async () => {
  const db = await openTestDb();
  await proposal(db, NOW, "Old Example");
  const { ruleId } = await addRule(ctxFor(db, "add_rule", later(1)), {
    type: "on_stage_enter",
    stage: "proposal_sent",
    title: "Send {contact} the {stage} checklist",
    dueInDays: 2,
  });
  const fresh = await proposal(db, later(2), "New Example");
  assert.equal((await runRules(db, later(2.01))).fired, 1);
  const task = await one<TaskRow>(db, "SELECT * FROM tasks WHERE source = ?", ruleId);
  assert.equal(task.deal_id, fresh.dealId);
  assert.equal(task.title, "Send New Example the Proposal sent checklist");
  assert.equal(task.due_at, later(4).toISOString());
});

test("a rule title built from an outside name is stored with untrusted_fields [\"title\"] and labelled in the summary", async () => {
  const db = await seededDb();
  await addRule(ctxFor(db), { type: "stage_followup", stage: "new_inquiry", days: 1 });
  assert.equal((await runRules(db, NOW)).fired, 2);
  const outside = await one<TaskRow>(db, "SELECT * FROM tasks WHERE deal_id = 'dl_seed02' AND source LIKE 'ru_%'");
  assert.equal(outside.untrusted_fields, '["title"]');
  const audit = await one<AuditRow>(db, "SELECT * FROM audit_log WHERE target_id = ?", outside.id);
  assert.match(audit.summary, new RegExp(`^Rule ru_[a-z2-7]{12} added task ${outside.id} for deal dl_seed02 \\(contact ct_seed02\\)`));
  assert.doesNotMatch(audit.summary, /Robin|Sample Bakery/);
  const trusted = await one<TaskRow>(db, "SELECT * FROM tasks WHERE deal_id = 'dl_seed06' AND source LIKE 'ru_%'");
  assert.equal(trusted.untrusted_fields, "[]");
});

test("a parallel run that fired first is skipped silently, not counted as a failure", async () => {
  const db = await openTestDb();
  await proposal(db, NOW);
  await addRule(ctxFor(db), { type: "stage_followup", stage: "proposal_sent", days: 3 });
  const raced = racing(db, () => runRules(db, later(3)));
  assert.deepEqual(await runRules(raced, later(3)), { rules: 1, fired: 0, alreadyFired: 1, failed: 0 });
  assert.equal(await countOf(db, "tasks"), 1);
  assert.equal(await countOf(db, "rule_firings"), 1);
});

test("undo of add_lead is refused once a rule fired on its deal, and undo of add_rule once the rule fired", async () => {
  const db = await openTestDb();
  const lead = await addLead(ctxFor(db, "add_lead"), { name: "Pat Example", dealTitle: "Website refresh" });
  const rule = await addRule(ctxFor(db), { type: "stage_followup", stage: "new_inquiry", days: 1 });
  await runRules(db, later(1));
  const ruleTask = await one<AuditRow>(db, "SELECT * FROM audit_log WHERE tool = 'rules'");
  await undoChange(ctxFor(db, "undo_change", later(1.1)), ruleTask.id);
  await assert.rejects(
    undoChange(ctxFor(db, "undo_change", later(1.2)), lead.changeId),
    {
      message: new RegExp(
        `^Can't undo ${lead.changeId}: this lead has rule history \\(a rule already fired on deal "Website refresh"\\), so it can't be ` +
          "removed\\. Close the deal instead: update_deal with status lost or not_now\\.$",
      ),
    },
  );
  await assert.rejects(
    undoChange(ctxFor(db, "undo_change", later(1.2)), rule.changeId),
    { message: new RegExp(`^Can't undo ${rule.changeId}: rule ${rule.ruleId} has already fired, so it can't be removed\\. Pause it with pause_rule instead\\.$`) },
  );
});

test("previewRuleFor finds what a new or saved rule would have caught in the last 30 days and changes nothing", async () => {
  const db = await seededDb();
  const before = await countOf(db, "audit_log");
  const preview = await previewRuleFor(db, NOW, { type: "stage_followup", stage: "Proposal sent", days: 3 });
  assert.equal(preview.description, "When a deal has sat in Proposal sent for 3 days with no contact logged, add a follow-up task.");
  assert.deepEqual(preview.hits.map((h) => [h.dealId, h.label]), [["dl_seed05", '"Cafe website and menu" (Taylor Testcase)']]);
  assert.equal(preview.dealCount, 1);
  assert.match(preview.hits[0]?.wouldFireAtLocal ?? "", /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d+, \d+:\d{2} [AP]M$/);
  assert.equal(preview.since, new Date(NOW.getTime() - 30 * DAY).toISOString());

  const saved = await previewRuleFor(db, NOW, { rule: "ru_seed01" });
  assert.deepEqual(saved.hits.map((h) => h.dealId).sort(), ["dl_seed05", "dl_seed06"]);
  assert.equal(saved.ruleId, "ru_seed01");
  assert.equal(await countOf(db, "audit_log"), before);
  assert.equal(await countOf(db, "rule_firings"), 0);

  await assert.rejects(previewRuleFor(db, NOW, { rule: "ru_seed01", type: "gone_quiet", days: 2 }), /either a rule id or the rule's settings/);
  await assert.rejects(previewRuleFor(db, NOW, {}), /Give a rule id \(ru_\.\.\.\) to preview a saved rule, or a type/);
  await assert.rejects(previewRuleFor(db, NOW, { rule: "ru_nope" }), /There's no rule "ru_nope"/);
});

test("list_deals' quiet filter and the gone_quiet rules agree on which deals have gone quiet", async () => {
  const db = await seededDb();
  const quiet = await listQuietDeals(db, NOW);
  assert.deepEqual(quiet.map((q) => q.dealId).sort(), ["dl_seed05", "dl_seed06"]);
  assert.ok(quiet.every((q) => q.ruleId === "ru_seed01" && q.quietDays >= 5));
  const listed = await listDealsFiltered(db, { quiet: 5 }, NOW, DEFAULT_TZ);
  assert.deepEqual(listed.map((d) => d.id).sort(), quiet.map((q) => q.dealId).sort());
});
