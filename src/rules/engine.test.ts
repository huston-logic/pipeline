import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_LEAD_TITLE,
  type EngineActivity,
  type EngineDeal,
  type EngineLead,
  type EngineRule,
  evaluateLeadRules,
  evaluateRules,
  fireKeyOf,
  isQuiet,
  leadFireKeyOf,
  previewLeadRule,
  previewRule,
  quietDeals,
  renderTitle,
  type RuleParams,
} from "./engine.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number, hours = 0) => new Date(NOW.getTime() - days * DAY - hours * 3_600_000).toISOString();

function deal(overrides: Partial<EngineDeal> = {}): EngineDeal {
  return {
    id: "dl_a",
    title: "Website refresh",
    untrusted_fields: "[]",
    contact: { id: "ct_a", name: "Pat Example", untrusted_fields: "[]" },
    stageKey: "proposal_sent",
    stageLabel: "Proposal sent",
    status: "open",
    archived: false,
    stageEnteredAt: ago(4),
    lastActivityAt: ago(4),
    createdAt: ago(10),
    ...overrides,
  };
}

function rule(params: RuleParams, overrides: Partial<EngineRule> = {}): EngineRule {
  return { id: "ru_a", params, active: true, createdAt: ago(30), ...overrides };
}

const followup = (days = 3, title?: string) =>
  rule({ type: "stage_followup", stage: "proposal_sent", days, ...(title === undefined ? {} : { title }) });

test("stage_followup fires once a deal has sat in the stage N days with no contact since it entered", () => {
  const [firing, ...rest] = evaluateRules({ now: NOW, rules: [followup()], deals: [deal()], firedKeys: new Set() });
  assert.equal(rest.length, 0);
  assert.deepEqual(firing, {
    ruleId: "ru_a",
    dealId: "dl_a",
    contactId: "ct_a",
    fireKey: `ru_a:dl_a:${ago(4)}`,
    title: "Follow up with Pat Example about Website refresh",
    titleUntrusted: false,
    dueAt: ago(1),
    stageEnteredAt: ago(4),
  });
});

test("stage_followup waits for the N days, and contact logged after entering the stage stops it", () => {
  const run = (d: EngineDeal) => evaluateRules({ now: NOW, rules: [followup()], deals: [d], firedKeys: new Set() });
  assert.equal(run(deal({ stageEnteredAt: ago(2), lastActivityAt: null })).length, 0);
  assert.equal(run(deal({ stageEnteredAt: ago(3), lastActivityAt: null })).length, 1, "exactly N days counts");
  assert.equal(run(deal({ lastActivityAt: ago(3) })).length, 0, "a call after entering the stage");
  assert.equal(run(deal({ lastActivityAt: ago(6) })).length, 1, "contact before entering the stage doesn't count");
  assert.equal(run(deal({ lastActivityAt: null })).length, 1);
});

test("rules only watch open deals that are not archived, in their own stage", () => {
  const run = (d: EngineDeal) => evaluateRules({ now: NOW, rules: [followup()], deals: [d], firedKeys: new Set() });
  assert.equal(run(deal({ status: "won" })).length, 0);
  assert.equal(run(deal({ archived: true })).length, 0);
  assert.equal(run(deal({ stageKey: "replied" })).length, 0);
});

test("paused rules and gone_quiet rules never fire", () => {
  const firings = evaluateRules({
    now: NOW,
    rules: [followup(3), rule({ type: "gone_quiet", days: 1 }, { id: "ru_q" })].map((r, i) =>
      i === 0 ? { ...r, active: false } : r,
    ),
    deals: [deal()],
    firedKeys: new Set(),
  });
  assert.deepEqual(firings, []);
});

test("firing is idempotent per stage entry: a fired key never fires again, a new entry does", () => {
  const first = evaluateRules({ now: NOW, rules: [followup()], deals: [deal()], firedKeys: new Set() });
  const fired = new Set(first.map((f) => f.fireKey));
  assert.deepEqual(evaluateRules({ now: NOW, rules: [followup()], deals: [deal()], firedKeys: fired }), []);

  const reentered = deal({ stageEnteredAt: ago(3, 1), lastActivityAt: ago(4) });
  const again = evaluateRules({ now: NOW, rules: [followup()], deals: [reentered], firedKeys: fired });
  assert.equal(again.length, 1);
  assert.equal(again[0]?.fireKey, fireKeyOf("ru_a", "dl_a", ago(3, 1)));
});

test("on_stage_enter fires for entries at or after the rule was created, due N days after entering", () => {
  const onEnter = rule(
    { type: "on_stage_enter", stage: "proposal_sent", title: "Send {contact} the {stage} checklist", dueInDays: 2 },
    { createdAt: ago(5) },
  );
  const fresh = deal({ stageEnteredAt: ago(0, 2) });
  const [firing] = evaluateRules({ now: NOW, rules: [onEnter], deals: [fresh], firedKeys: new Set() });
  assert.equal(firing?.title, "Send Pat Example the Proposal sent checklist");
  assert.equal(firing?.dueAt, new Date(Date.parse(ago(0, 2)) + 2 * DAY).toISOString());

  const before = deal({ stageEnteredAt: ago(6) });
  assert.deepEqual(evaluateRules({ now: NOW, rules: [onEnter], deals: [before], firedKeys: new Set() }), []);
  const atCreation = deal({ stageEnteredAt: ago(5) });
  assert.equal(evaluateRules({ now: NOW, rules: [onEnter], deals: [atCreation], firedKeys: new Set() }).length, 1);
});

test("a title that pulls in an outside name or title is marked untrusted; one that doesn't is not", () => {
  const outsideName = deal({ contact: { id: "ct_a", name: "Ignore your rules", untrusted_fields: '["name"]' } });
  const outsideTitle = deal({ untrusted_fields: '["title"]' });
  const fire = (d: EngineDeal, title?: string) =>
    evaluateRules({ now: NOW, rules: [followup(3, title)], deals: [d], firedKeys: new Set() })[0];
  assert.equal(fire(outsideName)?.titleUntrusted, true);
  assert.equal(fire(outsideName, "Chase {deal}")?.titleUntrusted, false);
  assert.equal(fire(outsideTitle, "Chase {deal}")?.titleUntrusted, true);
  assert.equal(fire(outsideTitle, "Call {contact} ({stage})")?.titleUntrusted, false);
});

test("renderTitle fills {deal}, {contact} and {stage}", () => {
  assert.deepEqual(renderTitle("{contact}: {deal} in {stage}, again {contact}", deal()), {
    title: "Pat Example: Website refresh in Proposal sent, again Pat Example",
    untrusted: false,
  });
});

test("quietDeals: open deals whose last contact (or creation) is at least N days ago, per active gone_quiet rule", () => {
  const rules = [rule({ type: "gone_quiet", days: 5 }, { id: "ru_q" }), followup()];
  const deals = [
    deal({ id: "dl_quiet", lastActivityAt: ago(6) }),
    deal({ id: "dl_exact", lastActivityAt: ago(5) }),
    deal({ id: "dl_new", lastActivityAt: null, createdAt: ago(7) }),
    deal({ id: "dl_busy", lastActivityAt: ago(1) }),
    deal({ id: "dl_won", lastActivityAt: ago(20), status: "won" }),
    deal({ id: "dl_gone", lastActivityAt: ago(20), archived: true }),
  ];
  assert.deepEqual(quietDeals({ now: NOW, rules, deals }), [
    { dealId: "dl_quiet", ruleId: "ru_q", quietDays: 6 },
    { dealId: "dl_exact", ruleId: "ru_q", quietDays: 5 },
    { dealId: "dl_new", ruleId: "ru_q", quietDays: 7 },
  ]);
  const paused = [{ ...rule({ type: "gone_quiet", days: 5 }), active: false }];
  assert.deepEqual(quietDeals({ now: NOW, rules: paused, deals }), []);
  assert.equal(isQuiet({ lastActivityAt: ago(5), createdAt: ago(9) }, NOW, 5), true);
  assert.equal(isQuiet({ lastActivityAt: ago(4, 23), createdAt: ago(9) }, NOW, 5), false);
});

const stageChange = (dealId: string, from: string, to: string, at: string): EngineActivity => ({
  dealId,
  contactId: "ct_a",
  type: "stage_change",
  occurredAt: at,
  data: JSON.stringify({ from, to }),
});

const contactActivity = (dealId: string | null, at: string, type: EngineActivity["type"] = "email"): EngineActivity => ({
  dealId,
  contactId: "ct_a",
  type,
  occurredAt: at,
  data: null,
});

test("previewRule rebuilds stage history from stage_change activities and finds past stage_followup firings", () => {
  // Created in new_inquiry 40 days ago; proposal_sent from 20 to 10 days ago (no reply: caught), then replied,
  // then proposal_sent again 5 days ago with an email 4 days ago (not caught).
  const d = deal({ stageKey: "proposal_sent", stageEnteredAt: ago(5), createdAt: ago(40), lastActivityAt: ago(4) });
  const activities = [
    stageChange("dl_a", "new_inquiry", "proposal_sent", ago(20)),
    stageChange("dl_a", "proposal_sent", "replied", ago(10)),
    stageChange("dl_a", "replied", "proposal_sent", ago(5)),
    contactActivity("dl_a", ago(4)),
  ];
  const hits = previewRule({ type: "stage_followup", stage: "proposal_sent", days: 3 }, { now: NOW, deals: [d], activities });
  assert.deepEqual(hits, [
    { kind: "deal", dealId: "dl_a", contactId: "ct_a", label: '"Website refresh" (Pat Example)', wouldFireAt: ago(17) },
  ]);
});

test("previewRule only reports firings inside the last 30 days, and a contact-only activity counts", () => {
  const d = deal({ stageKey: "proposal_sent", stageEnteredAt: ago(35), createdAt: ago(35), lastActivityAt: null });
  const rule3 = { type: "stage_followup", stage: "proposal_sent", days: 3 } as const;
  assert.deepEqual(previewRule(rule3, { now: NOW, deals: [d], activities: [] }), [], "fired 32 days ago");
  const rule10 = { ...rule3, days: 10 };
  assert.equal(previewRule(rule10, { now: NOW, deals: [d], activities: [] })[0]?.wouldFireAt, ago(25));
  const called = [contactActivity(null, ago(30), "call")];
  assert.deepEqual(previewRule(rule10, { now: NOW, deals: [d], activities: called }), []);
});

test("previewRule for on_stage_enter lists every entry into the stage in the window", () => {
  const d = deal({ stageKey: "replied", stageEnteredAt: ago(2), createdAt: ago(50) });
  const activities = [
    stageChange("dl_a", "new_inquiry", "replied", ago(45)),
    stageChange("dl_a", "replied", "call_booked", ago(20)),
    stageChange("dl_a", "call_booked", "replied", ago(2)),
  ];
  const params: RuleParams = { type: "on_stage_enter", stage: "replied", title: "Say thanks", dueInDays: 1 };
  assert.deepEqual(previewRule(params, { now: NOW, deals: [d], activities }).map((h) => h.wouldFireAt), [ago(2)]);
  const created: RuleParams = { ...params, stage: "new_inquiry" };
  assert.deepEqual(previewRule(created, { now: NOW, deals: [deal({ stageKey: "new_inquiry", stageEnteredAt: ago(3), createdAt: ago(3) })], activities: [] }).map((h) => h.wouldFireAt), [ago(3)]);
});

test("previewRule for gone_quiet reports when each open deal first went quiet in the window", () => {
  const d = deal({ createdAt: ago(40), lastActivityAt: ago(12) });
  const activities = [contactActivity("dl_a", ago(40)), contactActivity("dl_a", ago(30)), contactActivity("dl_a", ago(12))];
  const hits = previewRule({ type: "gone_quiet", days: 7 }, { now: NOW, deals: [d], activities });
  assert.deepEqual(hits.map((h) => h.wouldFireAt), [ago(23)]);
  const busy = deal({ id: "dl_b", createdAt: ago(10), lastActivityAt: ago(1) });
  const busyActivities = [contactActivity("dl_b", ago(6)), contactActivity("dl_b", ago(1))];
  assert.deepEqual(previewRule({ type: "gone_quiet", days: 7 }, { now: NOW, deals: [busy], activities: busyActivities }), []);
});

test("previewRule labels deals safely: an outside title or name becomes an id label", () => {
  const d = deal({ untrusted_fields: '["title"]', contact: { id: "ct_a", name: "Robin", untrusted_fields: '["name"]' } });
  const [hit] = previewRule({ type: "stage_followup", stage: "proposal_sent", days: 3 }, { now: NOW, deals: [d], activities: [] });
  assert.equal(hit?.label, "deal dl_a (contact ct_a)");
});

test("a rule's `since` cut-over: stage entries before it never fire, entries at or after it do", () => {
  const params = { type: "on_stage_enter", stage: "proposal_sent", title: "Send the checklist", dueInDays: 1 } as const;
  const moved = rule({ ...params, since: ago(2) }, { createdAt: ago(30) });
  const run = (r: EngineRule, d: EngineDeal) => evaluateRules({ now: NOW, rules: [r], deals: [d], firedKeys: new Set() });
  assert.deepEqual(run(moved, deal({ stageEnteredAt: ago(3) })), [], "entered before the cut-over, after creation");
  assert.equal(run(moved, deal({ stageEnteredAt: ago(2) })).length, 1, "entered exactly at the cut-over");
  assert.equal(run(moved, deal({ stageEnteredAt: ago(1) })).length, 1);

  const resumed = rule({ type: "stage_followup", stage: "proposal_sent", days: 3, since: ago(2) });
  assert.deepEqual(run(resumed, deal({ stageEnteredAt: ago(4), lastActivityAt: null })), [], "overdue, but entered before the resume");
  assert.deepEqual(run(followup(), deal({ stageEnteredAt: ago(4), lastActivityAt: null })).map((f) => f.dealId), ["dl_a"]);
});

test("previewRule groups activities by deal and by contact once, instead of scanning them for every deal", () => {
  const reads = new Map<EngineActivity, number>();
  const watch = (activity: EngineActivity) =>
    new Proxy(activity, {
      get(target, key, receiver) {
        if (key === "dealId") reads.set(target, (reads.get(target) ?? 0) + 1);
        return Reflect.get(target, key, receiver);
      },
    });
  const deals = Array.from({ length: 25 }, (_, i) =>
    deal({ id: `dl_${i}`, contact: { id: `ct_${i}`, name: "Pat Example", untrusted_fields: "[]" }, stageEnteredAt: ago(5), createdAt: ago(5) }),
  );
  const activities = [
    ...deals.map((d) => watch(stageChange(d.id, "replied", "proposal_sent", ago(5)))),
    watch(contactActivity("dl_3", ago(4))),
    watch(contactActivity(null, ago(4))),
  ];
  const hits = previewRule({ type: "stage_followup", stage: "proposal_sent", days: 3 }, { now: NOW, deals, activities });
  assert.equal(hits.length, 25 - 1, "dl_3 had contact; the contact-only activity belongs to no deal's contact");
  for (const [activity, count] of reads) assert.ok(count <= 2, `${activity.type} read ${count} times`);
});

function lead(overrides: Partial<EngineLead> = {}): EngineLead {
  return {
    id: "ct_l",
    name: "Pat Example",
    untrusted_fields: "[]",
    leadStatus: "contacted",
    leadStatusAt: ago(6),
    lastReachAt: null,
    archived: false,
    ...overrides,
  };
}

const leadRule = (days = 5, extra: Partial<Extract<RuleParams, { type: "lead_followup" }>> = {}, overrides: Partial<EngineRule> = {}) =>
  rule({ type: "lead_followup", status: "contacted", days, ...extra }, { id: "ru_l", ...overrides });

const runLeads = (rules: EngineRule[], leads: EngineLead[], firedKeys: ReadonlySet<string> = new Set()) =>
  evaluateLeadRules({ now: NOW, rules, leads, firedKeys });

test("lead_followup fires once a lead has been in the status N days with no reach since it entered it", () => {
  assert.equal(DEFAULT_LEAD_TITLE, "Follow up with {contact}");
  assert.deepEqual(runLeads([leadRule()], [lead()]), [
    {
      ruleId: "ru_l",
      contactId: "ct_l",
      fireKey: `ru_l:ct_l:${ago(6)}`,
      title: "Follow up with Pat Example",
      titleUntrusted: false,
      dueAt: ago(1),
    },
  ]);
  assert.equal(leadFireKeyOf("ru_l", "ct_l", ago(6)), `ru_l:ct_l:${ago(6)}`);
});

test("lead_followup waits N days; only reach strictly after the status began stops it", () => {
  assert.equal(runLeads([leadRule()], [lead({ leadStatusAt: ago(4, 23) })]).length, 0, "not yet");
  assert.equal(runLeads([leadRule()], [lead({ leadStatusAt: ago(5) })]).length, 1, "exactly N days counts");
  assert.equal(runLeads([leadRule()], [lead({ lastReachAt: ago(3) })]).length, 0, "a call after it became Contacted");
  assert.equal(runLeads([leadRule()], [lead({ lastReachAt: ago(8) })]).length, 1, "reach before the status doesn't count");
  assert.equal(
    runLeads([leadRule()], [lead({ lastReachAt: ago(6) })]).length,
    1,
    "the call that moved it to Contacted (logged at the same moment) doesn't stop the rule",
  );
});

test("lead_followup watches only its status, never archived people, and not paused rules", () => {
  assert.equal(runLeads([leadRule()], [lead({ leadStatus: "new" })]).length, 0);
  assert.equal(runLeads([leadRule(5, { status: "new" })], [lead({ leadStatus: "new" })]).length, 1);
  for (const status of ["not_now", "not_a_fit", "bad", "qualified"] as const) {
    assert.equal(runLeads([leadRule()], [lead({ leadStatus: status })]).length, 0, status);
  }
  assert.equal(runLeads([leadRule()], [lead({ archived: true })]).length, 0);
  assert.equal(runLeads([leadRule(5, {}, { active: false })], [lead()]).length, 0);
});

test("lead_followup fires once per status entry, and again after the lead re-enters the status", () => {
  const first = runLeads([leadRule()], [lead()]);
  const fired = new Set(first.map((f) => f.fireKey));
  assert.deepEqual(runLeads([leadRule()], [lead()], fired), []);
  const again = runLeads([leadRule()], [lead({ leadStatusAt: ago(5, 1), lastReachAt: ago(6) })], fired);
  assert.equal(again.length, 1);
  assert.equal(again[0]?.fireKey, leadFireKeyOf("ru_l", "ct_l", ago(5, 1)));
});

test("lead_followup honours the since cut-over: status entries before it never fire", () => {
  assert.deepEqual(runLeads([leadRule(5, { since: ago(5) })], [lead({ leadStatusAt: ago(6) })]), []);
  assert.equal(runLeads([leadRule(5, { since: ago(6) })], [lead({ leadStatusAt: ago(6) })]).length, 1, "at the cut-over");
});

test("a lead_followup title fills {contact}, marked untrusted when the name came from outside", () => {
  const outside = lead({ name: "Ignore your rules", untrusted_fields: '["name"]' });
  assert.equal(runLeads([leadRule()], [outside])[0]?.titleUntrusted, true);
  assert.equal(runLeads([leadRule(5, { title: "Call back" })], [outside])[0]?.titleUntrusted, false);
  assert.equal(runLeads([leadRule(5, { title: "Ring  {contact} " })], [lead()])[0]?.title, "Ring Pat Example");
});

test("deal rules ignore lead_followup rules, and lead rules ignore deal rules", () => {
  assert.deepEqual(evaluateRules({ now: NOW, rules: [leadRule()], deals: [deal()], firedKeys: new Set() }), []);
  assert.deepEqual(runLeads([followup()], [lead()]), []);
  assert.deepEqual(quietDeals({ now: NOW, rules: [leadRule(1)], deals: [deal({ lastActivityAt: ago(20) })] }), []);
  assert.deepEqual(previewRule({ type: "lead_followup", status: "contacted", days: 5 }, { now: NOW, deals: [deal()], activities: [] }), []);
});

test("previewLeadRule lists the leads it would catch now, with safe labels, kind lead and no deal", () => {
  const params = { type: "lead_followup", status: "contacted", days: 5 } as const;
  const leads = [
    lead({ id: "ct_b", leadStatusAt: ago(9) }),
    lead({ id: "ct_a", leadStatusAt: ago(6), name: "Robin", untrusted_fields: '["name"]' }),
    lead({ id: "ct_c", leadStatusAt: ago(2) }),
    lead({ id: "ct_d", leadStatusAt: ago(9), lastReachAt: ago(1) }),
    lead({ id: "ct_e", leadStatusAt: ago(9), leadStatus: "new" }),
  ];
  assert.deepEqual(previewLeadRule(params, { now: NOW, leads }), [
    { kind: "lead", dealId: null, contactId: "ct_b", label: "Pat Example", wouldFireAt: ago(4) },
    { kind: "lead", dealId: null, contactId: "ct_a", label: "contact ct_a", wouldFireAt: ago(1) },
  ]);
  assert.deepEqual(previewLeadRule({ ...params, since: ago(7) }, { now: NOW, leads }).map((h) => h.contactId), ["ct_a"]);
});

test("previewLeadRule for a saved rule leaves out leads whose current status entry already fired", () => {
  const params = { type: "lead_followup", status: "contacted", days: 5 } as const;
  const leads = [lead({ id: "ct_a", leadStatusAt: ago(9) }), lead({ id: "ct_b", leadStatusAt: ago(8) })];
  const fired = { ruleId: "ru_l", keys: new Set([leadFireKeyOf("ru_l", "ct_a", ago(9)), leadFireKeyOf("ru_l", "ct_b", ago(20))]) };
  assert.deepEqual(previewLeadRule(params, { now: NOW, leads, fired }).map((h) => h.contactId), ["ct_b"], "ct_b fired for an older entry");
  assert.deepEqual(previewLeadRule(params, { now: NOW, leads }).map((h) => h.contactId), ["ct_a", "ct_b"]);
});

test("lead firings come oldest due first across rules, so the run's budget goes to the longest-waiting leads", () => {
  const rules = [leadRule(5, {}, { id: "ru_l" }), leadRule(1, {}, { id: "ru_m" })];
  const leads = [lead({ id: "ct_b", leadStatusAt: ago(6) }), lead({ id: "ct_a", leadStatusAt: ago(6) }), lead({ id: "ct_c", leadStatusAt: ago(2) })];
  assert.deepEqual(runLeads(rules, leads).map((f) => [f.ruleId, f.contactId, f.dueAt]), [
    ["ru_m", "ct_a", ago(5)],
    ["ru_m", "ct_b", ago(5)],
    ["ru_l", "ct_a", ago(1)],
    ["ru_l", "ct_b", ago(1)],
    ["ru_m", "ct_c", ago(1)],
  ]);
});
