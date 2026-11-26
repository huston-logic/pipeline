import assert from "node:assert/strict";
import { test } from "node:test";
import { countOf, timeDb } from "../../tests/helpers/time-seed.ts";
import type { ActivityRow, AuditRow, Db, TaskRow, TimeEntryRow } from "../db/db.ts";
import type { Ctx } from "./change.ts";
import { listTime, periodOf } from "./time-read.ts";
import { amendTime, cancelTimer, runningTimer, startTimer, stopTimer } from "./timer.ts";
import { undoChange } from "./undo.ts";

// Thu Nov 19, 10:00 AM in Los Angeles.
const NOW = new Date("2026-11-19T18:00:00.000Z");
const MINUTE = 60_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);
const ctxFor = (db: Db, now = NOW, tool = "start_timer"): Ctx => ({ db, now, actor: "owner", tool });
const entry = (db: Db, id: string) => db.prepare("SELECT * FROM time_entries WHERE id = ?").bind(id).first<TimeEntryRow>();
const audits = async (db: Db) => (await db.prepare("SELECT * FROM audit_log ORDER BY rowid").all<AuditRow>()).results;

test("cancel discards the running timer: nothing runs, nothing is totalled, no note or task", async () => {
  const db = await timeDb(NOW);
  const started = await startTimer(ctxFor(db), { deal: "dl_seed01", workType: "Design" });
  const counts = { activities: await countOf(db, "activities"), tasks: await countOf(db, "tasks") };
  const before = (await audits(db)).length;

  const cancelled = await cancelTimer(ctxFor(db, at(20 * MINUTE), "cancel_timer"));
  assert.equal(cancelled.entryId, started.entryId);
  assert.match(cancelled.summary, /^Discarded the timer started at 10:00 AM: Design, for "Website refresh for Example Plumbing" \(Pat Example\) \(change chg_[a-z0-9]{12}\)$/);
  assert.equal((await audits(db)).length, before + 1, "one change");
  const row = await entry(db, started.entryId);
  assert.deepEqual([row?.archived, row?.ended_at, row?.minutes], [1, null, null]);
  assert.equal(await runningTimer(db), null);
  const summary = await listTime(db, { period: periodOf("this_week", NOW, "America/Los_Angeles") }, "America/Los_Angeles");
  assert.equal(summary.entries.length, 0);
  assert.equal(summary.totalMinutes, 0);
  assert.deepEqual({ activities: await countOf(db, "activities"), tasks: await countOf(db, "tasks") }, counts);

  await assert.rejects(cancelTimer(ctxFor(db, at(21 * MINUTE), "cancel_timer")), /^UserError: No timer is running\.$/);
});

test("undo of a cancel puts the timer back, and is refused while another timer runs", async () => {
  const db = await timeDb(NOW);
  const started = await startTimer(ctxFor(db), { contact: "ct_seed01" });
  const cancelled = await cancelTimer(ctxFor(db, at(5 * MINUTE), "cancel_timer"));
  await undoChange(ctxFor(db, at(6 * MINUTE), "undo_change"), cancelled.changeId);
  assert.equal((await runningTimer(db))?.id, started.entryId);

  const again = await cancelTimer(ctxFor(db, at(7 * MINUTE), "cancel_timer"));
  await startTimer(ctxFor(db, at(8 * MINUTE)), { contact: "ct_seed03" });
  await assert.rejects(
    undoChange(ctxFor(db, at(9 * MINUTE), "undo_change"), again.changeId),
    /^UserError: Can't undo chg_[a-z0-9]{12}: it would start a timer again, but another one is running now\. Stop it first, or leave the change\.$/,
  );
});

test("cancel refuses while time tracking is off", async () => {
  const db = await timeDb(NOW, { on: false });
  await assert.rejects(cancelTimer(ctxFor(db)), /^UserError: Time tracking is off\./);
});

test("amend writes the entry, the note and the Next step task in one change", async () => {
  const db = await timeDb(NOW);
  const started = await startTimer(ctxFor(db), { deal: "dl_seed01", workType: "Design" });
  await stopTimer(ctxFor(db, at(60 * MINUTE), "stop_timer"), {});
  const before = (await audits(db)).length;

  const amended = await amendTime(ctxFor(db, at(62 * MINUTE), "log_time"), started.entryId, {
    notes: "Sent the proofs.",
    nextStepDate: "2026-11-23",
    workType: "Admin",
    billable: false,
  });
  assert.equal((await audits(db)).length, before + 1, "one change");
  assert.equal((await audits(db)).at(-1)?.tool, "log_time");
  const row = await entry(db, started.entryId);
  assert.deepEqual(
    [row?.notes, row?.work_type_id === "wt_design", row?.billable, row?.rate, row?.minutes, row?.version],
    ["Sent the proofs.", false, 0, null, 60, 3],
  );
  const note = await db.prepare("SELECT * FROM activities WHERE summary = 'Sent the proofs.'").first<ActivityRow>();
  assert.deepEqual([note?.type, note?.deal_id, note?.contact_id], ["note", "dl_seed01", "ct_seed01"]);
  assert.equal(row?.activity_id, note?.id);
  const task = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(amended.taskId).first<TaskRow>();
  assert.equal(task?.title, "Next step: Website refresh for Example Plumbing");
  assert.match(amended.summary, /^Updated time: .*; logged a note; added task "Next step: Website refresh for Example Plumbing" due Mon Nov 23 \(change chg_[a-z0-9]{12}\)$/);

  const undone = await undoChange(ctxFor(db, at(63 * MINUTE), "undo_change"), amended.changeId);
  assert.match(undone.summary, /^Undid chg_/);
  assert.equal((await entry(db, started.entryId))?.notes, null);
});

test("amend reprices like an edit, changes the span, and reads only what was given", async () => {
  const db = await timeDb(NOW);
  const started = await startTimer(ctxFor(db), { contact: "ct_seed01", workType: "Design" });
  await stopTimer(ctxFor(db, at(30 * MINUTE), "stop_timer"), {});
  const activities = await countOf(db, "activities");

  const longer = await amendTime(ctxFor(db, at(40 * MINUTE), "log_time"), started.entryId, { endedAt: "2026-11-19T10:40" });
  assert.equal(longer.taskId, null);
  const row = await entry(db, started.entryId);
  assert.deepEqual([row?.minutes, row?.ended_at, row?.rate, row?.billable], [40, "2026-11-19T18:40:00.000Z", 95, 1]);
  assert.equal(await countOf(db, "activities"), activities, "no note without notes");

  await assert.rejects(amendTime(ctxFor(db, at(41 * MINUTE), "log_time"), started.entryId, { startedAt: "2026-11-18T10:00" }), /at most 16 hours/);
  await assert.rejects(amendTime(ctxFor(db, at(41 * MINUTE), "log_time"), started.entryId, { endedAt: "2026-11-19T09:00" }), /The end must be after the start/);
  await assert.rejects(amendTime(ctxFor(db, at(41 * MINUTE), "log_time"), started.entryId, {}), /^UserError: Nothing to change/);
});

test("amend refuses a running or archived entry", async () => {
  const db = await timeDb(NOW);
  const started = await startTimer(ctxFor(db), { contact: "ct_seed01" });
  await assert.rejects(
    amendTime(ctxFor(db, at(MINUTE), "log_time"), started.entryId, { notes: "x" }),
    /^UserError: That entry is still running\. Stop it first\.$/,
  );
  await stopTimer(ctxFor(db, at(30 * MINUTE), "stop_timer"), {});
  await db.prepare("UPDATE time_entries SET archived = 1 WHERE id = ?").bind(started.entryId).run();
  await assert.rejects(
    amendTime(ctxFor(db, at(31 * MINUTE), "log_time"), started.entryId, { notes: "x" }),
    /^UserError: That entry is archived\. Restore it first\.$/,
  );
});
