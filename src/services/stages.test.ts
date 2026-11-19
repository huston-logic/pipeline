import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditRow, Db, StageRow } from "../db/db.ts";
import { listStages } from "../db/queries.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import type { Ctx } from "./change.ts";
import { updateDeal } from "./deals.ts";
import { UserError } from "./errors.ts";
import { addLead } from "./leads.ts";
import { addStage, archiveStage, stageOverview, updateStage } from "./stages.ts";
import { undoChange } from "./undo.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const LATER = new Date("2026-11-19T19:00:00.000Z");
const ctxFor = (db: Db, tool: string, now = NOW): Ctx => ({ db, now, actor: "ai", tool });

const order = async (db: Db) => (await listStages(db)).map((s) => `${s.position}:${s.key}`);
const stage = async (db: Db, key: string) =>
  db.prepare("SELECT * FROM stages WHERE key = ?").bind(key).first<StageRow>();
const audits = async (db: Db) => (await db.prepare("SELECT * FROM audit_log ORDER BY rowid").all<AuditRow>()).results;

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => assert.fail("expected a refusal"),
    (e: unknown) => e,
  );
  assert.ok(error instanceof UserError, `expected a UserError, got ${String(error)}`);
  return error.message;
}

test("addStage puts a new open stage after the last open one, keyed by the slug of its label, in one change", async () => {
  const db = await openTestDb();
  const result = await addStage(ctxFor(db, "add_stage"), { label: "Demo booked" });

  assert.equal(
    result.summary,
    `Added stage Demo booked (key demo_booked) after Proposal sent (change ${result.changeId})`,
  );
  assert.equal(result.key, "demo_booked");
  assert.deepEqual(await order(db), [
    "1:new_inquiry",
    "2:replied",
    "3:call_booked",
    "4:call_done",
    "5:proposal_sent",
    "6:demo_booked",
    "7:won",
    "8:lost",
    "9:not_now",
  ]);
  const row = await stage(db, "demo_booked");
  assert.equal(row?.kind, "open");
  assert.equal(row?.version, 1);
  assert.equal((await stage(db, "won"))?.version, 2, "the stages that moved are versioned");
  const log = await audits(db);
  assert.equal(log.length, 1, "positions renumber inside the same change");
  assert.equal(log[0]?.tool, "add_stage");
  assert.equal(log[0]?.target_id, "demo_booked");
});

test("addStage honours after (key or label), kind, and gives a clashing key _2, _3", async () => {
  const db = await openTestDb();
  await addStage(ctxFor(db, "add_stage"), { label: "Quote sent", after: "Replied" });
  assert.deepEqual((await order(db)).slice(0, 4), ["1:new_inquiry", "2:replied", "3:quote_sent", "4:call_booked"]);

  await addStage(ctxFor(db, "add_stage"), { label: "First touch", after: "new_inquiry" });
  assert.deepEqual((await order(db)).slice(0, 3), ["1:new_inquiry", "2:first_touch", "3:replied"]);

  const parked = await addStage(ctxFor(db, "add_stage"), { label: "On hold", kind: "not_now" });
  assert.equal((await order(db)).at(-1), `${(await listStages(db)).length}:on_hold`);
  assert.equal((await stage(db, parked.key))?.kind, "not_now");

  const second = await addStage(ctxFor(db, "add_stage"), { label: "Not-now" });
  const third = await addStage(ctxFor(db, "add_stage"), { label: "Not_now" });
  assert.equal(second.key, "not_now_2");
  assert.equal(third.key, "not_now_3");
});

test("addStage refuses a blank or symbol-only label, a duplicate label and an unknown after", async () => {
  const db = await openTestDb();
  assert.match(await refusal(addStage(ctxFor(db, "add_stage"), { label: "  " })), /needs a label/);
  assert.match(await refusal(addStage(ctxFor(db, "add_stage"), { label: "!!!" })), /letters or numbers/);
  assert.match(await refusal(addStage(ctxFor(db, "add_stage"), { label: "replied" })), /already a stage called Replied/);
  assert.match(await refusal(addStage(ctxFor(db, "add_stage"), { label: "Demo", after: "Nowhere" })), /There's no stage "Nowhere"/);
  assert.equal((await audits(db)).length, 0);
});

test("renaming a stage keeps its key, so deals and rules that name it keep working", async () => {
  const db = await openTestDb();
  const lead = await addLead(ctxFor(db, "add_lead"), { name: "Pat Example", dealTitle: "Website refresh" });
  await updateDeal(ctxFor(db, "update_deal"), lead.dealId, { stage: "call_done" });

  const result = await updateStage(ctxFor(db, "update_stage"), "Call done", { label: "Met" });

  assert.equal(result.summary, `Renamed stage Call done to Met (change ${result.changeId})`);
  const renamed = await stage(db, "call_done");
  assert.equal(renamed?.label, "Met");
  assert.equal(await stage(db, "met"), null);
  const found = await updateDeal(ctxFor(db, "update_deal"), lead.dealId, { stage: "Met", nextStep: "Send proposal" });
  assert.match(found.summary, /^Updated "Website refresh" \(Pat Example\)/);
  assert.match(await refusal(updateStage(ctxFor(db, "update_stage"), "call_done", { label: "replied" })), /already a stage called Replied/);
});

test("update_stage position renumbers every stage in one change", async () => {
  const db = await openTestDb();
  const result = await updateStage(ctxFor(db, "update_stage"), "call_done", { position: 1 });

  assert.equal(result.summary, `Moved stage Call done to position 1 of 8 (change ${result.changeId})`);
  assert.deepEqual(await order(db), [
    "1:call_done",
    "2:new_inquiry",
    "3:replied",
    "4:call_booked",
    "5:proposal_sent",
    "6:won",
    "7:lost",
    "8:not_now",
  ]);
  assert.equal((await audits(db)).length, 1);
  assert.match(await refusal(updateStage(ctxFor(db, "update_stage"), "won", { position: 9 })), /between 1 and 8/);
  assert.match(await refusal(updateStage(ctxFor(db, "update_stage"), "won", { position: 6 })), /Nothing to change/);
  assert.match(await refusal(updateStage(ctxFor(db, "update_stage"), "won", {})), /Nothing to change/);
});

test("archiveStage refuses while open deals sit in the stage, listing up to five and suggesting a stage", async () => {
  const db = await openTestDb();
  for (let i = 1; i <= 6; i += 1) {
    const lead = await addLead(ctxFor(db, "add_lead"), { name: `Person ${i}`, dealTitle: `Job ${i}` });
    await updateDeal(ctxFor(db, "update_deal", new Date(NOW.getTime() + i * 60_000)), lead.dealId, { stage: "call_done" });
  }
  const message = await refusal(archiveStage(ctxFor(db, "archive_stage"), "Call done"));
  assert.match(message, /^6 open deals are in Call done: "Job 1" \(Person 1\), /);
  assert.match(message, /"Job 5" \(Person 5\) and 1 more\. Move them first with update_deal, for example to Call booked\.$/);
  assert.doesNotMatch(message, /Job 6/);
  assert.equal((await stage(db, "call_done"))?.archived, 0);

  const empty = await archiveStage(ctxFor(db, "archive_stage"), "new_inquiry");
  assert.match(empty.summary, /^Archived stage New inquiry \(change /);
});

test("a single deal is named in the singular, and an outside title is named by id", async () => {
  const db = await openTestDb();
  const lead = await addLead(ctxFor(db, "add_lead"), { name: "Robin Sample" });
  await db.prepare("UPDATE deals SET untrusted_fields = '[\"title\"]' WHERE id = ?").bind(lead.dealId).run();
  const message = await refusal(archiveStage(ctxFor(db, "archive_stage"), "new_inquiry"));
  assert.equal(
    message,
    `1 open deal is in New inquiry: deal ${lead.dealId} (Robin Sample). Move it first with update_deal, for example to Replied.`,
  );
});

test("archiveStage hides the stage from the board and from lists, and refuses the last stage of a kind", async () => {
  const db = await openTestDb();
  const result = await archiveStage(ctxFor(db, "archive_stage"), "Proposal sent");
  assert.equal(result.summary, `Archived stage Proposal sent (change ${result.changeId})`);
  assert.ok(!(await order(db)).includes("5:proposal_sent"));
  assert.equal((await listStages(db, { includeArchived: true })).length, 8);
  assert.equal((await stageOverview(db, false)).length, 7);
  assert.equal((await stageOverview(db, true)).length, 8);
  assert.match(await refusal(archiveStage(ctxFor(db, "archive_stage"), "proposal_sent")), /already archived/);

  for (const key of ["new_inquiry", "replied", "call_booked"]) await archiveStage(ctxFor(db, "archive_stage"), key);
  assert.match(
    await refusal(archiveStage(ctxFor(db, "archive_stage"), "call_done")),
    /^Can't archive Call done: it's the last open stage, and new leads need one\. Add another open stage first with add_stage\.$/,
  );
  assert.match(await refusal(archiveStage(ctxFor(db, "archive_stage"), "Won")), /last won stage/);
});

test("a new stage goes before the archived ones, and later positions stay a single run", async () => {
  const db = await openTestDb();
  await archiveStage(ctxFor(db, "archive_stage"), "Call booked");
  await addStage(ctxFor(db, "add_stage"), { label: "Demo" });
  const all = (await listStages(db, { includeArchived: true })).map((s) => s.position);
  assert.deepEqual(all, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("every stage change is undoable", async () => {
  const db = await openTestDb();
  const before = await listStages(db, { includeArchived: true });

  const added = await addStage(ctxFor(db, "add_stage"), { label: "Demo booked" });
  const undoneAdd = await undoChange(ctxFor(db, "undo_change", LATER), added.changeId);
  assert.match(undoneAdd.summary, /^Undid chg_[a-z2-7]{12}: Removed stage Demo booked/);
  assert.deepEqual(
    (await listStages(db, { includeArchived: true })).map((s) => [s.key, s.label, s.position, s.archived]),
    before.map((s) => [s.key, s.label, s.position, s.archived]),
  );

  const renamed = await updateStage(ctxFor(db, "update_stage"), "call_done", { label: "Met", position: 1 });
  await undoChange(ctxFor(db, "undo_change", LATER), renamed.changeId);
  assert.deepEqual(
    (await listStages(db)).map((s) => [s.key, s.label, s.position]),
    before.map((s) => [s.key, s.label, s.position]),
  );

  const archived = await archiveStage(ctxFor(db, "archive_stage"), "Proposal sent");
  await undoChange(ctxFor(db, "undo_change", LATER), archived.changeId);
  assert.equal((await stage(db, "proposal_sent"))?.archived, 0);
});
