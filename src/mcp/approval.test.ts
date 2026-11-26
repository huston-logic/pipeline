import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { connectInMemory, fails, ok, okText } from "../../tests/helpers/mcp-client.ts";
import { countingDb } from "../../tests/helpers/counting-db.ts";
import { createTestDb } from "../db/sqlite-d1.ts";
import { applyChanges, PROPOSAL_MAX_ACTIONS } from "../services/proposals.ts";
import { updateRule } from "../services/rules.ts";
import { updateSettings } from "../services/settings.ts";
import { undoChange } from "../services/undo.ts";
import { DEFAULT_TZ } from "../time.ts";
import { createMcpServer } from "./server.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const ORIGIN = "https://pipeline.example.com";

async function setup() {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  const c = await connectInMemory(createMcpServer({ db, now: () => NOW, origin: ORIGIN }));
  const count = async (table: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>("n")) ?? -1;
  return { db, c, count };
}

test("approveIn board works over MCP, shows in get_settings, and chat is refused while it is board", async () => {
  const { c } = await setup();
  const approveIn = async () => ((await ok(c, "get_settings")).data as { approveIn: string }).approveIn;
  assert.equal(await approveIn(), "chat");
  assert.match(await fails(c, "update_settings", { approveIn: "chat" }), /^Nothing to change/);
  const set = await ok(c, "update_settings", { approveIn: "board" });
  assert.match(set.headline, /AI changes are approved on the board only/);
  assert.equal(await approveIn(), "board");
  assert.equal(await fails(c, "update_settings", { approveIn: "chat" }), `Only the board can switch this back. Open ${ORIGIN}/pending.`);
  assert.equal(await approveIn(), "board");
});

test("the board (owner) may switch approval back to chat", async () => {
  const { db, c } = await setup();
  await ok(c, "update_settings", { approveIn: "board" });
  const result = await updateSettings({ db, now: NOW, actor: "owner", tool: "update_settings" }, { approveIn: "chat" });
  assert.match(result.summary, /AI changes are approved in chat/);
});

test("with board approval apply_changes refuses without writing, and propose answers point at /pending", async () => {
  const { c, count } = await setup();
  await ok(c, "update_settings", { approveIn: "board" });
  const tasks = await count("tasks");
  const answer = await okText(c, "add_task", { deal: "dl_seed01", title: "Send Pat the quote", dueAt: "2026-11-20" });
  assert.ok(answer.headline.endsWith(`\n\nApprove on the board: ${ORIGIN}/pending.`), answer.headline);
  assert.ok(!answer.headline.includes("apply_changes"), "no yes in chat");
  const proposal = (answer.data as { proposal: string }).proposal;
  const audits = await count("audit_log");
  assert.equal(
    await fails(c, "apply_changes", { proposal }),
    `The owner approves changes on the board: ${ORIGIN}/pending. Ask them to open it and press Approve.`,
  );
  assert.equal(await count("tasks"), tasks);
  assert.equal(await count("audit_log"), audits);

  const listed = await okText(c, "propose_changes", { actions: [{ action: "add_task", title: "Buy ink" }] });
  assert.ok(listed.headline.endsWith(`Approve on the board: ${ORIGIN}/pending.`), listed.headline);
});

test("a small change waits on the board under Apply small changes while approval is on the board (decision 0061)", async () => {
  const { c, count } = await setup();
  await ok(c, "update_settings", { aiEdits: "apply_small" });
  const activities = await count("activities");
  await ok(c, "log_activity", { deal: "dl_seed01", type: "note", summary: "Before the switch" });
  assert.equal(await count("activities"), activities + 1, "under chat a small change still applies at once");

  await ok(c, "update_settings", { approveIn: "board" });
  const audits = await count("audit_log");
  const answer = await okText(c, "log_activity", { deal: "dl_seed01", type: "note", summary: "Talked it over" });
  assert.ok(answer.headline.endsWith(`Approve on the board: ${ORIGIN}/pending.`), answer.headline);
  assert.equal(await count("activities"), activities + 1);
  assert.equal(await count("audit_log"), audits);
  assert.equal(await count("proposals"), 1);
});

test("while approval is on the board a logged call is proposed too", async () => {
  const { c, count } = await setup();
  await ok(c, "update_settings", { aiEdits: "apply_small" });
  await ok(c, "update_settings", { approveIn: "board" });
  const activities = await count("activities");
  const answer = await okText(c, "log_activity", { deal: "dl_seed01", type: "call", summary: "Rang Pat" });
  assert.ok(answer.headline.endsWith(`Approve on the board: ${ORIGIN}/pending.`), answer.headline);
  assert.equal(await count("activities"), activities);
});

test("while approval is on the board the AI app can't undo anything; the owner can; under chat the AI can", async () => {
  const { db, c } = await setup();
  const early = await ok(c, "update_settings", { businessName: "Oak" });
  assert.match((await ok(c, "undo_change", { changeId: (early.data as { changeId: string }).changeId })).headline, /^Undid/);
  const name = await ok(c, "update_settings", { businessName: "Fernwood" });
  const nameId = (name.data as { changeId: string }).changeId;
  const set = await ok(c, "update_settings", { approveIn: "board" });
  const setId = (set.data as { changeId: string }).changeId;
  const refusal = `The owner undoes changes on the board while AI changes are approved there: ${ORIGIN}/changes.`;
  assert.equal(await fails(c, "undo_change", { changeId: setId }), refusal);
  assert.equal(await fails(c, "undo_change", { changeId: nameId }), refusal);
  const ownerUndo = await undoChange({ db, now: NOW, actor: "owner", tool: "undo_change" }, setId);
  assert.match(ownerUndo.summary, /^Undid/);
});

test("while approval is on the board the AI app can't loosen AI edits; the owner can", async () => {
  const { db, c } = await setup();
  await ok(c, "update_settings", { approveIn: "board" });
  const message = await fails(c, "update_settings", { aiEdits: "apply_small" });
  assert.equal(message, `Only the board can loosen this while AI changes are approved there. Switch approval back to chat on the board first: ${ORIGIN}/pending.`);
  await updateSettings({ db, now: NOW, actor: "owner", tool: "update_settings" }, { aiEdits: "apply_small" });
  const back = await ok(c, "update_settings", { aiEdits: "review_first" });
  assert.match(back.headline, /Review first/);
});

test("while approval is on the board apply_import refuses and points at the board's import page", async () => {
  const { c } = await setup();
  await ok(c, "update_settings", { approveIn: "board" });
  assert.equal(await fails(c, "apply_import", { draft: "im_abc", version: 1 }), `The owner applies imports on the board: ${ORIGIN}/import/im_abc.`);
});

test("a maximum-size propose and apply through the tools make at most 40 D1 calls each", async () => {
  const raw = await createTestDb();
  raw.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  const db = countingDb(raw);
  const c = await connectInMemory(createMcpServer({ db, now: () => NOW, origin: ORIGIN }));
  const actions = Array.from({ length: PROPOSAL_MAX_ACTIONS }, (_, i) => ({ action: "add_task", title: `Task ${i + 1}`, dueAt: "2026-11-21" }));
  db.reset();
  const proposed = await okText(c, "propose_changes", { actions });
  assert.ok(db.calls <= 40, `propose made ${db.calls} D1 calls`);
  db.reset();
  await ok(c, "apply_changes", { proposal: (proposed.data as { proposal: string }).proposal });
  assert.ok(db.calls <= 40, `apply made ${db.calls} D1 calls`);
});

const ruleCount = (db: Awaited<ReturnType<typeof setup>>["db"]) => db.prepare("SELECT COUNT(*) AS n FROM rules").first<number>("n");

test("in chat the rule tools write at once, and a list may not hold a rule action (decision 0061)", async () => {
  const { db, c, count } = await setup();
  const rules = await ruleCount(db);
  const added = await ok(c, "add_rule", { type: "gone_quiet", days: 9 });
  assert.match(added.headline, /^Added rule ru_/);
  assert.equal(await ruleCount(db), (rules ?? 0) + 1);
  assert.match((await ok(c, "pause_rule", { rule: "ru_seed01" })).headline, /^Paused rule ru_seed01/);
  assert.match((await ok(c, "resume_rule", { rule: "ru_seed01" })).headline, /^Resumed rule ru_seed01/);
  assert.match(await fails(c, "propose_changes", { actions: [{ action: "pause_rule", rule: "ru_seed01" }] }), /unless the owner approves AI changes on the board only/);
  assert.equal(await count("proposals"), 0);
});

test("on the board only every rule tool proposes in plain words and writes nothing", async () => {
  const { db, c, count } = await setup();
  await ok(c, "update_settings", { approveIn: "board" });
  const rules = await ruleCount(db);
  const audits = await count("audit_log");
  const calls: [string, Record<string, unknown>, RegExp][] = [
    ["add_rule", { type: "gone_quiet", days: 9 }, /Add\n- Rule: Flag any open deal with no contact logged for 9 days in the daily brief\./],
    ["update_rule", { rule: "ru_seed01", days: 8 }, /Update\n- Rule ru_seed01: now Flag any open deal with no activity for 5 days in the daily brief\. -> Flag any open deal with no contact logged for 8 days in the daily brief\./],
    ["pause_rule", { rule: "ru_seed01" }, /- Rule ru_seed01: paused: Flag any open deal/],
    ["resume_rule", { rule: "ru_seed02" }, /- Rule ru_seed02: resumed: When a deal has been in Call done for 2 days/],
  ];
  for (const [tool, args, text] of calls) {
    const answer = await okText(c, tool, args);
    assert.ok(answer.headline.endsWith(`Approve on the board: ${ORIGIN}/pending.`), `${tool}: ${answer.headline}`);
    assert.match((answer.data as { text?: string }).text ?? answer.headline, text, tool);
  }
  assert.equal(await ruleCount(db), rules);
  assert.equal(await count("audit_log"), audits);
  assert.equal(await db.prepare("SELECT active FROM rules WHERE id = 'ru_seed01'").first<number>("active"), 1);
  assert.equal(await count("proposals"), 4);
});

test("the owner's Approve writes a rule list as one change, and the AI can't apply it", async () => {
  const { db, c, count } = await setup();
  await ok(c, "update_settings", { approveIn: "board" });
  const proposed = await okText(c, "propose_changes", {
    actions: [
      { action: "pause_rule", rule: "ru_seed01" },
      { action: "resume_rule", rule: "ru_seed02" },
      { action: "add_rule", type: "gone_quiet", days: 12 },
      { action: "add_task", title: "Review the rules" },
    ],
  });
  const id = (proposed.data as { proposal: string }).proposal;
  assert.match(await fails(c, "apply_changes", { proposal: id }), /approves changes on the board/);
  const rules = (await ruleCount(db)) ?? 0;
  const audits = await count("audit_log");
  const done = await applyChanges({ db, now: NOW, actor: "owner", tool: "apply_changes" }, id, { extraOwnerEmails: [] });
  assert.equal(done.applied, 4);
  assert.equal(await ruleCount(db), rules + 1);
  assert.equal(await db.prepare("SELECT active FROM rules WHERE id = 'ru_seed01'").first<number>("active"), 0);
  assert.equal(await db.prepare("SELECT active FROM rules WHERE id = 'ru_seed02'").first<number>("active"), 1);
  assert.equal(await count("audit_log"), audits + 1);
});

test("a rule changed since the list was made refuses the apply and writes nothing", async () => {
  const { db, c } = await setup();
  await ok(c, "update_settings", { approveIn: "board" });
  const id = ((await okText(c, "pause_rule", { rule: "ru_seed01" })).data as { proposal: string }).proposal;
  await updateRule({ db, now: NOW, actor: "owner", tool: "update_rule" }, "ru_seed01", { days: 6 });
  await assert.rejects(applyChanges({ db, now: NOW, actor: "owner", tool: "apply_changes" }, id, { extraOwnerEmails: [] }), /changed since/);
  assert.equal(await db.prepare("SELECT active FROM rules WHERE id = 'ru_seed01'").first<number>("active"), 1);
});

test("a refused rule tool says why in its own words; a list holds at most 10 rule changes", async () => {
  const { c } = await setup();
  await ok(c, "update_settings", { approveIn: "board" });
  assert.match(await fails(c, "pause_rule", { rule: "ru_nope" }), /There's no rule "ru_nope"/);
  assert.match(await fails(c, "resume_rule", { rule: "ru_seed01" }), /already active/);
  const many = Array.from({ length: 11 }, (_, i) => ({ action: "add_rule", type: "gone_quiet", days: i + 1 }));
  assert.match(await fails(c, "propose_changes", { actions: many }), /at most 10 rule changes/);
});

test("a maximum-size rule list makes at most 40 D1 calls to propose and to apply", async () => {
  const raw = await createTestDb();
  raw.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  const db = countingDb(raw);
  const c = await connectInMemory(createMcpServer({ db, now: () => NOW, origin: ORIGIN }));
  await ok(c, "update_settings", { approveIn: "board" });
  const actions = [
    ...Array.from({ length: 5 }, (_, i) => ({ action: "add_rule", type: "gone_quiet", days: i + 10 })),
    { action: "update_rule", rule: "ru_seed01", days: 4 },
    { action: "pause_rule", rule: "ru_seed01" },
    { action: "resume_rule", rule: "ru_seed02" },
  ];
  db.reset();
  const proposed = await okText(c, "propose_changes", { actions });
  assert.ok(db.calls <= 40, `propose made ${db.calls} D1 calls`);
  db.reset();
  await applyChanges({ db, now: NOW, actor: "owner", tool: "apply_changes" }, (proposed.data as { proposal: string }).proposal, { extraOwnerEmails: [] });
  assert.ok(db.calls <= 40, `apply made ${db.calls} D1 calls`);
});
