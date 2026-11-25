import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { CHANGE_LINE, connectInMemory, fails, ok, okText } from "../../tests/helpers/mcp-client.ts";
import { createTestDb } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import { isSmallAction } from "./record-write.ts";
import { createMcpServer } from "./server.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");

async function setup() {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  const c = await connectInMemory(createMcpServer({ db, now: () => NOW }));
  const count = async (table: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>("n")) ?? -1;
  return { db, c, count };
}

/** Turns on "Apply small changes" the way the owner would ask for it. */
async function applySmall(c: Awaited<ReturnType<typeof setup>>["c"]) {
  await ok(c, "update_settings", { aiEdits: "apply_small" });
}

type Proposed = { proposal: string; expiresAt: string; list: { tasks: { id: string }[] } };

const proposalOf = (data: unknown) => (data as Proposed).proposal;

test("review first: add_task returns a proposal and writes nothing", async () => {
  const { c, count } = await setup();
  const tasks = await count("tasks");
  const answer = await okText(c, "add_task", { deal: "dl_seed01", title: "Send Pat the quote", dueAt: "2026-11-20" });
  const data = answer.data as Proposed;
  assert.deepEqual(Object.keys(data), ["proposal", "expiresAt", "list"]);
  assert.match(data.proposal, /^pr_[a-z2-7]{12}$/);
  assert.ok(answer.headline.startsWith(`Proposal ${data.proposal} (expires 12:00 PM). Nothing has changed yet.\n\nTasks\n- New task "Send Pat the quote"`), answer.headline);
  assert.ok(answer.headline.endsWith('"No" (apply nothing).'));
  assert.equal(await count("tasks"), tasks, "no task yet");
  assert.equal(await count("audit_log"), 0, "no change");
  assert.equal(await count("proposals"), 1);

  // The owner's yes: apply_changes writes it as one change.
  const applied = await ok(c, "apply_changes", { proposal: data.proposal });
  assert.match(applied.headline, new RegExp(`^Applied ${data.proposal}: Added task "Send Pat the quote" for `));
  assert.match(applied.headline, CHANGE_LINE);
  assert.equal(await count("tasks"), tasks + 1);
});

test("review first: add_task with no deal or contact proposes a standalone task, and the yes adds it", async () => {
  const { db, c } = await setup();
  const answer = await okText(c, "add_task", { title: "Buy printer ink", dueAt: "2026-11-21" });
  const proposal = proposalOf(answer.data);
  assert.match(answer.headline, /\nTasks\n- New task "Buy printer ink": no person or deal; due Sat Nov 21\n/);
  const applied = await ok(c, "apply_changes", { proposal });
  assert.match(applied.headline, new RegExp(`^Applied ${proposal}: Added task "Buy printer ink", due Sat Nov 21, 12:00 AM \\(change chg_`));
  const row = await db.prepare("SELECT deal_id, contact_id FROM tasks WHERE title = 'Buy printer ink'").first();
  assert.deepEqual({ ...row }, { deal_id: null, contact_id: null });
});

test("review first: a record tool answers exactly what propose_changes answers for the same action", async () => {
  const { c } = await setup();
  const args = { deal: "dl_seed01", stage: "Proposal sent", nextStep: "Wait for Pat" };
  const viaTool = await okText(c, "update_deal", args);
  const viaPropose = await okText(c, "propose_changes", { actions: [{ action: "update_deal", ...args }] });
  const tool = proposalOf(viaTool.data);
  const propose = proposalOf(viaPropose.data);
  assert.notEqual(tool, propose);
  assert.equal(viaTool.text.replaceAll(tool, "pr_x"), viaPropose.text.replaceAll(propose, "pr_x"));
});

test("review first: a refusal reads as the service's own message, and a name with two matches is a question", async () => {
  const { db, c, count } = await setup();
  assert.match(await fails(c, "complete_task", { task: "tk_seed06" }), /^Task "Send Alex the welcome pack" is already done \(Tue Nov 10, 10:00 AM\)\. Nothing to do\.$/);
  assert.match(await fails(c, "add_deal", {}), /^A new deal needs a person: give their name, or an existing contact\.$/);
  db.exec("INSERT INTO contacts (id, name) VALUES ('ct_dana1', 'Dana Example'), ('ct_dana2', 'Dana Sample')");
  const answer = await okText(c, "log_activity", { contact: "Dana", type: "email", summary: "Sent the examples." });
  assert.match(answer.headline, /^Nothing was proposed: a name needs checking first\. Ask the owner, then send the list again\.\n- Which Dana\? /);
  assert.deepEqual(Object.keys(answer.data as object), ["questions"]);
  assert.equal(await count("proposals"), 0);
});

test("apply small: log_activity call applies at once", async () => {
  const { db, c, count } = await setup();
  await applySmall(c);
  const changes = await count("audit_log");
  const answer = await ok(c, "log_activity", { deal: "dl_seed01", type: "call", summary: "Called Pat. Wants a quote by Friday." });
  assert.match(answer.headline, /^Logged a call on "Website refresh for Example Plumbing"/);
  assert.match(answer.headline, CHANGE_LINE);
  const data = answer.data as { changeId: string; activityId: string };
  assert.ok(answer.headline.endsWith(`(change ${data.changeId})`));
  assert.equal(await db.prepare("SELECT type FROM activities WHERE id = ?").bind(data.activityId).first("type"), "call");
  assert.equal(await count("audit_log"), changes + 1);
  assert.equal(await count("proposals"), 0);

  // A note is small too.
  const note = await ok(c, "log_activity", { contact: "ct_seed01", type: "note", summary: "Prefers mornings." });
  assert.match(note.headline, CHANGE_LINE);
  assert.equal(await count("proposals"), 0);
});

test("apply small: complete_task applies at once", async () => {
  const { db, c, count } = await setup();
  await applySmall(c);
  const answer = await ok(c, "complete_task", { task: "tk_seed01" });
  assert.match(answer.headline, /^Completed task "Prepare questions for Pat's call"/);
  assert.match(answer.headline, CHANGE_LINE);
  assert.deepEqual(answer.data, { changeId: (answer.data as { changeId: string }).changeId, taskId: "tk_seed01" });
  assert.equal(await db.prepare("SELECT done_at FROM tasks WHERE id = 'tk_seed01'").first("done_at"), NOW.toISOString());
  assert.equal(await count("proposals"), 0);
});

test("apply small: add_task is still a proposal", async () => {
  const { c, count } = await setup();
  await applySmall(c);
  const tasks = await count("tasks");
  const answer = await okText(c, "add_task", { contact: "ct_seed01", title: "Send Pat the quote" });
  assert.match(proposalOf(answer.data), /^pr_/);
  assert.equal(await count("tasks"), tasks);
  assert.equal(await count("proposals"), 1);
});

test("apply small: log_activity email is still a proposal", async () => {
  const { c, count } = await setup();
  await applySmall(c);
  const activities = await count("activities");
  for (const type of ["email", "meeting"]) {
    const answer = await okText(c, "log_activity", { deal: "dl_seed01", type, summary: "Sent the quote." });
    assert.match(proposalOf(answer.data), /^pr_/, type);
  }
  assert.equal(await count("activities"), activities);
  assert.equal(await count("proposals"), 2);
});

test("an AI app that never applies can't block edits: the 11th record tool call drops the oldest list", async () => {
  const { db, c } = await setup();
  const ids: string[] = [];
  for (let i = 1; i <= 11; i++) ids.push(proposalOf((await okText(c, "add_task", { contact: "ct_seed01", title: `Task ${i}` })).data));
  const open = await db.prepare("SELECT id FROM proposals WHERE status = 'open' ORDER BY created_at, rowid").all<{ id: string }>();
  assert.deepEqual(open.results.map((row) => row.id), ids.slice(1), "exactly ten open: the newest ten");
  assert.equal(await fails(c, "apply_changes", { proposal: ids[0] ?? "" }), `${ids[0]} was replaced by ${ids[10]}. Apply ${ids[10]} if the owner said yes to it.`);
  assert.match((await ok(c, "apply_changes", { proposal: ids[10] ?? "" })).headline, CHANGE_LINE);
});

test("settings, stages and rules still write at once under review first", async () => {
  const { c, count } = await setup();
  for (const [tool, args] of [
    ["update_settings", { briefHour: 9 }],
    ["add_stage", { label: "Demo booked" }],
    ["add_rule", { type: "gone_quiet", days: 10 }],
    ["update_rulebook", { name: "voice", markdown: "Short and friendly." }],
  ] as const) {
    const answer = await ok(c, tool, args);
    assert.match(answer.headline, CHANGE_LINE, tool);
  }
  assert.equal(await count("audit_log"), 4);
  assert.equal(await count("proposals"), 0);
});

test("update_settings aiEdits round-trips and is undoable", async () => {
  const { c } = await setup();
  const aiEdits = async () => ((await ok(c, "get_settings")).data as { aiEdits: string }).aiEdits;
  assert.equal(await aiEdits(), "review_first", "the default");

  const set = await ok(c, "update_settings", { aiEdits: "apply_small" });
  assert.match(set.headline, /^Updated settings: AI edits: Apply small changes \(change chg_[a-z0-9]{12}\)$/);
  assert.equal(await aiEdits(), "apply_small");
  assert.match(await fails(c, "update_settings", { aiEdits: "apply_small" }), /^Nothing to change/);
  assert.match(await fails(c, "update_settings", { aiEdits: "always" }), /"aiEdits" must be one of: review_first, apply_small/);

  const back = await ok(c, "update_settings", { aiEdits: "review_first" });
  assert.match(back.headline, /^Updated settings: AI edits: Review first \(change chg_/);
  assert.equal(await aiEdits(), "review_first");

  await ok(c, "undo_change", { changeId: (back.data as { changeId: string }).changeId });
  assert.equal(await aiEdits(), "apply_small", "undo puts the earlier setting back");
});

test("isSmallAction: a call or note on an existing person or deal, and completing a task", () => {
  assert.equal(isSmallAction({ action: "log_activity", deal: "dl_seed01", type: "call", summary: "Called." }), true);
  assert.equal(isSmallAction({ action: "log_activity", contact: "ct_seed01", type: "note", summary: "A note." }), true);
  assert.equal(isSmallAction({ action: "log_activity", contact: "ct_seed01", type: "email", summary: "Emailed." }), false);
  assert.equal(isSmallAction({ action: "log_activity", contact: "ct_seed01", type: "meeting", summary: "Met." }), false);
  assert.equal(isSmallAction({ action: "log_activity", contact: "@1", type: "call", summary: "Called." }), false, "not on a record a list adds");
  assert.equal(isSmallAction({ action: "log_activity", project: "pj_seed01", type: "note", summary: "A note." }), true);
  assert.equal(isSmallAction({ action: "log_activity", project: "@1", type: "note", summary: "A note." }), false, "not on a project a list adds");
  assert.equal(isSmallAction({ action: "complete_task", task: "tk_seed01" }), true);
  assert.equal(isSmallAction({ action: "complete_task", task: "tk_seed01", subTasks: "leave" }), true);
  assert.equal(isSmallAction({ action: "complete_task", task: "tk_seed01", subTasks: "complete" }), false, "a multi-row completion is proposed");
  assert.equal(isSmallAction({ action: "snooze_task", task: "tk_seed01", until: "2026-11-25" }), false);
  assert.equal(isSmallAction({ action: "add_task", contact: "ct_seed01", title: "Call Pat" }), false);
  assert.equal(isSmallAction({ action: "update_deal", deal: "dl_seed01", nextStep: "Call" }), false);
  // Time (decision 0049): starting a timer, and stopping one without a next step.
  assert.equal(isSmallAction({ action: "start_timer", contact: "ct_seed01" }), true);
  assert.equal(isSmallAction({ action: "start_timer", deal: "@1" }), false, "not on a record a list adds");
  assert.equal(isSmallAction({ action: "stop_timer", notes: "Done." }), true);
  assert.equal(isSmallAction({ action: "stop_timer", nextStepDate: "2026-11-20" }), false);
  assert.equal(isSmallAction({ action: "add_time_entry", startedAt: "2026-11-19T08:00", minutes: 30 }), false);
  assert.equal(isSmallAction({ action: "update_time_entry", entry: "te_x", minutes: 30 }), false);
});
