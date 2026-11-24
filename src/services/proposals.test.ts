import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { type AuditRow, type Db, type ProposalRow, TABLE_NAMES } from "../db/db.ts";
import { createTestDb, type SqliteD1 } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import type { Ctx } from "./change.ts";
import { updateContact } from "./contacts.ts";
import type { RecordAction } from "./proposal-actions.ts";
import { runAction } from "./proposal-actions.ts";
import {
  applyChanges,
  deleteExpiredProposals,
  PROPOSAL_MAX_OPEN,
  PROPOSAL_TTL_MS,
  type ProposeAnswer,
  proposeChanges,
} from "./proposals.ts";
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
  for (const table of ["contacts", "deals", "activities", "tasks"]) {
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
  ];
  for (const actions of scenarios) {
    const one = await setup();
    const both = await setup();
    await samIsALead(one);
    await samIsALead(both);
    const seed = await recordRows(one);

    // A: each action through its service, one change each, "@n" bound to the id action n added.
    const added: { contactId?: string; dealId?: string | null }[] = [];
    for (const action of actions) {
      const bound = Object.fromEntries(
        Object.entries(action).map(([key, value]) => {
          const ref = typeof value === "string" ? /^@(\d+)$/.exec(value) : null;
          const earlier = ref ? added[Number(ref[1]) - 1] : undefined;
          return [key, earlier === undefined ? value : key === "deal" ? earlier.dealId : earlier.contactId];
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

test("the 11th open proposal is refused", async () => {
  const db = await setup();
  for (let i = 0; i < PROPOSAL_MAX_OPEN; i++) await propose(db, [{ action: "add_task", contact: "ct_seed01", title: `Task ${i + 1}` }]);
  await assert.rejects(
    propose(db, PATS_DAY),
    /^UserError: Ten proposals are waiting\. Apply or drop one first: say No to one, or send a revised list with replaces\.$/,
  );
  assert.equal((await counts(db)).proposals, PROPOSAL_MAX_OPEN);
  // An expired one no longer counts, and the hourly run deletes it.
  const later = new Date(NOW.getTime() + PROPOSAL_TTL_MS + 1);
  await propose(db, PATS_DAY, undefined, later);
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
