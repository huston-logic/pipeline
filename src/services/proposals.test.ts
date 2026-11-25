import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { WORK_TYPES_SQL } from "../../tests/helpers/time-seed.ts";
import { type AuditRow, type Db, type ProposalRow, TABLE_NAMES } from "../db/db.ts";
import { createTestDb, type SqliteD1, type SqliteStatement } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import type { ChangeInput, Ctx, Row } from "./change.ts";
import { updateContact } from "./contacts.ts";
import type { RecordAction } from "./proposal-actions.ts";
import { runAction } from "./proposal-actions.ts";
import {
  applyChanges,
  checkListShows,
  deleteExpiredProposals,
  isTrialSentinel,
  PROPOSAL_MAX_OPEN,
  PROPOSAL_TTL_MS,
  type ProposeAnswer,
  proposeChanges,
  TRIAL_SENTINEL,
} from "./proposals.ts";
import { shownList } from "./proposal-text.ts";
import { updateSettings } from "./settings.ts";
import { updateStage } from "./stages.ts";
import { undoChange } from "./undo.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const DEPS = { extraOwnerEmails: [] };

const ctxFor = (db: Db, now = NOW, tool = "propose_changes"): Ctx => ({ db, now, actor: "ai", tool });

async function setup(): Promise<SqliteD1> {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  return db;
}

type Counts = Record<(typeof TABLE_NAMES)[number], number>;

async function counts(db: Db): Promise<Counts> {
  const out: Partial<Counts> = {};
  for (const table of TABLE_NAMES) out[table] = (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>("n")) ?? -1;
  return out as Counts;
}

/** A timer on Pat's deal, running since 8:30 AM (Design, billable). */
const RUNNING_ON_PAT =
  "INSERT INTO time_entries (id, contact_id, deal_id, started_at, work_type_id, billable, version, created_at, updated_at) " +
  "VALUES ('te_running', 'ct_seed01', 'dl_seed01', '2026-11-19T16:30:00.000Z', 'wt_design', 1, 1, '2026-11-19T16:30:00.000Z', '2026-11-19T16:30:00.000Z')";

const audits = async (db: Db) => (await db.prepare("SELECT * FROM audit_log ORDER BY rowid").all<AuditRow>()).results;
const proposal = async (db: Db, id: string) => db.prepare("SELECT * FROM proposals WHERE id = ?").bind(id).first<ProposalRow>();

function proposed(answer: ProposeAnswer): Extract<ProposeAnswer, { kind: "proposal" }> {
  assert.equal(answer.kind, "proposal", JSON.stringify(answer));
  return answer as Extract<ProposeAnswer, { kind: "proposal" }>;
}

const propose = async (db: Db, actions: RecordAction[], replaces?: string, now = NOW) =>
  proposed(await proposeChanges(ctxFor(db, now), replaces === undefined ? { actions } : { actions, replaces }, DEPS));

const apply = (db: Db, id: string, now = NOW) => applyChanges(ctxFor(db, now, "apply_changes"), id, DEPS);

/** Pat's day: a task on Pat, a call logged on Pat's deal, and that deal moved to Proposal sent. */
const PATS_DAY: RecordAction[] = [
  { action: "add_task", contact: "Pat", title: "Send Pat the booking page examples" },
  { action: "log_activity", deal: "Pat", type: "call", summary: "Pat wants a quote by Friday." },
  { action: "update_deal", deal: "Pat", stage: "Proposal sent" },
];

test("proposal writes nothing", async () => {
  const db = await setup();
  const before = await counts(db);
  const answer = await propose(db, PATS_DAY);
  assert.match(answer.id, /^pr_[a-z2-7]{12}$/);
  assert.equal(answer.expiresAt, new Date(NOW.getTime() + PROPOSAL_TTL_MS).toISOString());
  assert.deepEqual(await counts(db), { ...before, proposals: before.proposals + 1 });
  const row = await proposal(db, answer.id);
  assert.equal(row?.status, "open");
  // Stored resolved: names became ids.
  const actions = JSON.parse(row?.actions ?? "[]") as Record<string, unknown>[];
  assert.deepEqual(actions.map((a) => a.contact ?? a.deal), ["ct_seed01", "dl_seed01", "dl_seed01"]);
  const reads = JSON.parse(row?.reads ?? "{}") as Record<string, number | null>;
  assert.equal(reads["deals:dl_seed01"], 1);
  assert.equal(Object.values(reads).filter((v) => v === null).length, 3, "a task, a call and a stage change are added");

  assert.match(answer.text, /^Proposal pr_[a-z2-7]{12} \(expires 12:00 PM\)\. Nothing has changed yet\.\n\n/);
  assert.match(answer.text, /\nUpdate\n- Deal "Website refresh for Example Plumbing" \(Pat Example\): stage Call booked -> Proposal sent\n/);
  assert.match(answer.text, /\nTasks\n- New task "Send Pat the booking page examples": for Pat Example; due \(none\)\n/);
  assert.match(answer.text, /\nNotes\n- Call with Pat Example about "Website refresh for Example Plumbing": Pat wants a quote by Friday\.\n/);
  assert.ok(answer.text.endsWith(`(call apply_changes with ${answer.id}), "Yes with changes: ..." (send a revised list with replaces ${answer.id}), or "No" (apply nothing).`));
  assert.deepEqual(answer.list.add, []);
  assert.equal(answer.list.update[0]?.id, "dl_seed01");
});

test("apply writes once with one undo", async () => {
  const db = await setup();
  const deal = async () => db.prepare("SELECT * FROM deals WHERE id = 'dl_seed01'").first<Record<string, unknown>>();
  const original = await deal();
  const before = await counts(db);
  const { id } = await propose(db, PATS_DAY);

  const result = await apply(db, id);
  assert.equal(result.applied, 3);
  assert.match(result.summary, new RegExp(`^Applied ${id}: Added task "Send Pat the booking page examples" for Pat Example; Logged a call on `));
  assert.ok(result.summary.endsWith(`(change ${result.changeId})`));
  const log = await audits(db);
  assert.equal(log.length, 1, "one change");
  assert.deepEqual([log[0]?.id, log[0]?.actor, log[0]?.tool], [result.changeId, "ai", "apply_changes"]);
  const after = await counts(db);
  assert.equal(after.tasks, before.tasks + 1);
  assert.equal(after.activities, (before.activities ?? 0) + 2, "the call and the stage change");
  const moved = await deal();
  assert.equal(moved?.stage_key, "proposal_sent");
  assert.equal(moved?.version, 2, "one bump for two actions on the deal");
  assert.equal((await proposal(db, id))?.status, "applied");
  assert.equal((await proposal(db, id))?.change_id, result.changeId);

  const undone = await undoChange(ctxFor(db, NOW, "undo_change"), result.changeId);
  assert.match(undone.summary, /^Undid chg_/);
  const restored = await counts(db);
  assert.deepEqual({ ...restored, audit_log: before.audit_log, proposals: before.proposals }, before);
  const back = await deal();
  assert.deepEqual({ ...back, version: original?.version, updated_at: original?.updated_at }, original);
  await assert.rejects(undoChange(ctxFor(db, NOW, "undo_change"), result.changeId), /already undone/);
});

/** Rows of the record tables, in insertion order. */
async function recordRows(db: Db): Promise<Record<string, Record<string, unknown>[]>> {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const table of ["contacts", "deals", "projects", "activities", "tasks", "time_entries"]) {
    out[table] = (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all<Record<string, unknown>>()).results.map((row) => ({ ...row }));
  }
  return out;
}

/** Sam (lost deal) is a lead again, with no open deal: add_deal for an existing lead. */
async function samIsALead(db: Db): Promise<void> {
  await db
    .prepare("UPDATE contacts SET person_status = 'lead', sub_status = 'new', lead_status = 'new', lead_status_at = ? WHERE id = 'ct_seed08'")
    .bind(NOW.toISOString())
    .run();
}

test("apply equals running the actions one by one", async () => {
  const scenarios: RecordAction[][] = [
    [
      { action: "update_deal", deal: "dl_seed01", stage: "Proposal sent", nextStep: "Wait for the yes" },
      { action: "log_activity", deal: "dl_seed01", type: "call", summary: "Walked Pat through the proposal." },
    ],
    [
      { action: "add_deal", contact: "ct_seed08", dealTitle: "Repair shop booking page" },
      { action: "add_task", deal: "@1", title: "Send Sam a first sketch", dueAt: "2026-11-21" },
    ],
    [
      { action: "add_lead", name: "Lee Example", business: "Lee Example Signs", source: "drove past" },
      { action: "log_activity", contact: "@1", type: "call", summary: "Lee picked up and asked for a price." },
    ],
    [{ action: "complete_task", task: "tk_seed01" }],
    // A standalone task (decision 0046) beside one on a person.
    [
      { action: "add_task", title: "Buy printer ink", dueAt: "2026-11-21" },
      { action: "add_task", contact: "ct_seed01", title: "Send Pat the invoice" },
    ],
    // Time (decision 0049): a stop and a call on the same deal, an entry for a person the list adds, a timer started.
    [
      { action: "stop_timer", notes: "Homepage draft done.", nextStepDate: "2026-11-21" },
      { action: "log_activity", deal: "dl_seed01", type: "call", summary: "Walked Pat through the draft." },
    ],
    [
      { action: "add_lead", name: "Lee Example", business: "Lee Example Signs" },
      { action: "add_time_entry", contact: "@1", startedAt: "2026-11-19T08:00", minutes: 45, workType: "Design", notes: "Sign mock-ups." },
    ],
    [{ action: "start_timer", deal: "dl_seed01", workType: "Design" }],
    // Projects (decision 0055): a task on a project the list adds, and a project that takes a won deal's open tasks.
    [
      { action: "add_project", contact: "ct_seed01", name: "Fence repair", startAt: "2026-12-01" },
      { action: "add_task", project: "@1", title: "Order posts", dueAt: "2026-11-21" },
      { action: "log_activity", project: "@1", type: "note", summary: "Pat approved the layout." },
      { action: "add_time_entry", project: "@1", startedAt: "2026-11-19T08:00", minutes: 30, workType: "Design" },
    ],
    [{ action: "add_project", deal: "dl_seed07", name: "Salon launch", moveOpenTasks: true }],
    [{ action: "update_project", project: "pj_seed01", status: "done", targetAt: "2026-12-04", archived: true }],
  ];
  for (const actions of scenarios) {
    const one = await setup();
    const both = await setup();
    await samIsALead(one);
    await samIsALead(both);
    for (const db of [one, both]) {
      db.exec(`UPDATE settings SET time_tracking = 1, projects = 1; ${WORK_TYPES_SQL}`);
      db.exec(
        "INSERT INTO projects (id, name, contact_id, status_key, created_at, updated_at) VALUES ('pj_seed01', 'Retrofit', 'ct_seed01', 'active', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'); " +
          "INSERT INTO tasks (id, deal_id, contact_id, title, created_at, updated_at) VALUES ('tk_won1', 'dl_seed07', 'ct_seed07', 'Hang the sign', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')",
      );
      if (actions.some((action) => action.action === "stop_timer")) db.exec(RUNNING_ON_PAT);
    }
    const seed = await recordRows(one);

    // A: each action through its service, one change each, "@n" bound to the id action n added.
    const added: { contactId?: string; dealId?: string | null; projectId?: string }[] = [];
    for (const action of actions) {
      const bound = Object.fromEntries(
        Object.entries(action).map(([key, value]) => {
          const ref = typeof value === "string" ? /^@(\d+)$/.exec(value) : null;
          const earlier = ref ? added[Number(ref[1]) - 1] : undefined;
          return [key, earlier === undefined ? value : key === "deal" ? earlier.dealId : key === "project" ? earlier.projectId : earlier.contactId];
        }),
      ) as RecordAction;
      added.push(await runAction(ctxFor(one, NOW, bound.action), bound, DEPS));
    }
    // B: proposed, then applied as one change.
    const { id } = await propose(both, actions);
    await apply(both, id);

    const a = await recordRows(one);
    const b = await recordRows(both);
    // New rows have new ids on each side: map A's onto B's by position.
    const ids = new Map<unknown, unknown>();
    for (const table of Object.keys(b)) (a[table] ?? []).forEach((row, i) => ids.set(row.id, b[table]?.[i]?.id));
    for (const table of Object.keys(a)) {
      const rowsA = a[table] ?? [];
      const rowsB = b[table] ?? [];
      assert.equal(rowsA.length, rowsB.length, `${table}: same number of rows`);
      rowsA.forEach((rowA, i) => {
        const rowB = rowsB[i] ?? {};
        const mapped = Object.fromEntries(Object.entries(rowA).map(([k, v]) => [k, ids.get(v) ?? v]));
        assert.deepEqual({ ...mapped, version: 0 }, { ...rowB, version: 0 }, `${table} row ${i + 1}: ${JSON.stringify(actions)}`);
        const seedRow = (seed[table] ?? []).find((row) => row.id === rowB.id);
        const touched = seedRow === undefined || JSON.stringify(seedRow) !== JSON.stringify(rowB);
        const expected = seedRow === undefined ? 1 : touched ? Number(seedRow.version) + 1 : Number(seedRow.version);
        assert.equal(rowB.version, expected, `${table} row ${i + 1}: one bump per row in the proposal`);
      });
    }
    assert.equal((await audits(both)).length, 1);
  }
});

test("time shows in the Time group, from the rows the plan would write", async () => {
  const db = await setup();
  db.exec(`UPDATE settings SET time_tracking = 1; ${WORK_TYPES_SQL}`);
  const entry = await propose(db, [{ action: "add_time_entry", contact: "Pat", startedAt: "2026-11-19T07:30", endedAt: "2026-11-19T09:00", workType: "Design" }]);
  assert.equal(entry.text.split("\n").slice(2, 4).join("\n"), "Time\n- Time 1 h 30 min, Design, billable at $95.00/h ($142.50), for Pat Example: started Thu Nov 19, 7:30 AM");
  assert.equal(entry.list.time[0]?.id.startsWith("te_"), true);

  const timer = await propose(db, [{ action: "start_timer", deal: "dl_seed01" }]);
  assert.equal(timer.text.split("\n").slice(2, 4).join("\n"), 'Time\n- Timer started now, for "Website refresh for Example Plumbing" (Pat Example)');

  db.exec(RUNNING_ON_PAT);
  const stop = await propose(db, [{ action: "stop_timer", notes: "Homepage draft done.", nextStepDate: "2026-11-21" }]);
  assert.equal(
    stop.text.split("\n").slice(2, 7).join("\n"),
    [
      "Tasks",
      '- New task "Next step: Website refresh for Example Plumbing": for "Website refresh for Example Plumbing" (Pat Example); due Sat Nov 21',
      'Notes',
      '- Note on Pat Example about "Website refresh for Example Plumbing": Homepage draft done.',
      "Time",
    ].join("\n"),
  );
  assert.ok(stop.text.includes('\n- Time 1 h 30 min, Design, billable at $95.00/h ($142.50), for "Website refresh for Example Plumbing" (Pat Example): notes Homepage draft done.\n'));
  // Stored with the end it was asked at, so a later yes stores the same span.
  const stored = JSON.parse((await proposal(db, stop.id))?.actions ?? "[]") as Record<string, unknown>[];
  assert.equal(stored[0]?.endedAt, NOW.toISOString());
  const later = await apply(db, stop.id, new Date(NOW.getTime() + 30 * 60_000));
  assert.equal(later.applied, 1);
  assert.equal(await db.prepare("SELECT minutes FROM time_entries WHERE id = 'te_running'").first("minutes"), 90);
});

test("a time entry's task shows on its line, and a task-only edit lists the task change", async () => {
  const db = await setup();
  db.exec(`UPDATE settings SET time_tracking = 1; ${WORK_TYPES_SQL}`);
  const added = await propose(db, [{ action: "add_time_entry", task: "tk_seed01", startedAt: "2026-11-19T08:00", minutes: 15 }]);
  assert.equal(
    added.text.split("\n").slice(2, 4).join("\n"),
    'Time\n- Time 15 min, not billable, for "Website refresh for Example Plumbing" (Pat Example): task "Prepare questions for Pat\'s call"; started Thu Nov 19, 8:00 AM',
  );

  db.exec(
    "INSERT INTO time_entries (id, contact_id, deal_id, started_at, ended_at, minutes, work_type_id, billable, rate, version, created_at, updated_at) " +
      "VALUES ('te_seeded', 'ct_seed01', 'dl_seed01', '2026-11-19T15:00:00.000Z', '2026-11-19T16:00:00.000Z', 60, 'wt_design', 1, 95, 1, 'x', 'x')",
  );
  const linked = await propose(db, [{ action: "update_time_entry", entry: "te_seeded", task: "tk_seed01" }]);
  assert.equal(
    linked.text.split("\n").slice(2, 4).join("\n"),
    'Time\n- Time 1 h, Design, billable at $95.00/h ($95.00), for "Website refresh for Example Plumbing" (Pat Example): task (none) -> "Prepare questions for Pat\'s call"',
  );
  await apply(db, linked.id);
  const cleared = await propose(db, [{ action: "update_time_entry", entry: "te_seeded", task: null }]);
  assert.match(cleared.text, /\n- Time 1 h, [^\n]*: task "Prepare questions for Pat's call" -> \(none\)\n/);
});

test("a list that would write a column it doesn't show is refused: nothing is proposed", async () => {
  const db = await setup();
  const deal = await db.prepare("SELECT * FROM deals WHERE id = 'dl_seed01'").first<Row>();
  assert.ok(deal);
  // A change whose only write is a column the list never shows (a deal's last-contact time): nothing to show, no gap.
  const touched = { table: "deals" as const, id: "dl_seed01", before: deal, after: { ...deal, last_activity_at: NOW.toISOString(), version: Number(deal.version) + 1 } };
  const quiet = await shownList(db, { target: { table: "deals", id: "dl_seed01" }, summary: "", changes: [touched] }, DEFAULT_TZ, NOW);
  assert.deepEqual(Object.values(quiet.list).flat(), [], "the renderer skips it");
  assert.deepEqual(quiet.unshown, []);
  // A task added with a rule's source: the list shows the task, but not that a rule made it.
  const task: Row = { id: "tk_new", deal_id: "dl_seed01", contact_id: "ct_seed01", title: "Call Pat", due_at: null, done_at: null, snoozed_until: null, source: "ru_seed01", untrusted_fields: "[]", version: 1, created_at: NOW.toISOString(), updated_at: NOW.toISOString() };
  const input: ChangeInput = { target: { table: "tasks", id: "tk_new" }, summary: "", changes: [touched, { table: "tasks", id: "tk_new", before: null, after: task }] };
  const { list, unshown } = await shownList(db, input, DEFAULT_TZ, NOW);
  assert.equal(list.tasks.length, 1);
  assert.deepEqual(unshown, ["tasks:tk_new source"]);
  assert.throws(() => checkListShows(unshown), /^Error: This list would change records it doesn't show\. Nothing was proposed\.$/);
  assert.doesNotThrow(() => checkListShows([]));
});

test("a timer started by another write while the list is made is the timer's own refusal; at apply, a fresh-list answer", async () => {
  const db = await setup();
  db.exec("UPDATE settings SET time_tracking = 1");
  const other = async () =>
    void (await db
      .prepare("INSERT INTO time_entries (id, contact_id, started_at, version, created_at, updated_at) VALUES ('te_other', 'ct_seed03', ?, 1, ?, ?)")
      .bind(NOW.toISOString(), NOW.toISOString(), NOW.toISOString())
      .run());
  await assert.rejects(
    proposeChanges(ctxFor(racing(db, other)), { actions: [{ action: "start_timer", contact: "ct_seed01" }] }, DEPS),
    /^UserError: A timer is already running for Casey Placeholder since 10:00 AM\. Stop it first\.$/,
  );
  assert.equal((await counts(db)).proposals, 0);

  db.exec("DELETE FROM time_entries");
  const { id } = await propose(db, [{ action: "start_timer", contact: "ct_seed01" }]);
  await assert.rejects(
    applyChanges(ctxFor(racing(db, other), NOW, "apply_changes"), id, DEPS),
    /^UserError: A record in this list changed since this list was made\. Propose the changes again and show the owner the new list\.$/,
  );
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM time_entries").first("n"), 1, "only the other timer");
});

test("a timer started in a list can't be stopped in the same list", async () => {
  const db = await setup();
  db.exec("UPDATE settings SET time_tracking = 1");
  await assert.rejects(
    proposeChanges(ctxFor(db), { actions: [{ action: "start_timer", contact: "ct_seed01" }, { action: "stop_timer" }] }, DEPS),
    /^UserError: Action 2: A timer started in this list can't be stopped in the same list\. Use add_time_entry with the start and end instead\.$/,
  );
});

test("a standalone task: the list says no person or deal, and complete or snooze by its title work through a proposal", async () => {
  const db = await setup();
  const added = await propose(db, [{ action: "add_task", title: "Buy printer ink", dueAt: "2026-11-21" }]);
  assert.equal(
    added.text.split("\n").slice(2, 4).join("\n"),
    'Tasks\n- New task "Buy printer ink": no person or deal; due Sat Nov 21',
  );
  const first = await apply(db, added.id);
  assert.match(first.summary, new RegExp(`^Applied ${added.id}: Added task "Buy printer ink", due Sat Nov 21, 12:00 AM \\(change `));
  const taskId = await db.prepare("SELECT id FROM tasks WHERE title = 'Buy printer ink'").first<string>("id");
  assert.ok(taskId);

  // Named by its title: the match needs no person or deal.
  const snooze = await propose(db, [{ action: "snooze_task", task: "printer ink", until: "2026-11-20T09:00" }]);
  assert.equal(JSON.parse((await proposal(db, snooze.id))?.actions ?? "[]")[0]?.task, taskId);
  assert.equal(snooze.text.split("\n").slice(2, 4).join("\n"), 'Tasks\n- Task "Buy printer ink": snoozed until (none) -> Fri Nov 20, 9:00 AM');
  const snoozed = await apply(db, snooze.id);
  assert.match(snoozed.summary, /: Snoozed task "Buy printer ink" until Fri Nov 20, 9:00 AM \(change /);

  const done = await propose(db, [{ action: "complete_task", task: "Buy printer ink" }]);
  assert.equal(done.text.split("\n").slice(2, 4).join("\n"), 'Tasks\n- Task "Buy printer ink": done (none) -> now');
  const completed = await apply(db, done.id);
  assert.match(completed.summary, /: Completed task "Buy printer ink" \(change /);
  assert.equal(await db.prepare("SELECT done_at FROM tasks WHERE id = ?").bind(taskId).first("done_at"), NOW.toISOString());
});

test("stale proposal is refused", async () => {
  const db = await setup();
  const { id } = await propose(db, [{ action: "update_contact", contact: "Pat Example", phone: "555-0199" }]);
  await updateContact({ db, now: NOW, actor: "owner", tool: "update_contact" }, "ct_seed01", { notes: "Prefers mornings." });
  const before = (await audits(db)).length;
  await assert.rejects(
    apply(db, id),
    /^UserError: Contact Pat Example changed since this list was made\. Propose the changes again and show the owner the new list\.$/,
  );
  assert.equal((await audits(db)).length, before, "no new change");
  assert.equal((await proposal(db, id))?.status, "open");
});

test("ambiguous name becomes a question", async () => {
  const db = await setup();
  db.exec(
    "INSERT INTO contacts (id, name, email) VALUES ('ct_dana1', 'Dana Example', 'dana@example.com'), ('ct_dana2', 'Dana Sample', 'dana.sample@example.org')",
  );
  const answer = await proposeChanges(ctxFor(db), { actions: [{ action: "add_task", contact: "Dana", title: "Call Dana back" }] }, DEPS);
  assert.equal(answer.kind, "questions");
  const [question, ...others] = answer.kind === "questions" ? answer.questions : [];
  assert.deepEqual(others, []);
  assert.ok(question?.startsWith("Which Dana? "), question);
  assert.match(question ?? "", /ct_dana1/);
  assert.match(question ?? "", /ct_dana2/);
  assert.match(question ?? "", /Send the list again with the id\.$/);
  assert.equal((await counts(db)).proposals, 0);
});

test("apply twice writes once", async () => {
  const db = await setup();
  const { id } = await propose(db, PATS_DAY);
  const first = await apply(db, id);
  const second = await apply(db, id);
  assert.equal(second.changeId, first.changeId);
  assert.equal(second.applied, 0);
  assert.match(second.summary, new RegExp(`^${id} was already applied: Applied ${id}: `));
  assert.equal((await audits(db)).length, 1);
});

test("expired proposal is refused", async () => {
  const db = await setup();
  const { id } = await propose(db, PATS_DAY);
  const late = new Date(NOW.getTime() + PROPOSAL_TTL_MS + 60_000);
  await assert.rejects(
    apply(db, id, late),
    new RegExp(`^UserError: ${id} expired at 12:00 PM\\. Propose the changes again and show the owner the new list\\.$`),
  );
  assert.equal((await audits(db)).length, 0);
});

test("replaces drops the old one", async () => {
  const db = await setup();
  const first = await propose(db, PATS_DAY);
  const second = await propose(db, PATS_DAY.slice(0, 2), first.id);
  const old = await proposal(db, first.id);
  assert.deepEqual([old?.status, old?.replaced_by], ["dropped", second.id]);
  await assert.rejects(apply(db, first.id), new RegExp(`^UserError: ${first.id} was replaced by ${second.id}\\. Apply ${second.id} if the owner said yes to it\\.$`));
  await assert.rejects(propose(db, PATS_DAY, first.id), /isn't open/);
  assert.equal((await apply(db, second.id)).applied, 2);
});

test("an action's refusal names the action", async () => {
  const db = await setup();
  await assert.rejects(
    proposeChanges(ctxFor(db), { actions: [PATS_DAY[0] as RecordAction, { action: "complete_task", task: "tk_seed06" }] }, DEPS),
    /^UserError: Action 2: Task "Send Alex the welcome pack" is already done/,
  );
  // The duplicate checks see what earlier actions plan: the second add of one email is refused as it would be alone.
  await assert.rejects(
    propose(db, [
      { action: "add_lead", name: "Lee Example", email: "lee@example.com" },
      { action: "add_contact", name: "Lee Again", email: "LEE@example.com" },
    ]),
    /^UserError: Action 2: Lee Example \(ct_[a-z2-7]{12}, lee@example\.com\) already uses that email\./,
  );
  assert.equal((await counts(db)).proposals, 0);
});

/** Ten open one-task proposals, one second apart (oldest first). */
async function tenOpen(db: Db) {
  const ids: string[] = [];
  for (let i = 0; i < PROPOSAL_MAX_OPEN; i++) {
    const at = new Date(NOW.getTime() + i * 1000);
    ids.push((await propose(db, [{ action: "add_task", contact: "ct_seed01", title: `Task ${i + 1}` }], undefined, at)).id);
  }
  return ids;
}

const openCount = async (db: Db, now = NOW) =>
  (await db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'open' AND expires_at > ?").bind(now.toISOString()).first<number>("n")) ?? -1;

test("the 11th open proposal drops the oldest", async () => {
  const db = await setup();
  const ids = await tenOpen(db);
  const at = new Date(NOW.getTime() + 60_000);
  const eleventh = await propose(db, PATS_DAY, undefined, at);
  assert.equal(await openCount(db, at), PROPOSAL_MAX_OPEN, "still exactly ten open");
  const oldest = await proposal(db, ids[0] ?? "");
  assert.deepEqual([oldest?.status, oldest?.replaced_by], ["dropped", eleventh.id]);
  await assert.rejects(
    apply(db, ids[0] ?? "", at),
    new RegExp(`^UserError: ${ids[0]} was replaced by ${eleventh.id}\\. Apply ${eleventh.id} if the owner said yes to it\\.$`),
  );
  for (const id of ids.slice(1)) assert.equal((await apply(db, id, at)).applied, 1, id);
  assert.equal((await apply(db, eleventh.id, at)).applied, 3);
});

test("a list with replaces at the cap drops only the one it replaces", async () => {
  const db = await setup();
  const ids = await tenOpen(db);
  const at = new Date(NOW.getTime() + 60_000);
  const revised = await propose(db, [{ action: "add_task", contact: "ct_seed01", title: "Task 5, revised" }], ids[4], at);
  assert.equal(await openCount(db, at), PROPOSAL_MAX_OPEN);
  const rows = await Promise.all(ids.map((id) => proposal(db, id)));
  assert.deepEqual(
    rows.map((row) => [row?.status, row?.replaced_by ?? null]),
    ids.map((_, i) => (i === 4 ? ["dropped", revised.id] : ["open", null])),
    "the oldest stays open",
  );
});

test("expired proposals don't count towards the ten and are never dropped; the hourly run deletes them", async () => {
  const db = await setup();
  const ids = await tenOpen(db);
  const later = new Date(NOW.getTime() + PROPOSAL_TTL_MS + 60_000);
  await propose(db, PATS_DAY, undefined, later);
  const rows = await Promise.all(ids.map((id) => proposal(db, id)));
  assert.ok(rows.every((row) => row?.status === "open" && row.replaced_by === null), "none was dropped");
  assert.equal(await deleteExpiredProposals(db, later), PROPOSAL_MAX_OPEN);
  assert.equal((await counts(db)).proposals, 1);
});

test("@n only as a subject", async () => {
  const db = await setup();
  await assert.rejects(
    propose(db, [
      { action: "add_lead", name: "Lee Example" },
      { action: "update_contact", contact: "@1", phone: "555-0123" },
    ]),
    /^UserError: Action 2 changes the person action 1 adds\. Put those details in action 1 instead\.$/,
  );
  await assert.rejects(propose(db, [{ action: "add_task", contact: "@1", title: "Call" }]), /^UserError: Action 1 names @1/);
  await assert.rejects(
    propose(db, [
      { action: "add_task", contact: "ct_seed01", title: "Call" },
      { action: "add_task", contact: "@1", title: "Call again" },
    ]),
    /^UserError: Action 2 names @1, but action 1 adds no person or deal/,
  );
  assert.equal((await counts(db)).proposals, 0);
});

test("outside text never in the list", async () => {
  const db = await setup();
  const answer = await propose(db, [{ action: "update_contact", contact: "ct_seed02", business: "Corner Shop Example" }]);
  const [item] = answer.list.update;
  assert.equal(item?.id, "ct_seed02");
  assert.match(answer.text, /- Contact ct_seed02: business \(text from outside\) -> Corner Shop Example\n/);
  for (const text of [answer.text, JSON.stringify(answer.list)]) assert.doesNotMatch(text, /Robin|robin@|Sample Bakery/);
});

test("the records added have the ids the list showed", async () => {
  const db = await setup();
  const answer = await propose(db, [
    { action: "add_lead", name: "Lee Example", business: "Lee Example Signs" },
    { action: "add_task", contact: "@1", title: "Call Lee" },
  ]);
  const shown = [answer.list.add[0]?.id, answer.list.tasks[0]?.id];
  const result = await apply(db, answer.id);
  const lee = await db.prepare("SELECT id FROM contacts WHERE name = 'Lee Example'").first<{ id: string }>();
  const task = await db.prepare("SELECT id, contact_id FROM tasks WHERE title = 'Call Lee'").first<{ id: string; contact_id: string }>();
  assert.deepEqual([lee?.id, task?.id], shown);
  assert.equal(task?.contact_id, lee?.id);
  const audit = (await audits(db))[0];
  assert.equal(audit?.target_id, lee?.id);
  assert.ok(Object.keys(JSON.parse(audit?.after_json ?? "{}")).includes(`contacts:${lee?.id}`));
  assert.equal(result.applied, 2);
});

test("a list of more than 50 rows is written as a bulk change and undoes in one", async () => {
  const db = await setup();
  const before = await counts(db);
  const actions: RecordAction[] = Array.from({ length: 25 }, (_, i) => ({
    action: "add_deal",
    name: `Fake Person ${i + 1}`,
    email: `fake${i + 1}@example.com`,
    notes: "Wants a quote.",
  }));
  const { id } = await propose(db, actions);
  const result = await apply(db, id);
  const audit = (await audits(db))[0];
  assert.ok((audit?.parts ?? 0) > 0, "the snapshot is in audit_parts");
  const after = await counts(db);
  assert.deepEqual([after.contacts - before.contacts, after.deals - before.deals, after.activities - before.activities], [25, 25, 25]);
  await undoChange(ctxFor(db, NOW, "undo_change"), result.changeId);
  const undone = await counts(db);
  assert.deepEqual([undone.contacts, undone.deals, undone.activities], [before.contacts, before.deals, before.activities]);
});

/** Alex (won deal, no open deal) made a Not now lead, then given a new deal: each alone is fine, together the
 * first action's "no open deal" guard fails in the one batch. */
const LEAD_THEN_DEAL: RecordAction[] = [
  { action: "update_contact", contact: "ct_seed07", leadStatus: "not_now" },
  { action: "add_deal", contact: "ct_seed07", dealTitle: "Gift card page" },
];

test("a list whose apply would fail is refused at propose", async () => {
  const db = await setup();
  const before = await counts(db);
  await assert.rejects(
    propose(db, LEAD_THEN_DEAL),
    /^UserError: Action 2 and action 1 can't be in one list: a lead can't have an open deal\. Send them as two lists\.$/,
  );
  assert.deepEqual(await counts(db), before, "nothing stored");
  // Each alone proposes and applies.
  for (const action of LEAD_THEN_DEAL) {
    const { id } = await propose(db, [action]);
    await apply(db, id);
  }
  assert.equal((await audits(db)).length, 2);
});

/** The database, counting the trial batches (those ending in TRIAL_SENTINEL) it runs. */
function countingTrials(db: SqliteD1): Db & { trials: () => number } {
  let trials = 0;
  return {
    trials: () => trials,
    prepare: (sql: string) => db.prepare(sql),
    batch: async (statements) => {
      if ((statements.at(-1) as unknown as SqliteStatement | undefined)?.sql === TRIAL_SENTINEL) trials++;
      return db.batch(statements);
    },
  } as Db & { trials: () => number };
}

/** Three people with no open deal made Not now leads, and a deal for two of them: three "no open deal" guards. */
const THREE_LEADS: RecordAction[] = [
  { action: "update_contact", contact: "ct_seed07", leadStatus: "not_now" },
  { action: "update_contact", contact: "ct_seed08", leadStatus: "not_now" },
  { action: "update_contact", contact: "ct_lone", leadStatus: "not_now" },
  { action: "add_deal", contact: "ct_seed08", dealTitle: "Brake service page" },
  { action: "add_deal", contact: "ct_lone", dealTitle: "Shop front page" },
];

test("a refusal names its two actions with at most two more trials, and never plans the list again", async () => {
  const db = await setup();
  // Two guards (Alex's and Sam's); Sam's breaks: the second trial (Alex's guard alone) passes, so it's Sam's.
  const two = countingTrials(db);
  await assert.rejects(
    proposeChanges(ctxFor(two), { actions: [THREE_LEADS[0], THREE_LEADS[1], THREE_LEADS[3]] as RecordAction[] }, DEPS),
    /^UserError: Action 3 and action 2 can't be in one list: a lead can't have an open deal\. Send them as two lists\.$/,
  );
  assert.equal(two.trials(), 3, "the list's own trial, the rows alone, then the first guard alone");
  const one = countingTrials(db);
  await assert.rejects(propose(db, LEAD_THEN_DEAL), /^UserError: Action 2 and action 1 can't be in one list/);
  await assert.rejects(proposeChanges(ctxFor(one), { actions: LEAD_THEN_DEAL }, DEPS), /can't be in one list/);
  assert.equal(one.trials(), 2, "one guard: the rows alone are the only extra trial");
});

test("past two guards, the refusal is one fixed sentence that names no action", async () => {
  const db = await setup();
  db.exec("INSERT INTO contacts (id, name) VALUES ('ct_lone', 'Lone Example')");
  const trials = countingTrials(db);
  await assert.rejects(
    proposeChanges(ctxFor(trials), { actions: THREE_LEADS }, DEPS),
    /^UserError: This list can't be applied as one change\. Send it as smaller lists\.$/,
  );
  assert.equal(trials.trials(), 2, "the list's own trial and the rows alone");
  assert.equal((await counts(db)).proposals, 0);
});

test("the trial writes nothing", async () => {
  const db = await setup();
  const before = await counts(db);
  const { id } = await propose(db, PATS_DAY);
  assert.deepEqual(await counts(db), { ...before, proposals: before.proposals + 1 }, "a trial that would apply leaves only the proposal");
  assert.equal((await proposal(db, id))?.status, "open");
  await assert.rejects(propose(db, LEAD_THEN_DEAL), /can't be in one list/);
  assert.deepEqual(await counts(db), { ...before, proposals: before.proposals + 1 }, "a trial that fails leaves nothing");
  const alex = await db.prepare("SELECT version, lead_status FROM contacts WHERE id = 'ct_seed07'").first();
  assert.deepEqual({ ...alex }, { version: 1, lead_status: null });
});

/** A batch of reads only: the request memo's and the name matching's batches (decision 0044, "D1 calls"). */
const readsOnly = (statements: readonly D1PreparedStatement[]) =>
  statements.every((statement) => /^\s*(SELECT|WITH)\b/i.test((statement as unknown as SqliteStatement).sql));

/** The database, with `first` run just before its first batch that writes: another write landing at that moment. */
function racing(db: SqliteD1, first: () => Promise<void>): Db {
  let done = false;
  return {
    prepare: (sql: string) => db.prepare(sql),
    batch: async (statements) => {
      if (!done && !readsOnly(statements)) {
        done = true;
        await first();
      }
      return db.batch(statements);
    },
  } as Db;
}

test("a record that moves between the plan and the trial is a fresh-list answer, not a conflict", async () => {
  const db = await setup();
  // The first batch of the propose that writes is the trial: Pat's row moves just before it, as another write would.
  const bump = async () => void (await db.prepare("UPDATE contacts SET version = version + 1 WHERE id = 'ct_seed01'").run());
  await assert.rejects(
    proposeChanges(ctxFor(racing(db, bump)), { actions: [{ action: "update_contact", contact: "ct_seed01", phone: "555-0199" }] }, DEPS),
    /^UserError: A record in this list changed while the list was being made, so nothing was proposed\. Send the list again\.$/,
  );
  assert.equal((await counts(db)).proposals, 0);
});

test("a list over the size limit is refused", async () => {
  const db = await setup();
  const before = await counts(db);
  const long = "Notes from the call. ".repeat(450).slice(0, 9_000);
  const actions: RecordAction[] = Array.from({ length: 25 }, () => ({ action: "log_activity", contact: "ct_seed01", type: "note", summary: long }));
  await assert.rejects(propose(db, actions), /^UserError: This list is too long to keep\. Send it as two lists\.$/);
  assert.deepEqual(await counts(db), before);
});

test("a big snapshot is written as a bulk change and undoes", async () => {
  const db = await setup();
  const old = "Long history. ".repeat(900);
  db.exec(`UPDATE contacts SET notes = '${old}'`);
  const actions: RecordAction[] = Array.from({ length: 8 }, (_, i) => ({ action: "update_contact", contact: `ct_seed0${i + 1}`, notes: "Short." }));
  const { id, text } = await propose(db, actions);
  assert.ok(text.length < 10_000, "long old values are cut in the list");
  const result = await apply(db, id);
  const audit = (await audits(db))[0];
  assert.ok((audit?.parts ?? 0) > 0, "8 rows, but a snapshot over CHUNK_BYTES goes to audit_parts");
  assert.equal(audit?.before_json, "{}");
  await undoChange(ctxFor(db, NOW, "undo_change"), result.changeId);
  const notes = await db.prepare("SELECT DISTINCT notes FROM contacts").all<{ notes: string }>();
  assert.deepEqual(notes.results.map((row) => row.notes), [old]);
});

test("a stage renamed after proposing is refused at apply", async () => {
  const db = await setup();
  const { id } = await propose(db, [{ action: "update_deal", deal: "dl_seed01", stage: "proposal_sent" }]);
  await updateStage({ db, now: NOW, actor: "owner", tool: "update_stage" }, "proposal_sent", { label: "Proposal out" });
  await assert.rejects(
    apply(db, id),
    new RegExp(`^UserError: ${id}'s list would come out different now \\(a stage, status, field or setting changed\\)\\. Propose the changes again and show the owner the new list\\.$`),
  );
  assert.equal((await audits(db)).length, 1, "only the rename");
  assert.equal((await proposal(db, id))?.status, "open");
});

test("a timezone change after proposing is refused at apply", async () => {
  const db = await setup();
  const { id } = await propose(db, [{ action: "add_task", contact: "ct_seed01", title: "Call Pat", dueAt: "2026-11-21T14:00" }]);
  await updateSettings({ db, now: NOW, actor: "owner", tool: "update_settings" }, { timezone: "America/New_York" });
  await assert.rejects(apply(db, id), /list would come out different now/);
  assert.equal((await counts(db)).tasks, (await counts(await setup())).tasks);
});

test("an intake contact named exactly like the owner's short name becomes a question", async () => {
  const db = await setup();
  db.exec("INSERT INTO contacts (id, name, untrusted_fields) VALUES ('ct_intake', 'Pat', '[\"name\"]')");
  const answer = await proposeChanges(ctxFor(db), { actions: [{ action: "add_task", contact: "Pat", title: "Call back" }] }, DEPS);
  assert.equal(answer.kind, "questions");
  const [question] = answer.kind === "questions" ? answer.questions : [];
  assert.match(question ?? "", /^Which Pat\? /);
  assert.match(question ?? "", /Pat Example \(ct_seed01, pat@example\.com\)/);
  assert.match(question ?? "", /contact ct_intake/);
  assert.equal((await counts(db)).proposals, 0);
});

test("a ref with more than 10 matches is one question", async () => {
  const db = await setup();
  for (let i = 1; i <= 11; i++) db.exec(`INSERT INTO contacts (id, name) VALUES ('ct_dee${i}', 'Dee Example ${i}')`);
  const answer = await proposeChanges(
    ctxFor(db),
    { actions: [{ action: "add_task", contact: "Dee", title: "Call" }, { action: "update_deal", deal: "Dee", stage: "won" }] },
    DEPS,
  );
  assert.deepEqual(answer, { kind: "questions", questions: ['"Dee" matches more than 10 people. Use more of the name, or the id.'] });
});

test("the trial's sentinel fails with exactly the message the trial looks for", async () => {
  const db = await setup();
  await assert.rejects(db.prepare(TRIAL_SENTINEL).run(), (error: unknown) => {
    assert.ok(isTrialSentinel(error));
    assert.match(String((error as Error).message), /NOT NULL constraint failed: proposals\.created_at/);
    return true;
  });
  assert.equal((await counts(db)).proposals, 0);
});

test("@n wording: a task that isn't added, and a deal an action didn't add", async () => {
  const db = await setup();
  await assert.rejects(
    propose(db, [{ action: "add_lead", name: "Lee Example" }, { action: "complete_task", task: "@1" }]),
    /^UserError: Action 2 names @1, but action 1 adds no task\.$/,
  );
  await assert.rejects(
    propose(db, [{ action: "add_task", contact: "ct_seed01", title: "Call" }, { action: "complete_task", task: "@1" }]),
    /^UserError: Action 2 changes the task action 1 adds\. Put those details in action 1 instead\.$/,
  );
  await samIsALead(db);
  await assert.rejects(
    propose(db, [{ action: "qualify_lead", contact: "ct_seed08", createDeal: false }, { action: "add_task", deal: "@1", title: "Call" }]),
    /^UserError: Action 2: Action 1 adds no deal, so @1 can't be used as the deal here\.$/,
  );
});

test("an apply racing a revised list answers that it was replaced", async () => {
  const db = await setup();
  const first = await propose(db, PATS_DAY);
  let second = "";
  const revise = async () => void (second = (await propose(db, PATS_DAY.slice(0, 1), first.id)).id);
  await assert.rejects(
    applyChanges(ctxFor(racing(db, revise), NOW, "apply_changes"), first.id, DEPS),
    (error: Error) => error.message === `${first.id} was replaced by ${second}. Apply ${second} if the owner said yes to it.`,
  );
  assert.equal((await audits(db)).length, 0);
});

test("two applies racing write once and both answer the one change", async () => {
  const db = await setup();
  const { id } = await propose(db, PATS_DAY);
  let winner = "";
  const other = async () => void (winner = (await apply(db, id)).changeId);
  const loser = await applyChanges(ctxFor(racing(db, other), NOW, "apply_changes"), id, DEPS);
  assert.equal(loser.changeId, winner);
  assert.equal(loser.applied, 0);
  assert.equal((await audits(db)).length, 1);
});

test("a not now with a check-back task and its open-deal guard applies (its guard is bound to no added row)", async () => {
  const db = await setup();
  const { id } = await propose(db, [{ action: "update_contact", contact: "ct_seed07", leadStatus: "not_now", followUpDate: "2026-12-01" }]);
  assert.equal((await apply(db, id)).applied, 1);
});

test("the hourly run keeps applied and dropped proposals for a day", async () => {
  const db = await setup();
  const first = await propose(db, PATS_DAY);
  await propose(db, PATS_DAY.slice(0, 1), first.id);
  const { id } = await propose(db, PATS_DAY.slice(1));
  await apply(db, id);
  const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000);
  assert.equal(await deleteExpiredProposals(db, hours(3)), 1, "the open one that expired");
  assert.equal(await deleteExpiredProposals(db, hours(23)), 0);
  assert.equal(await deleteExpiredProposals(db, hours(24)), 2);
  assert.equal((await counts(db)).proposals, 0);
});
