import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { racing } from "../../tests/helpers/race-db.ts";
import type { ActivityType, AuditRow, Db, RuleFiringRow, RuleRow, TaskRow } from "../db/db.ts";
import { createTestDb, openTestDb } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import type { Ctx } from "./change.ts";
import { updateDeal } from "./deals.ts";
import { logActivity } from "./activities.ts";
import { addDeal } from "./add-deal.ts";
import { updateContact } from "./contacts.ts";
import { UserError } from "./errors.ts";
import { isReach, TEXT_DATA } from "./lead-change.ts";
import { addLead } from "./leads.ts";
import { listDealsFiltered } from "./read.ts";
import { addRule, listQuietDeals, listRules, MAX_FIRINGS_PER_RUN, pauseRule, previewRuleFor, resumeRule, runRules, updateRule } from "./rules.ts";
import { archiveStage } from "./stages.ts";
import { undoChange } from "./undo.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const DAY = 86_400_000;
const later = (days: number, from = NOW) => new Date(from.getTime() + days * DAY);
const ctxFor = (db: Db, tool = "add_rule", now = NOW): Ctx => ({ db, now, actor: "ai", tool });

async function seededDb(): Promise<Db> {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
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
  const lead = await addDeal(ctxFor(db, "add_deal", at), { name, dealTitle: `${name} website` });
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

test("updateRule keeps a custom title when other settings change, and title null puts back the default", async () => {
  const db = await openTestDb();
  const { ruleId } = await addRule(ctxFor(db), { type: "stage_followup", stage: "replied", days: 2, title: "Nudge {contact}" });
  await updateRule(ctxFor(db, "update_rule"), ruleId, { days: 4, stage: "Proposal sent" });
  const params = async () => JSON.parse((await one<RuleRow>(db, "SELECT * FROM rules WHERE id = ?", ruleId)).params);
  assert.deepEqual(await params(), { type: "stage_followup", stage: "proposal_sent", days: 4, title: "Nudge {contact}" });

  const reset = await updateRule(ctxFor(db, "update_rule"), ruleId, { title: null });
  assert.match(reset.summary, new RegExp(`^Updated rule ${ruleId}: title; now: .* add a follow-up task\\.`));
  assert.deepEqual(await params(), { type: "stage_followup", stage: "proposal_sent", days: 4 });
  await assert.rejects(updateRule(ctxFor(db, "update_rule"), ruleId, { title: null }), /Nothing to change on rule/);

  const enter = await addRule(ctxFor(db), { type: "on_stage_enter", stage: "replied", title: "Prepare", dueInDays: 1 });
  await assert.rejects(
    updateRule(ctxFor(db, "update_rule"), enter.ruleId, { title: null }),
    /An on_stage_enter rule needs a title, so it can't go back to a default\. Give the new title instead\./,
  );
  const quiet = await addRule(ctxFor(db), { type: "gone_quiet", days: 7 });
  await assert.rejects(updateRule(ctxFor(db, "update_rule"), quiet.ruleId, { title: null }), /A gone_quiet rule doesn't take "title"/);
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

  assert.deepEqual(await runRules(db, later(2)), { rules: 1, fired: 0, alreadyFired: 0, failed: 0, deferred: 0 });
  assert.deepEqual(await runRules(db, later(3)), { rules: 1, fired: 1, alreadyFired: 0, failed: 0, deferred: 0 });
  assert.deepEqual(await runRules(db, later(3.1)), { rules: 1, fired: 0, alreadyFired: 0, failed: 0, deferred: 0 });

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
  const dealContact = await db.prepare("SELECT contact_id FROM deals WHERE id = ?").bind(lead.dealId).first("contact_id");
  assert.ok(dealContact);
  assert.equal(firing.contact_id, dealContact, "the firing carries its deal's contact");
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
  assert.deepEqual(await runRules(db, later(4)), { rules: 0, fired: 0, alreadyFired: 0, failed: 0, deferred: 0 });
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
  assert.deepEqual(await runRules(raced, later(3)), { rules: 1, fired: 0, alreadyFired: 1, failed: 0, deferred: 0 });
  assert.equal(await countOf(db, "tasks"), 1);
  assert.equal(await countOf(db, "rule_firings"), 1);
});

test("undo of add_deal is refused once a rule fired on its deal, and undo of add_rule once the rule fired", async () => {
  const db = await openTestDb();
  const lead = await addDeal(ctxFor(db, "add_deal"), { name: "Pat Example", dealTitle: "Website refresh" });
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

  assert.equal(preview.scope, "last_30_days");
  assert.equal(preview.hits[0]?.kind, "deal");

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

test("pointing an on_stage_enter rule at another stage cuts over: deals already there don't fire, later entries do", async () => {
  const db = await openTestDb();
  const waiting = await addDeal(ctxFor(db, "add_deal", NOW), { name: "Pat Example", dealTitle: "Waiting site" });
  await updateDeal(ctxFor(db, "update_deal", later(1)), waiting.dealId, { stage: "Call booked" });
  const { ruleId } = await addRule(ctxFor(db, "add_rule", NOW), { type: "on_stage_enter", stage: "replied", title: "Prepare for {contact}", dueInDays: 1 });
  await updateRule(ctxFor(db, "update_rule", later(2)), ruleId, { stage: "call_booked" });
  const params = JSON.parse((await one<RuleRow>(db, "SELECT * FROM rules WHERE id = ?", ruleId)).params);
  assert.deepEqual(params, { type: "on_stage_enter", stage: "call_booked", title: "Prepare for {contact}", dueInDays: 1, since: later(2).toISOString() });

  assert.equal((await runRules(db, later(2.5))).fired, 0, "entered Call booked on day 1, before the rule pointed there");
  const fresh = await addDeal(ctxFor(db, "add_deal", later(3)), { name: "Robin Sample", dealTitle: "Fresh site" });
  await updateDeal(ctxFor(db, "update_deal", later(3)), fresh.dealId, { stage: "Call booked" });
  assert.equal((await runRules(db, later(3.5))).fired, 1);
  assert.equal((await one<TaskRow>(db, "SELECT * FROM tasks WHERE source = ?", ruleId)).deal_id, fresh.dealId);

  const view = (await listRules(db))[0];
  assert.equal(view?.params?.type === "on_stage_enter" && view.params.since, later(2).toISOString());
});

test("changing only the title or days of a rule leaves its cut-over alone", async () => {
  const db = await openTestDb();
  const lead = await proposal(db, later(1));
  const { ruleId } = await addRule(ctxFor(db, "add_rule", NOW), { type: "on_stage_enter", stage: "proposal_sent", title: "Prepare", dueInDays: 1 });
  await updateRule(ctxFor(db, "update_rule", later(2)), ruleId, { title: "Prepare {contact}", dueInDays: 2 });
  const params = JSON.parse((await one<RuleRow>(db, "SELECT * FROM rules WHERE id = ?", ruleId)).params);
  assert.equal(params.since, undefined);
  assert.equal((await runRules(db, later(2.5))).fired, 1, "the entry on day 1 is after the rule was created");
  assert.equal((await one<TaskRow>(db, "SELECT * FROM tasks")).deal_id, lead.dealId);
});

test("resuming a rule cuts over: stage entries from before the resume never fire, later ones do", async () => {
  const db = await openTestDb();
  const { ruleId } = await addRule(ctxFor(db, "add_rule", NOW), { type: "on_stage_enter", stage: "proposal_sent", title: "Prepare {contact}", dueInDays: 1 });
  await pauseRule(ctxFor(db, "pause_rule", later(1)), ruleId);
  await proposal(db, later(2), "Paused Example");
  const resumed = await resumeRule(ctxFor(db, "resume_rule", later(3)), ruleId);
  assert.equal((await runRules(db, later(3.5))).fired, 0, "entered while the rule was paused");
  await proposal(db, later(4), "Resumed Example");
  assert.equal((await runRules(db, later(4.5))).fired, 1);
  assert.match((await one<TaskRow>(db, "SELECT * FROM tasks")).title, /Resumed Example/);

  await undoChange(ctxFor(db, "undo_change", later(5)), resumed.changeId);
  const params = JSON.parse((await one<RuleRow>(db, "SELECT * FROM rules WHERE id = ?", ruleId)).params);
  assert.equal(params.since, undefined, "undoing the resume restores the parameters too");
});

test("resuming a stage_followup does not catch up deals that were already waiting; gone_quiet gets no cut-over", async () => {
  const db = await openTestDb();
  await proposal(db, NOW);
  const followup = await addRule(ctxFor(db, "add_rule", NOW), { type: "stage_followup", stage: "proposal_sent", days: 3 });
  const quiet = await addRule(ctxFor(db, "add_rule", NOW), { type: "gone_quiet", days: 5 });
  await pauseRule(ctxFor(db, "pause_rule", later(1)), followup.ruleId);
  await pauseRule(ctxFor(db, "pause_rule", later(1)), quiet.ruleId);
  await resumeRule(ctxFor(db, "resume_rule", later(5)), followup.ruleId);
  await resumeRule(ctxFor(db, "resume_rule", later(5)), quiet.ruleId);
  assert.equal((await runRules(db, later(6))).fired, 0, "overdue since day 3, but the deal entered before the resume");
  const quietRow = await one<RuleRow>(db, "SELECT * FROM rules WHERE id = ?", quiet.ruleId);
  assert.deepEqual(JSON.parse(quietRow.params), { type: "gone_quiet", days: 5 });
  assert.equal((await listQuietDeals(db, later(6))).length, 1, "the gone_quiet rule still flags the deal");
});

test("when one firing's batch fails, the firings after it in the same run still commit, and the next run retries it", async () => {
  const db = await openTestDb();
  await proposal(db, NOW, "First Example");
  await proposal(db, NOW, "Second Example");
  await addRule(ctxFor(db), { type: "stage_followup", stage: "proposal_sent", days: 3 });
  let failures = 1;
  const flaky: Db = {
    prepare: (sql) => db.prepare(sql),
    async batch(statements) {
      if (failures > 0) {
        failures -= 1;
        throw new Error("D1_ERROR: network connection lost");
      }
      return db.batch(statements);
    },
  };
  assert.deepEqual(await runRules(flaky, later(3)), { rules: 1, fired: 1, alreadyFired: 0, failed: 1, deferred: 0 });
  assert.equal(await countOf(db, "tasks"), 1);
  assert.equal(await countOf(db, "rule_firings"), 1);
  assert.deepEqual(await runRules(flaky, later(3.1)), { rules: 1, fired: 1, alreadyFired: 0, failed: 0, deferred: 0 });
  assert.equal(await countOf(db, "tasks"), 2);
  assert.equal(await countOf(db, "rule_firings"), 2);
});

test("undoing a pause cuts over like resume_rule: entries made while paused never fire", async () => {
  const db = await openTestDb();
  const { ruleId } = await addRule(ctxFor(db, "add_rule", NOW), { type: "on_stage_enter", stage: "proposal_sent", title: "Prepare {contact}", dueInDays: 1 });
  const paused = await pauseRule(ctxFor(db, "pause_rule", later(1)), ruleId);
  await proposal(db, later(2), "Paused Example");
  await undoChange(ctxFor(db, "undo_change", later(3)), paused.changeId);

  const row = await one<RuleRow>(db, "SELECT * FROM rules WHERE id = ?", ruleId);
  assert.equal(row.active, 1);
  assert.equal(JSON.parse(row.params).since, later(3).toISOString(), "the undo sets the same cut-over as resume_rule");
  assert.equal((await runRules(db, later(3.5))).fired, 0, "entered while the rule was paused");
  await proposal(db, later(4), "Resumed Example");
  assert.equal((await runRules(db, later(4.5))).fired, 1);
});

test("undoing a gone_quiet pause re-activates it with no cut-over", async () => {
  const db = await openTestDb();
  const { ruleId } = await addRule(ctxFor(db, "add_rule", NOW), { type: "gone_quiet", days: 7 });
  const paused = await pauseRule(ctxFor(db, "pause_rule", later(1)), ruleId);
  await undoChange(ctxFor(db, "undo_change", later(2)), paused.changeId);
  const row = await one<RuleRow>(db, "SELECT * FROM rules WHERE id = ?", ruleId);
  assert.equal(row.active, 1);
  assert.deepEqual(JSON.parse(row.params), { type: "gone_quiet", days: 7 });
});

test("one run writes at most 25 firings; the rest are deferred to the next hour, none lost or doubled", async () => {
  assert.equal(MAX_FIRINGS_PER_RUN, 25);
  const db = await openTestDb();
  for (let i = 0; i < 30; i++) await proposal(db, NOW, `Lead ${i} Example`);
  await addRule(ctxFor(db, "add_rule", NOW), { type: "stage_followup", stage: "Proposal sent", days: 3 });

  assert.deepEqual(await runRules(db, later(3)), { rules: 1, fired: 25, alreadyFired: 0, failed: 0, deferred: 5 });
  assert.equal(await countOf(db, "tasks"), 25);
  assert.deepEqual(await runRules(db, later(3.04)), { rules: 1, fired: 5, alreadyFired: 0, failed: 0, deferred: 0 });
  assert.equal(await countOf(db, "tasks"), 30);
  assert.equal((await runRules(db, later(3.08))).fired, 0);
  assert.equal(await countOf(db, "rule_firings"), 30);
});

/** A Db that records the occurred_at of every activity row a read returns. */
function recordingActivities(db: Db, seen: string[]): Db {
  const watch = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, name, receiver) {
        if (name === "bind") return (...values: unknown[]) => watch(target.bind(...values));
        if (name === "all") {
          return async () => {
            const result = await target.all<{ occurred_at?: string }>();
            for (const row of result.results) if (row.occurred_at) seen.push(row.occurred_at);
            return result;
          };
        }
        const value: unknown = Reflect.get(target, name, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return {
    prepare: (sql) => (/FROM activities/.test(sql) ? watch(db.prepare(sql)) : db.prepare(sql)),
    batch: (statements) => db.batch(statements),
  };
}

test("preview_rule's lookback is 30 days plus the rule's own days (none for on_stage_enter), with the same hits", async () => {
  const db = await openTestDb();
  await proposal(db, later(-60), "Old Example");
  await proposal(db, later(-34), "Mid Example");
  await proposal(db, later(-20), "Recent Example");
  await proposal(db, later(-3), "New Example");
  const cases: [settings: Parameters<typeof previewRuleFor>[2], days: number, fires: number[]][] = [
    [{ type: "stage_followup", stage: "Proposal sent", days: 7 }, 37, [-27, -13]],
    [{ type: "gone_quiet", days: 10 }, 40, [-30, -24, -10]],
    [{ type: "on_stage_enter", stage: "Proposal sent", title: "Check in", dueInDays: 1 }, 30, [-20, -3]],
  ];
  for (const [settings, days, fires] of cases) {
    const seen: string[] = [];
    const preview = await previewRuleFor(recordingActivities(db, seen), NOW, settings);
    const cutoff = later(-days).toISOString();
    assert.ok(seen.length > 0, `${settings.type}: recent entries are read`);
    assert.ok(seen.every((at) => at >= cutoff), `${settings.type}: nothing older than ${days} days is read`);
    assert.deepEqual(
      preview.hits.map((hit) => hit.wouldFireAt),
      fires.map((d) => later(d).toISOString()),
      settings.type,
    );
  }
});

test("preview_rule for a 365-day rule reads 30 + 365 days back, and an entry 380 days ago still counts", async () => {
  const db = await openTestDb();
  await proposal(db, later(-400), "Old Example");
  await proposal(db, later(-380), "Long Example");
  await proposal(db, later(-10), "Recent Example");
  const seen: string[] = [];

  const preview = await previewRuleFor(recordingActivities(db, seen), NOW, { type: "stage_followup", stage: "Proposal sent", days: 365 });

  const cutoff = later(-395).toISOString();
  assert.ok(seen.length >= 2, "the recent stage moves are read");
  assert.ok(seen.every((at) => at >= cutoff), `nothing older than ${cutoff} is read`);
  assert.ok(!seen.includes(later(-400).toISOString()));
  assert.deepEqual(
    preview.hits.map((hit) => hit.wouldFireAt),
    [later(-15).toISOString()],
    "an entry 380 days ago still counts for a 365-day rule",
  );
});

test("preview_rule's activity read is served by the occurred_at index, not a scan of every activity", async () => {
  const db = await openTestDb();
  await proposal(db, later(-10));
  let read: { sql: string; values: unknown[] } | undefined;
  const recording: Db = {
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!/FROM activities\s+WHERE type IN/.test(sql)) return statement;
      return new Proxy(statement, {
        get(target, name, receiver) {
          if (name === "bind") {
            return (...values: unknown[]) => {
              read = { sql, values };
              return target.bind(...values);
            };
          }
          const value: unknown = Reflect.get(target, name, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    batch: (statements) => db.batch(statements),
  };
  await previewRuleFor(recording, NOW, { type: "stage_followup", stage: "Proposal sent", days: 3 });
  assert.ok(read, "the preview reads activities");
  const plan = await db.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).bind(...read.values).all<{ detail: string }>();
  const details = plan.results.map((row) => row.detail).join("; ");
  assert.match(details, /USING INDEX activities_occurred/, details);
  assert.doesNotMatch(details, /\bSCAN activities\b(?! USING)/, details);
});

test("preview_rule's lookback boundary: an activity at exactly 30 + days back is read, one a millisecond older is not", async () => {
  const db = await createTestDb();
  const days = 7;
  const start = NOW.getTime() - 30 * DAY;
  const line = start - days * DAY;
  const iso = (ms: number) => new Date(ms).toISOString();
  const created = iso(line - 10 * DAY);
  db.exec("INSERT INTO contacts (id, name) VALUES ('ct_edge', 'Pat Example')");
  const deal = (id: string, stage: string, status: string, entered: string, last: string | null) =>
    db.exec(`INSERT INTO deals (id, contact_id, title, stage_key, status, stage_entered_at, last_activity_at, created_at)
      VALUES ('${id}', 'ct_edge', 'Edge ${id}', '${stage}', '${status}', '${entered}', ${last === null ? "NULL" : `'${last}'`}, '${created}')`);
  let n = 0;
  const activity = (dealId: string, type: string, at: number, data: string | null = null) =>
    db.exec(`INSERT INTO activities (id, deal_id, contact_id, type, summary, data, occurred_at, actor)
      VALUES ('ac_edge${n++}', '${dealId}', 'ct_edge', '${type}', 'Edge', ${data === null ? "NULL" : `'${data}'`}, '${iso(at)}', 'owner')`);
  const moved = (from: string, to: string) => JSON.stringify({ from, to });

  // Stage stays in Proposal sent: one entered exactly at the line, one a millisecond before it; both left later.
  const left = start + DAY;
  for (const [id, entered] of [["dl_edgeat", line], ["dl_edgebefore", line - 1]] as const) {
    deal(id, "lost", "lost", iso(left), null);
    activity(id, "stage_change", entered, moved("new_inquiry", "proposal_sent"));
    activity(id, "stage_change", left, moved("proposal_sent", "lost"));
  }
  // Open deals with contact at the line, or a millisecond before it, then again inside the window.
  const later = start + 2 * DAY;
  for (const [id, at] of [["dl_quietat", line], ["dl_quietbefore", line - 1]] as const) {
    deal(id, "new_inquiry", "open", created, iso(later));
    activity(id, "email", at);
    activity(id, "email", later);
  }

  const seen: string[] = [];
  const followup = await previewRuleFor(recordingActivities(db, seen), NOW, { type: "stage_followup", stage: "Proposal sent", days });
  assert.ok(seen.includes(iso(line)), "the activity at the line is read");
  assert.ok(!seen.includes(iso(line - 1)), "the one a millisecond older is not");
  assert.deepEqual(
    followup.hits.map((hit) => [hit.dealId, hit.wouldFireAt]),
    [["dl_edgeat", iso(start)]],
    "an entry at the line fires at the window's start; one a millisecond older would have fired before it",
  );

  const quiet = await previewRuleFor(db, NOW, { type: "gone_quiet", days });
  assert.deepEqual(
    quiet.hits.map((hit) => [hit.dealId, hit.wouldFireAt]),
    [
      ["dl_quietat", iso(start)],
      ["dl_quietbefore", iso(start)],
    ],
    "contact at the line or before it: quiet from the window's start either way, so the unread one changes nothing",
  );
});

// lead_followup (decisions 0022 and 0026).

/** A lead added at `at`, still New. */
const newLead = async (db: Db, at: Date, name = "Pat Example") => addLead(ctxFor(db, "add_lead", at), { name });

/** A lead added at `at` and made Contacted by an email logged then (the auto-advance). */
async function contactedLead(db: Db, at: Date, name = "Pat Example") {
  const added = await newLead(db, at, name);
  await logActivity(ctxFor(db, "log_activity", at), { contactId: added.contactId, type: "email", summary: "Intro email." });
  return added;
}

test("addRule stores a lead_followup with its status and a generated description", async () => {
  const db = await openTestDb();
  const result = await addRule(ctxFor(db), { type: "lead_followup", status: "contacted", days: 5 });
  const description = "When a lead has been Contacted for 5 days with no contact logged, add a follow-up task.";
  assert.equal(result.summary, `Added rule ${result.ruleId}: ${description} (change ${result.changeId})`);
  const row = await one<RuleRow>(db, "SELECT * FROM rules WHERE id = ?", result.ruleId);
  assert.equal(row.type, "lead_followup");
  assert.deepEqual(JSON.parse(row.params), { type: "lead_followup", status: "contacted", days: 5 });

  const titled = await addRule(ctxFor(db), { type: "lead_followup", status: "New", days: 1, title: "Say hello to {contact}" });
  assert.match(titled.summary, /: When a lead has been New for 1 day with no contact logged, add the task "Say hello to \{contact\}"\. \(change/);
  assert.equal(JSON.parse((await one<RuleRow>(db, "SELECT * FROM rules WHERE id = ?", titled.ruleId)).params).status, "new");
  const [view] = await listRules(db);
  assert.equal(view?.stageLabel, null);
  assert.equal(view?.params?.type, "lead_followup");
});

test("addRule refuses a bad lead_followup in plain English, saying what the type takes", async () => {
  const db = await openTestDb();
  const refuse = (input: Parameters<typeof addRule>[1], pattern: RegExp) => assert.rejects(addRule(ctxFor(db), input), { message: pattern });
  const takes = /A lead_followup rule takes status \(new or contacted\) and days, and optionally title\.$/;
  await refuse({ type: "lead_followup", status: "contacted", days: 5, title: "Chase {deal}" }, /^A lead_followup rule's title can use \{contact\} only; \{deal\} isn't one\. Change the title\.$/);
  await refuse({ type: "lead_followup", status: "contacted", days: 5, title: "{stage} again" }, /\{stage\} isn't one/);
  await refuse({ type: "lead_followup", status: "not_now", days: 5 }, /^Fix the rule: "status" must be the lead status to watch: new or contacted\./);
  await refuse({ type: "lead_followup", status: "not_now", days: 5 }, takes);
  await refuse({ type: "lead_followup", days: 5 }, /A lead_followup rule needs "status"/);
  await refuse({ type: "lead_followup", status: "new" }, /needs "days"/);
  await refuse({ type: "lead_followup", status: "new", days: 0 }, /"days" must be a whole number of days from 1 to 365/);
  await refuse({ type: "lead_followup", status: "new", days: 3, stage: "replied" }, /A lead_followup rule doesn't take "stage"\./);
  await refuse({ type: "stage_followup", stage: "replied", days: 3, status: "new" }, /A stage_followup rule doesn't take "status"\./);
  await refuse({ type: "nope" as never, days: 3 }, /"nope" isn't a rule type\. Use stage_followup, on_stage_enter, gone_quiet or lead_followup\./);
  assert.equal(await countOf(db, "rules"), 0);
});

test("runRules adds a contact-only task and a contact firing once a lead has sat N days; the call that moved it doesn't count", async () => {
  const db = await openTestDb();
  const lead = await contactedLead(db, NOW);
  const contact = await one<{ lead_status: string; lead_status_at: string }>(db, "SELECT * FROM contacts WHERE id = ?", lead.contactId);
  assert.equal(contact.lead_status, "contacted", "the email moved it to Contacted");
  const { ruleId } = await addRule(ctxFor(db), { type: "lead_followup", status: "contacted", days: 5 });

  assert.deepEqual(await runRules(db, later(4.9)), { rules: 1, fired: 0, alreadyFired: 0, failed: 0, deferred: 0 });
  assert.deepEqual(await runRules(db, later(5)), { rules: 1, fired: 1, alreadyFired: 0, failed: 0, deferred: 0 });
  assert.deepEqual(await runRules(db, later(5.1)), { rules: 1, fired: 0, alreadyFired: 0, failed: 0, deferred: 0 });

  const task = await one<TaskRow>(db, "SELECT * FROM tasks");
  assert.equal(task.deal_id, null);
  assert.equal(task.contact_id, lead.contactId);
  assert.equal(task.title, "Follow up with Pat Example");
  assert.equal(task.source, ruleId);
  assert.equal(task.due_at, later(5).toISOString());
  assert.equal(task.untrusted_fields, "[]");
  const firing = await one<RuleFiringRow>(db, "SELECT * FROM rule_firings");
  assert.equal(firing.deal_id, null);
  assert.equal(firing.contact_id, lead.contactId);
  assert.equal(firing.fire_key, `${ruleId}:${lead.contactId}:${contact.lead_status_at}`);
  assert.equal(firing.task_id, task.id);
  const audit = await one<AuditRow>(db, "SELECT * FROM audit_log WHERE tool = 'rules'");
  assert.equal(audit.actor, "system");
  assert.match(audit.summary, new RegExp(`^Rule ${ruleId} added task "Follow up with Pat Example" for Pat Example, due .* \\(change chg_`));
});

test("reach logged after the status began stops a lead_followup: a call or a text does, a plain note doesn't", async () => {
  const db = await createTestDb();
  const called = await contactedLead(db, NOW, "Called Example");
  const texted = await contactedLead(db, NOW, "Texted Example");
  const noted = await contactedLead(db, NOW, "Noted Example");
  const viaDeal = await contactedLead(db, NOW, "Deal Example");
  await logActivity(ctxFor(db, "log_activity", later(1)), { contactId: called.contactId, type: "call", summary: "Left a message." });
  await logActivity(ctxFor(db, "log_activity", later(1)), { contactId: texted.contactId, type: "note", summary: "Texted.", via: "text" });
  await logActivity(ctxFor(db, "log_activity", later(1)), { contactId: noted.contactId, type: "note", summary: "Looked them up." });
  // An old deal of theirs (closed) carries a meeting logged after the status began, with no contact id on the row.
  db.exec(`INSERT INTO deals (id, contact_id, title, stage_key, status, stage_entered_at, created_at)
    VALUES ('dl_old', '${viaDeal.contactId}', 'Old job', 'lost', 'lost', '${NOW.toISOString()}', '${NOW.toISOString()}')`);
  db.exec(`INSERT INTO activities (id, deal_id, contact_id, type, summary, occurred_at, actor)
    VALUES ('ac_old', 'dl_old', NULL, 'meeting', 'Met them.', '${later(1).toISOString()}', 'owner')`);
  await addRule(ctxFor(db), { type: "lead_followup", status: "contacted", days: 3 });
  assert.equal((await runRules(db, later(3))).fired, 1);
  assert.equal((await one<TaskRow>(db, "SELECT * FROM tasks")).contact_id, noted.contactId);
});

test("the hourly run's reach test in SQL agrees with isReach for every activity type and data shape", async () => {
  const db = await createTestDb();
  const stamp = later(-5).toISOString();
  const cases: [type: ActivityType, data: string | null][] = [
    ["form", null],
    ["email", null],
    ["call", null],
    ["meeting", null],
    ["note", null],
    ["note", TEXT_DATA],
    ["note", '{"via":"call"}'],
    ["note", '{"via":["text"]}'],
    ["note", '{"other":"text"}'],
    ["stage_change", '{"from":"a","to":"b"}'],
    ["system", null],
    ["system", TEXT_DATA],
    ["email", '{"via":"campaign","campaign":"cp_case01"}'],
    ["email", '{"via":"other"}'],
  ];
  cases.forEach(([type, data], i) => {
    db.exec(`INSERT INTO contacts (id, name, lead_status, lead_status_at, person_status, sub_status) VALUES ('ct_case${i}', 'Case ${i} Example', 'new', '${stamp}', 'lead', 'new')`);
    db.exec(`INSERT INTO activities (id, contact_id, type, summary, data, occurred_at, actor)
      VALUES ('ac_case${i}', 'ct_case${i}', '${type}', 'Case', ${data === null ? "NULL" : `'${data}'`}, '${later(-2).toISOString()}', 'owner')`);
  });
  const preview = await previewRuleFor(db, NOW, { type: "lead_followup", status: "new", days: 1 });
  const caught = new Set(preview.hits.map((hit) => hit.contactId));
  cases.forEach(([type, data], i) => {
    assert.equal(caught.has(`ct_case${i}`), !isReach(type, data), `${type} ${data ?? "null"}`);
  });
});

test("a lead whose status time is missing never fires", async () => {
  const db = await createTestDb();
  db.exec("INSERT INTO contacts (id, name, lead_status, lead_status_at, person_status, sub_status) VALUES ('ct_nostamp', 'Pat Example', 'new', NULL, 'lead', 'new')");
  await addRule(ctxFor(db), { type: "lead_followup", status: "new", days: 1 });
  assert.equal((await runRules(db, later(30))).fired, 0);
});

test("undoing a lead rule's task never re-fires it; re-entering the status fires again", async () => {
  const db = await openTestDb();
  const lead = await newLead(db, NOW);
  await addRule(ctxFor(db), { type: "lead_followup", status: "new", days: 2 });
  await runRules(db, later(2));
  const audit = await one<AuditRow>(db, "SELECT * FROM audit_log WHERE tool = 'rules'");
  await undoChange(ctxFor(db, "undo_change", later(2.1)), audit.id);
  assert.equal(await countOf(db, "tasks"), 0);
  assert.equal((await runRules(db, later(3))).fired, 0);

  await updateContact(ctxFor(db, "update_contact", later(4)), lead.contactId, { leadStatus: "not_now" });
  await updateContact(ctxFor(db, "update_contact", later(5)), lead.contactId, { leadStatus: "new" });
  assert.equal((await runRules(db, later(6.9))).fired, 0);
  assert.equal((await runRules(db, later(7))).fired, 1);
  assert.equal(await countOf(db, "rule_firings"), 2);
});

test("undo of add_lead is refused once a lead rule fired on the person, pointing to Bad lead or Not a fit", async () => {
  const db = await openTestDb();
  const lead = await newLead(db, NOW);
  await addRule(ctxFor(db), { type: "lead_followup", status: "new", days: 1 });
  await runRules(db, later(1));
  const ruleTask = await one<AuditRow>(db, "SELECT * FROM audit_log WHERE tool = 'rules'");
  await undoChange(ctxFor(db, "undo_change", later(1.1)), ruleTask.id);
  await assert.rejects(undoChange(ctxFor(db, "undo_change", later(1.2)), lead.changeId), {
    message: new RegExp(
      `^Can't undo ${lead.changeId}: this person has rule history \\(a rule already fired on contact Pat Example\\), so they ` +
        "can't be removed\\. Mark them Bad lead or Not a fit with update_contact instead\\.$",
    ),
  });
  assert.equal(await countOf(db, "contacts"), 1);
});

test("pausing and resuming a lead_followup cuts over: leads that became New before the resume never fire", async () => {
  const db = await openTestDb();
  await newLead(db, NOW, "Waiting Example");
  const { ruleId } = await addRule(ctxFor(db, "add_rule", NOW), { type: "lead_followup", status: "new", days: 3 });
  await pauseRule(ctxFor(db, "pause_rule", later(1)), ruleId);
  assert.equal((await runRules(db, later(4))).rules, 0);
  await resumeRule(ctxFor(db, "resume_rule", later(5)), ruleId);
  const params = JSON.parse((await one<RuleRow>(db, "SELECT * FROM rules WHERE id = ?", ruleId)).params);
  assert.deepEqual(params, { type: "lead_followup", status: "new", days: 3, since: later(5).toISOString() });
  assert.equal((await runRules(db, later(5.5))).fired, 0, "overdue since day 3, but New since before the resume");
  await newLead(db, later(6), "Fresh Example");
  assert.equal((await runRules(db, later(9))).fired, 1);
  assert.match((await one<TaskRow>(db, "SELECT * FROM tasks")).title, /Fresh Example/);

  await updateRule(ctxFor(db, "update_rule", later(10)), ruleId, { days: 4 });
  const kept = JSON.parse((await one<RuleRow>(db, "SELECT * FROM rules WHERE id = ?", ruleId)).params);
  assert.equal(kept.since, later(5).toISOString(), "an update keeps the cut-over");
});

test("updateRule changes a lead_followup's status, days and title, and title null puts back the default", async () => {
  const db = await openTestDb();
  const { ruleId } = await addRule(ctxFor(db), { type: "lead_followup", status: "new", days: 2, title: "Hi {contact}" });
  const updated = await updateRule(ctxFor(db, "update_rule"), ruleId, { status: "contacted", days: 4 });
  assert.match(updated.summary, new RegExp(`^Updated rule ${ruleId}: status and days; now: When a lead has been Contacted for 4 days`));
  const params = async () => JSON.parse((await one<RuleRow>(db, "SELECT * FROM rules WHERE id = ?", ruleId)).params);
  assert.deepEqual(await params(), { type: "lead_followup", status: "contacted", days: 4, title: "Hi {contact}" });
  await updateRule(ctxFor(db, "update_rule"), ruleId, { title: null });
  assert.deepEqual(await params(), { type: "lead_followup", status: "contacted", days: 4 });
  await assert.rejects(updateRule(ctxFor(db, "update_rule"), ruleId, { title: "About {deal}" }), /title can use \{contact\} only/);
  await assert.rejects(updateRule(ctxFor(db, "update_rule"), ruleId, { stage: "Replied" }), /A lead_followup rule doesn't take "stage"/);
});

test("a rule whose stored settings can't be read is refused in plain English by update and preview", async () => {
  const db = await createTestDb();
  db.exec(`INSERT INTO rules (id, type, params, description, created_by) VALUES ('ru_broken', 'lead_followup', '{"type":"lead_followup","days":"x"}', 'Broken', 'owner')`);
  const unreadable = (error: unknown) =>
    error instanceof UserError &&
    error.message === "Rule ru_broken's settings can't be read, so it is skipped. Pause it with pause_rule and add a new rule with add_rule.";
  await assert.rejects(updateRule(ctxFor(db, "update_rule"), "ru_broken", { days: 2 }), unreadable);
  await assert.rejects(previewRuleFor(db, NOW, { rule: "ru_broken" }), unreadable);
  assert.deepEqual(await runRules(db, NOW), { rules: 0, fired: 0, alreadyFired: 0, failed: 0, deferred: 0 });
});

test("previewRuleFor for a lead_followup lists the leads it would catch now, by id or by settings, and changes nothing", async () => {
  const db = await openTestDb();
  await contactedLead(db, later(-9), "Quiet Example");
  const busy = await contactedLead(db, later(-9), "Busy Example");
  await logActivity(ctxFor(db, "log_activity", later(-2)), { contactId: busy.contactId, type: "call", summary: "Talked." });
  await contactedLead(db, later(-2), "Recent Example");
  const before = await countOf(db, "audit_log");

  const preview = await previewRuleFor(db, NOW, { type: "lead_followup", status: "Contacted", days: 5 });
  assert.equal(preview.scope, "now");
  assert.equal(preview.description, "When a lead has been Contacted for 5 days with no contact logged, add a follow-up task.");
  assert.deepEqual(preview.hits.map((h) => [h.kind, h.dealId, h.label, h.wouldFireAt]), [["lead", null, "Quiet Example", later(-4).toISOString()]]);
  assert.equal(preview.leadCount, 1);
  assert.equal(preview.dealCount, 0);

  const { ruleId } = await addRule(ctxFor(db), { type: "lead_followup", status: "contacted", days: 1 });
  const saved = await previewRuleFor(db, NOW, { rule: ruleId });
  assert.equal(saved.ruleId, ruleId);
  assert.equal(saved.leadCount, 2, "Quiet and Recent");
  assert.equal(await countOf(db, "audit_log"), before + 1, "only add_rule wrote");
  assert.equal(await countOf(db, "rule_firings"), 0);
});

test("previewing a saved lead rule leaves out leads it already fired on; previewing by settings still lists them", async () => {
  const db = await openTestDb();
  await contactedLead(db, later(-9), "Reminded Example");
  await contactedLead(db, later(-7), "Waiting Example");
  const { ruleId } = await addRule(ctxFor(db, "add_rule", later(-8)), { type: "lead_followup", status: "contacted", days: 1 });
  await runRules(db, later(-8));
  assert.equal(await countOf(db, "rule_firings"), 1, "only Reminded had waited a day by then");

  const saved = await previewRuleFor(db, NOW, { rule: ruleId });
  assert.deepEqual(saved.hits.map((h) => h.label), ["Waiting Example"]);
  assert.equal(saved.leadCount, 1);
  assert.equal(saved.paused, false);
  const fresh = await previewRuleFor(db, NOW, { type: "lead_followup", status: "contacted", days: 1 });
  assert.deepEqual(fresh.hits.map((h) => h.label), ["Reminded Example", "Waiting Example"]);
});

test("previewing a paused lead rule catches no one and says it is paused", async () => {
  const db = await openTestDb();
  await contactedLead(db, later(-9));
  const { ruleId } = await addRule(ctxFor(db), { type: "lead_followup", status: "contacted", days: 1 });
  await pauseRule(ctxFor(db, "pause_rule"), ruleId);
  const preview = await previewRuleFor(db, NOW, { rule: ruleId });
  assert.equal(preview.paused, true);
  assert.deepEqual(preview.hits, []);
  assert.equal(preview.leadCount, 0);
});

test("a parallel run that fired a lead first is skipped silently: one task, counted as alreadyFired", async () => {
  const db = await openTestDb();
  await newLead(db, NOW);
  await addRule(ctxFor(db), { type: "lead_followup", status: "new", days: 3 });
  const raced = racing(db, () => runRules(db, later(3)));
  assert.deepEqual(await runRules(raced, later(3)), { rules: 1, fired: 0, alreadyFired: 1, failed: 0, deferred: 0 });
  assert.equal(await countOf(db, "tasks"), 1);
  assert.equal(await countOf(db, "rule_firings"), 1);
});

test("lead firings over the budget go oldest first: the longest-waiting leads fire in the first run", async () => {
  const db = await openTestDb();
  for (let i = 0; i < 26; i++) await newLead(db, later(i / 24), `Lead ${String(i).padStart(2, "0")} Example`);
  await addRule(ctxFor(db), { type: "lead_followup", status: "new", days: 1, title: "Call {contact}" });
  await addRule(ctxFor(db), { type: "lead_followup", status: "new", days: 3, title: "Again {contact}" });
  const run = await runRules(db, later(5));
  assert.equal(run.fired, 25);
  assert.equal(run.deferred, 27);
  const titles = (await rows<{ title: string }>(db, "SELECT title FROM tasks ORDER BY due_at, title")).map((t) => t.title);
  assert.ok(titles.every((title) => title.startsWith("Call ")), "every 1-day reminder is due before any 3-day one");
  assert.ok(!titles.includes("Call Lead 25 Example"), "the newest lead waits for the next run");
});

test("deal firings and lead firings share one run's budget of 25, deals first; none lost or doubled", async () => {
  const db = await openTestDb();
  for (let i = 0; i < 20; i++) await proposal(db, NOW, `Deal ${i} Example`);
  for (let i = 0; i < 10; i++) await newLead(db, NOW, `Lead ${i} Example`);
  await addRule(ctxFor(db), { type: "stage_followup", stage: "Proposal sent", days: 3 });
  await addRule(ctxFor(db), { type: "lead_followup", status: "new", days: 3 });

  assert.deepEqual(await runRules(db, later(3)), { rules: 2, fired: 25, alreadyFired: 0, failed: 0, deferred: 5 });
  const firstRun = await rows<{ deals: number; leads: number }>(
    db,
    "SELECT COUNT(deal_id) AS deals, COUNT(*) - COUNT(deal_id) AS leads FROM rule_firings",
  );
  assert.deepEqual(firstRun, [{ deals: 20, leads: 5 }]);
  assert.deepEqual(await runRules(db, later(3.04)), { rules: 2, fired: 5, alreadyFired: 0, failed: 0, deferred: 0 });
  assert.equal((await runRules(db, later(3.08))).fired, 0);
  assert.equal(await countOf(db, "rule_firings"), 30);
  assert.equal(await countOf(db, "tasks"), 30);
});

test("the hourly run reads every lead in one query: the statement count doesn't grow with the number of leads", async () => {
  const statementsFor = async (leads: number) => {
    const db = await openTestDb();
    for (let i = 0; i < leads; i++) await newLead(db, NOW, `Lead ${i} Example`);
    await addRule(ctxFor(db), { type: "lead_followup", status: "new", days: 3 });
    let prepared = 0;
    const counting: Db = { prepare: (sql) => ((prepared += 1), db.prepare(sql)), batch: (statements) => db.batch(statements) };
    await runRules(counting, later(1));
    return prepared;
  };
  assert.equal(await statementsFor(20), await statementsFor(1));
});
