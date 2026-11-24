import assert from "node:assert/strict";
import { test } from "node:test";
import { countOf, timeDb } from "../../tests/helpers/time-seed.ts";
import type { ActivityRow, AuditRow, Db, TaskRow, TimeEntryRow } from "../db/db.ts";
import type { Ctx } from "./change.ts";
import { runningTimer, startTimer, stopTimer } from "./timer.ts";
import { undoChange } from "./undo.ts";

// Thu Nov 19, 10:00 AM in Los Angeles.
const NOW = new Date("2026-11-19T18:00:00.000Z");
const MINUTE = 60_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);
const ctxFor = (db: Db, now = NOW, tool = "start_timer"): Ctx => ({ db, now, actor: "owner", tool });
const entry = (db: Db, id: string) => db.prepare("SELECT * FROM time_entries WHERE id = ?").bind(id).first<TimeEntryRow>();
const audits = async (db: Db) => (await db.prepare("SELECT * FROM audit_log ORDER BY rowid").all<AuditRow>()).results;

test("one running at a time", async () => {
  const db = await timeDb(NOW);
  assert.equal(await runningTimer(db), null);
  const started = await startTimer(ctxFor(db), { contact: "ct_seed01", workType: "Design" });
  assert.match(started.summary, /^Started a timer at 10:00 AM: Design, for Pat Example \(change chg_[a-z0-9]{12}\)$/);
  const running = await runningTimer(db);
  assert.equal(running?.id, started.entryId);
  assert.deepEqual([running?.started_at, running?.ended_at, running?.minutes, running?.rate, running?.billable], [NOW.toISOString(), null, null, null, 1]);

  await assert.rejects(
    startTimer(ctxFor(db, at(5 * MINUTE)), { deal: "dl_seed03" }),
    /^UserError: A timer is already running for Pat Example since 10:00 AM\. Stop it first\.$/,
  );
  // The database holds the same rule: a second running row can't be written by any path.
  assert.throws(
    () => db.exec("INSERT INTO time_entries (id, started_at, version, created_at, updated_at) VALUES ('te_two', '2026-11-19T18:01:00.000Z', 1, 'x', 'x')"),
    /UNIQUE constraint failed/,
  );
  assert.equal(await countOf(db, "time_entries"), 1);

  // A timer of no one's, started on an earlier day, names the day.
  const other = await timeDb(NOW);
  await startTimer(ctxFor(other, new Date("2026-11-18T17:10:00.000Z")), {});
  await assert.rejects(startTimer(ctxFor(other), {}), /^UserError: A timer is already running since Wed Nov 18, 9:10 AM\. Stop it first\.$/);
});

test("stop stores the entry, the note and the next-step task in one change", async () => {
  const db = await timeDb(NOW);
  const started = await startTimer(ctxFor(db), { deal: "dl_seed01", workType: "Design" });
  const before = (await audits(db)).length;
  const stopped = await stopTimer(ctxFor(db, at(90 * MINUTE), "stop_timer"), { notes: "Finished the homepage draft.", nextStepDate: "2026-11-20" });
  assert.equal(stopped.entryId, started.entryId);
  assert.match(
    stopped.summary,
    /^Stopped the timer: 1 h 30 min, Design, billable at \$95\.00\/h \(\$142\.50\), for "Website refresh for Example Plumbing" \(Pat Example\); logged a note; added task "Next step: Website refresh for Example Plumbing" due Fri Nov 20 \(change chg_[a-z0-9]{12}\)$/,
  );
  const log = await audits(db);
  assert.equal(log.length, before + 1, "one change");

  const row = await entry(db, started.entryId);
  assert.deepEqual(
    [row?.ended_at, row?.minutes, row?.rate, row?.notes, row?.activity_id],
    [at(90 * MINUTE).toISOString(), 90, 95, "Finished the homepage draft.", stopped.activityId],
  );
  const note = await db.prepare("SELECT * FROM activities WHERE id = ?").bind(stopped.activityId).first<ActivityRow>();
  assert.deepEqual(
    [note?.type, note?.summary, note?.deal_id, note?.contact_id, note?.untrusted_text, note?.actor],
    ["note", "Finished the homepage draft.", "dl_seed01", "ct_seed01", null, "owner"],
  );
  const task = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(stopped.taskId).first<TaskRow>();
  assert.deepEqual(
    [task?.title, task?.deal_id, task?.contact_id, task?.due_at, task?.untrusted_fields],
    ["Next step: Website refresh for Example Plumbing", "dl_seed01", "ct_seed01", "2026-11-20T08:00:00.000Z", "[]"],
  );
  assert.equal(await runningTimer(db), null);
  assert.equal(
    await db.prepare("SELECT last_activity_at FROM deals WHERE id = 'dl_seed01'").first("last_activity_at"),
    at(90 * MINUTE).toISOString(),
    "the note resets the deal's quiet clock like any note",
  );

  // Minutes round up to the whole minute; with no timer running there is nothing to stop.
  await startTimer(ctxFor(db, at(100 * MINUTE)), { contact: "ct_seed01" });
  const short = await stopTimer(ctxFor(db, at(100 * MINUTE + 61_000), "stop_timer"), {});
  assert.equal((await entry(db, short.entryId))?.minutes, 2);
  assert.equal(short.activityId, null);
  assert.equal(short.taskId, null);
  await assert.rejects(stopTimer(ctxFor(db, at(120 * MINUTE), "stop_timer"), {}), /^UserError: No timer is running\. Start one with start_timer, or add the time with add_time_entry\.$/);
});

test("a deal whose title came from outside gets a plain Next step task", async () => {
  const db = await timeDb(NOW);
  await startTimer(ctxFor(db), { deal: "dl_seed02" });
  const stopped = await stopTimer(ctxFor(db, at(30 * MINUTE), "stop_timer"), { nextStepDate: "2026-11-20T09:00" });
  const task = await db.prepare("SELECT title FROM tasks WHERE id = ?").bind(stopped.taskId).first<string>("title");
  assert.equal(task, "Next step");
  assert.doesNotMatch(stopped.summary, /Sample Bakery/);
});

test("stop with no subject logs no note", async () => {
  const db = await timeDb(NOW);
  const activities = await countOf(db, "activities");
  await startTimer(ctxFor(db), { workType: "Admin" });
  const stopped = await stopTimer(ctxFor(db, at(20 * MINUTE), "stop_timer"), { notes: "Invoices and email.", nextStepDate: "2026-11-21" });
  assert.equal(stopped.activityId, null);
  assert.equal(await countOf(db, "activities"), activities, "no note without a person or deal");
  const row = await entry(db, stopped.entryId);
  assert.deepEqual([row?.notes, row?.activity_id, row?.billable, row?.rate], ["Invoices and email.", null, 0, null]);
  const task = await db.prepare("SELECT title, deal_id, contact_id FROM tasks WHERE id = ?").bind(stopped.taskId).first();
  assert.deepEqual({ ...task }, { title: "Next step", deal_id: null, contact_id: null });
  assert.match(stopped.summary, /^Stopped the timer: 20 min, Admin, not billable; added task "Next step" due Sat Nov 21 \(change /);
});

test("a timer over 16 hours asks for the times", async () => {
  const db = await timeDb(NOW);
  // Started yesterday at 9:00 AM and left running overnight.
  const started = await startTimer(ctxFor(db, new Date("2026-11-18T17:00:00.000Z")), { contact: "ct_seed01", workType: "Design" });
  const before = await audits(db);
  await assert.rejects(
    stopTimer(ctxFor(db, NOW, "stop_timer"), { notes: "Done." }),
    /^UserError: The timer has been running since Wed Nov 18, 9:00 AM \(25 h\), and an entry can be at most 16 hours\. Edit the start or end: stop it with startedAt or endedAt\.$/,
  );
  await assert.rejects(stopTimer(ctxFor(db, NOW, "stop_timer"), { startedAt: "2026-11-18T09:30" }), /^UserError: A time entry can be at most 16 hours; this one is 24 h 30 min\. Edit the start or end\.$/);
  await assert.rejects(stopTimer(ctxFor(db, NOW, "stop_timer"), { endedAt: "2026-11-18T08:00" }), /The end must be after the start/);
  assert.deepEqual(await audits(db), before, "nothing written");

  const stopped = await stopTimer(ctxFor(db, NOW, "stop_timer"), { endedAt: "2026-11-18T17:00" });
  const row = await entry(db, started.entryId);
  assert.deepEqual([row?.ended_at, row?.minutes], ["2026-11-19T01:00:00.000Z", 480]);
  assert.match(stopped.summary, /^Stopped the timer: 8 h, Design, billable at \$95\.00\/h \(\$760\.00\), for Pat Example \(change /);
});

test("a timer left running past midnight stores the real span", async () => {
  const db = await timeDb(NOW);
  // 11:00 PM on Wed Nov 18 to 1:30 AM on Thu Nov 19, Los Angeles time.
  const started = await startTimer(ctxFor(db, new Date("2026-11-19T07:00:00.000Z")), { contact: "ct_seed01" });
  await stopTimer(ctxFor(db, new Date("2026-11-19T09:30:00.000Z"), "stop_timer"), {});
  const row = await entry(db, started.entryId);
  assert.deepEqual([row?.started_at, row?.ended_at, row?.minutes], ["2026-11-19T07:00:00.000Z", "2026-11-19T09:30:00.000Z", 150]);
});

test("undo of a stop restores the running timer", async () => {
  const db = await timeDb(NOW);
  const started = await startTimer(ctxFor(db), { deal: "dl_seed01", workType: "Design" });
  const runningRow = await entry(db, started.entryId);
  const counts = { activities: await countOf(db, "activities"), tasks: await countOf(db, "tasks") };
  const stopped = await stopTimer(ctxFor(db, at(45 * MINUTE), "stop_timer"), { notes: "Wireframes.", nextStepDate: "2026-11-20" });

  const undone = await undoChange(ctxFor(db, at(46 * MINUTE), "undo_change"), stopped.changeId);
  assert.match(undone.summary, /^Undid chg_[a-z0-9]{12}: Removed the note "Wireframes\." and task "Next step: Website refresh for Example Plumbing"; put back the earlier /);
  const back = await entry(db, started.entryId);
  assert.deepEqual({ ...back, version: 0, updated_at: "" }, { ...runningRow, version: 0, updated_at: "" });
  assert.equal((await runningTimer(db))?.id, started.entryId);
  assert.deepEqual({ activities: await countOf(db, "activities"), tasks: await countOf(db, "tasks") }, counts);

  // It runs on and stops again; undoing the start removes it.
  await stopTimer(ctxFor(db, at(60 * MINUTE), "stop_timer"), {});
  assert.equal((await entry(db, started.entryId))?.minutes, 60);
});

test("undo of a stop is refused while another timer runs", async () => {
  const db = await timeDb(NOW);
  await startTimer(ctxFor(db), { contact: "ct_seed01" });
  const stopped = await stopTimer(ctxFor(db, at(30 * MINUTE), "stop_timer"), {});
  await startTimer(ctxFor(db, at(31 * MINUTE)), { contact: "ct_seed03" });
  await assert.rejects(
    undoChange(ctxFor(db, at(32 * MINUTE), "undo_change"), stopped.changeId),
    /^UserError: Can't undo chg_[a-z0-9]{12}: it would start a timer again, but another one is running now\. Stop it first, or leave the change\.$/,
  );
});

test("an archived timer can't be brought back while another one runs", async () => {
  const db = await timeDb(NOW);
  const { updateTimeEntry } = await import("./time-entries.ts");
  const first = await startTimer(ctxFor(db), { contact: "ct_seed01" });
  await updateTimeEntry(ctxFor(db, NOW, "update_time_entry"), first.entryId, { archived: true });
  assert.equal(await runningTimer(db), null, "an archived timer doesn't run");
  await startTimer(ctxFor(db, at(MINUTE)), { contact: "ct_seed03" });
  await assert.rejects(
    updateTimeEntry(ctxFor(db, at(2 * MINUTE), "update_time_entry"), first.entryId, { archived: false }),
    /^UserError: Another timer is running\. Stop it first, or leave this one archived\.$/,
  );
});

test("the timer refuses while time tracking is off", async () => {
  const db = await timeDb(NOW, { on: false });
  const off = /^UserError: Time tracking is off\. The owner can turn it on \(update_settings timeTracking true\)\.$/;
  await assert.rejects(startTimer(ctxFor(db), {}), off);
  await assert.rejects(stopTimer(ctxFor(db), {}), off);
});

test("stopping with workType null clears the timer's work type and its billable; undefined keeps both (decision 0050)", async () => {
  const kept = await timeDb(NOW);
  await startTimer(ctxFor(kept), { contact: "ct_seed01", workType: "Design" });
  const keep = await stopTimer(ctxFor(kept, at(30 * MINUTE), "stop_timer"), {});
  const keptRow = await entry(kept, keep.entryId);
  assert.equal(keptRow?.work_type_id, "wt_design");
  assert.equal(keptRow?.billable, 1);

  const cleared = await timeDb(NOW);
  await startTimer(ctxFor(cleared), { contact: "ct_seed01", workType: "Design" });
  const none = await stopTimer(ctxFor(cleared, at(30 * MINUTE), "stop_timer"), { workType: null });
  const row = await entry(cleared, none.entryId);
  assert.equal(row?.work_type_id, null);
  assert.equal(row?.billable, 0);
  assert.equal(row?.rate, null);

  const ticked = await timeDb(NOW);
  await startTimer(ctxFor(ticked), { contact: "ct_seed01", workType: "Design" });
  const both = await stopTimer(ctxFor(ticked, at(30 * MINUTE), "stop_timer"), { workType: null, billable: true });
  assert.equal((await entry(ticked, both.entryId))?.billable, 1);
});
