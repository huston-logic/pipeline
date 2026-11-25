// The free plan allows 50 D1 calls per Worker invocation (docs/PAID-PLAN.md, "Run 6: proposals and D1 calls"); a
// proposal's propose and apply must stay at most 40, leaving room for the request's own sign-in and settings reads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type CountingDb, countingDb } from "../../tests/helpers/counting-db.ts";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { WORK_TYPES_SQL } from "../../tests/helpers/time-seed.ts";
import { createTestDb } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import type { Ctx } from "./change.ts";
import type { RecordAction } from "./proposal-actions.ts";
import { undoChange } from "./undo.ts";
import { applyChanges,PROPOSAL_MAX_ACTIONS, proposeChanges } from "./proposals.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const DEPS = { extraOwnerEmails: [] };

/** A day's ramble, by names as the AI app sends them: every kind the brief names, a lead with an "@n" task, time on. */
const RAMBLE: RecordAction[] = [
  { action: "add_lead", name: "Lee Example", business: "Lee Example Signs", source: "drove past" },
  { action: "add_task", contact: "@1", title: "Call Lee back", dueAt: "2026-11-21" },
  { action: "log_activity", deal: "Pat", type: "call", summary: "Pat wants a quote by Friday." },
  { action: "update_deal", deal: "Pat", stage: "Proposal sent" },
  { action: "add_task", contact: "Pat", title: "Send Pat the booking page examples" },
  { action: "complete_task", task: "Prepare questions for Pat's call" },
  { action: "log_activity", deal: "Casey", type: "email", summary: "Sent Casey the price sheet." },
  { action: "complete_task", task: "Send Casey the price sheet" },
  { action: "update_deal", deal: "Casey", nextStep: "Follow up on the price", nextAt: "2026-11-24" },
  { action: "log_activity", deal: "Jordan", type: "meeting", summary: "Went through the store layout." },
  { action: "update_deal", deal: "Jordan", value: 2600 },
  { action: "complete_task", task: "Write the proposal for Jordan" },
  { action: "update_contact", contact: "Jordan", phone: "+1 555 0100" },
  { action: "log_activity", contact: "Morgan", type: "note", summary: "Morgan called about spring." },
  { action: "complete_task", task: "Find Morgan's business card" },
  { action: "update_contact", contact: "Morgan", source: "referral" },
  { action: "add_task", contact: "Taylor", title: "Ask Taylor about the menu photos", dueAt: "2026-11-23" },
  { action: "log_activity", deal: "Taylor", type: "call", summary: "Taylor is still deciding." },
  { action: "update_deal", deal: "Taylor", nextStep: "Call Taylor again" },
  { action: "add_time_entry", deal: "Pat", startedAt: "2026-11-19T08:00", minutes: 45, workType: "Design", notes: "Booking page mock-up." },
  { action: "add_time_entry", deal: "Jordan", startedAt: "2026-11-19T09:00", minutes: 30, workType: "Admin" },
  { action: "add_lead", name: "Kim Example", business: "Kim Example Florist" },
  { action: "log_activity", contact: "@22", type: "call", summary: "Kim asked for a price." },
  { action: "add_task", title: "Buy printer ink", dueAt: "2026-11-21" },
  { action: "log_activity", contact: "Alex", type: "note", summary: "Alex sent a thank-you card." },
];

async function seeded(more = ""): Promise<CountingDb> {
  const raw = await createTestDb();
  raw.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  raw.exec(`UPDATE settings SET time_tracking = 1; ${WORK_TYPES_SQL}`);
  if (more !== "") raw.exec(more);
  return countingDb(raw);
}

const ctxFor = (db: Ctx["db"], tool: string): Ctx => ({ db, now: NOW, actor: "ai", tool });

type Measured = { propose: number; apply: number; log: { propose: string[]; apply: string[] } };

async function measure(actions: RecordAction[], more = ""): Promise<Measured> {
  const db = await seeded(more);
  const answer = await proposeChanges(ctxFor(db, "propose_changes"), { actions }, DEPS);
  assert.equal(answer.kind, "proposal", JSON.stringify(answer));
  const propose = db.calls;
  const proposeLog = [...db.log];
  db.reset();
  const result = await applyChanges(ctxFor(db, "apply_changes"), answer.kind === "proposal" ? answer.id : "", DEPS);
  assert.equal(result.applied, actions.length);
  return { propose, apply: db.calls, log: { propose: proposeLog, apply: [...db.log] } };
}

function assertAtMost(measured: Measured, most: number): void {
  const { propose, apply, log } = measured;
  assert.ok(propose <= most, `propose made ${propose} D1 calls:\n${log.propose.join("\n")}`);
  assert.ok(apply <= most, `apply made ${apply} D1 calls:\n${log.apply.join("\n")}`);
}

test("a maximum-size proposal makes at most 40 D1 calls to propose and 40 to apply", async () => {
  const actions = RAMBLE.slice(0, PROPOSAL_MAX_ACTIONS);
  assert.equal(actions.length, PROPOSAL_MAX_ACTIONS, "the ramble fills a proposal");
  assertAtMost(await measure(actions), 40);
});

/** Projects (decision 0055): three the list adds, one on file named by its name, each with tasks, notes and time. */
const PROJECT_LIST: RecordAction[] = [
  { action: "add_project", contact: "Pat", name: "Fence repair", targetAt: "2026-12-20" },
  { action: "add_task", project: "@1", title: "Order posts" },
  { action: "add_task", project: "@1", title: "Dig the holes", dueAt: "2026-11-21" },
  { action: "log_activity", project: "@1", type: "note", summary: "Pat approved the layout." },
  { action: "start_timer", project: "@1", workType: "Design" },
  { action: "add_time_entry", project: "@1", startedAt: "2026-11-19T08:00", minutes: 30, workType: "Design" },
  { action: "add_project", contact: "Casey", name: "Garden path" },
  { action: "add_task", project: "@7", title: "Pick the stones" },
  { action: "log_activity", project: "@7", type: "call", summary: "Casey called about the stones." },
  { action: "add_time_entry", project: "@7", startedAt: "2026-11-19T09:00", minutes: 20, workType: "Admin" },
  { action: "add_task", project: "Retrofit", title: "Order anchors" },
  { action: "log_activity", project: "Retrofit", type: "note", summary: "Anchors are on back order." },
  { action: "add_time_entry", project: "Retrofit", startedAt: "2026-11-19T09:30", minutes: 25, workType: "Design" },
  { action: "update_project", project: "Retrofit", status: "done" },
  { action: "add_project", contact: "Jordan", name: "Bike rack" },
  { action: "add_task", project: "@15", title: "Measure the wall" },
  { action: "add_task", project: "@15", title: "Order the rack" },
  { action: "add_task", project: "Retrofit", title: "Send the invoice" },
  { action: "log_activity", project: "@15", type: "note", summary: "Jordan picked a colour." },
  ...RAMBLE.slice(2, 8),
];

test("a maximum-size list of projects, with tasks, notes and time on them, stays at most 40 D1 calls each way", async () => {
  assert.equal(PROJECT_LIST.length, PROPOSAL_MAX_ACTIONS);
  const more = "UPDATE settings SET projects = 1; INSERT INTO projects (id, name, contact_id, status_key) VALUES ('pj_seed01', 'Retrofit', 'ct_seed01', 'active')";
  assertAtMost(await measure(PROJECT_LIST, more), 40);
});

/** 100 tasks in tens: a top task, two under it, one of those with three under it (three deep), some with dueDays. */
const PLAN_TASKS = Array.from({ length: 100 }, (_, i) => {
  const base = i - (i % 10);
  const r = i % 10;
  const under = r === 0 ? undefined : r <= 2 ? base + 1 : r <= 5 ? base + 2 : base + 1;
  return { title: `Step ${i + 1}`, ...(under === undefined ? {} : { under }), ...(i % 2 === 0 ? { dueDays: i } : {}) };
});

const statementsOf = (log: readonly string[]): number => log.reduce((sum, sql) => sum + (/^batch\((\d+)\)$/.exec(sql)?.[1] ? Number(/\d+/.exec(sql)?.[0]) : 1), 0);

test("a project and a 100-task plan stay at most 40 D1 calls each way, apply as one bulk change and undo as one", async () => {
  const actions: RecordAction[] = [
    { action: "add_project", contact: "Pat", name: "Harbor kitchen", startAt: "2026-12-01" },
    { action: "add_task_plan", project: "@1", tasks: PLAN_TASKS },
  ];
  const db = await seeded("UPDATE settings SET projects = 1");
  const answer = await proposeChanges(ctxFor(db, "propose_changes"), { actions }, DEPS);
  assert.equal(answer.kind, "proposal", JSON.stringify(answer));
  const proposeCalls = db.calls;
  const proposeStatements = statementsOf(db.log);
  db.reset();
  const result = await applyChanges(ctxFor(db, "apply_changes"), answer.kind === "proposal" ? answer.id : "", DEPS);
  assert.equal(result.applied, 2);
  const applyCalls = db.calls;
  const applyStatements = statementsOf(db.log);
  assert.ok(proposeCalls <= 40, `propose made ${proposeCalls} D1 calls (${proposeStatements} statements)`);
  assert.ok(applyCalls <= 40, `apply made ${applyCalls} D1 calls (${applyStatements} statements)`);
  const rows = async () => (await db.prepare("SELECT (SELECT count(*) FROM projects WHERE name = 'Harbor kitchen') AS p, (SELECT count(*) FROM tasks WHERE project_id IS NOT NULL AND title LIKE 'Step %') AS t").first<{ p: number; t: number }>()) ?? { p: -1, t: -1 };
  assert.deepEqual({ ...(await rows()) }, { p: 1, t: 100 });
  await undoChange({ db, now: NOW, actor: "owner", tool: "undo_change" }, result.changeId);
  assert.deepEqual({ ...(await rows()) }, { p: 0, t: 0 });
});

test("a one-action proposal makes at most 12 D1 calls to propose and 12 to apply", async () => {
  assertAtMost(await measure([{ action: "log_activity", deal: "Pat", type: "call", summary: "Pat wants a quote by Friday." }]), 12);
});

test("a maximum-size list with every action on a different deal stays at most 40 D1 calls each way", async () => {
  const people = Array.from({ length: PROPOSAL_MAX_ACTIONS }, (_, i) => i + 10);
  const more = people
    .map(
      (n) =>
        `INSERT INTO contacts (id, name) VALUES ('ct_many${n}', 'Person${n} Example'); ` +
        `INSERT INTO deals (id, contact_id, title, stage_key, stage_entered_at) VALUES ('dl_many${n}', 'ct_many${n}', 'Deal ${n}', 'new_inquiry', '2026-11-01T00:00:00.000Z');`,
    )
    .join(" ");
  const actions: RecordAction[] = people.map((n, i) =>
    i % 3 === 0
      ? { action: "log_activity", deal: `Person${n}`, type: "call", summary: "Called about the quote." }
      : i % 3 === 1
        ? { action: "update_deal", deal: `Person${n}`, nextStep: "Send the quote" }
        : { action: "add_task", deal: `Person${n}`, title: "Send the quote" },
  );
  assertAtMost(await measure(actions, more), 40);
});
