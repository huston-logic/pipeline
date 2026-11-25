// Tasks, notes, time and the timer on a project (decision 0055, "Link rules"): each record gets project_id and the
// project's person, never a deal.
import assert from "node:assert/strict";
import { test } from "node:test";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { ActivityRow, Db, TaskRow, TimeEntryRow } from "../db/db.ts";
import { logActivity } from "./activities.ts";
import type { Ctx } from "./change.ts";
import { addProject } from "./projects.ts";
import { addTask, completeTask, snoozeTask } from "./tasks.ts";
import { addTimeEntry, updateTimeEntry } from "./time-entries.ts";
import { startTimer, stopTimer } from "./timer.ts";
import { undoChange } from "./undo.ts";

// Thu Nov 19, 10:00 AM in Los Angeles.
const NOW = new Date("2026-11-19T18:00:00.000Z");
const ctxFor = (db: Db, tool = "add_task"): Ctx => ({ db, now: NOW, actor: "owner", tool });
const OFF = /^UserError: Projects are off\. The owner can turn them on \(update_settings projects true\)\.$/;

/** Projects on; "Retrofit" for Pat Example (ct_seed01) and "Garden" for Casey (ct_seed03). */
async function setup() {
  const db = await timeDb(NOW);
  await db.prepare("UPDATE settings SET projects = 1").run();
  const retrofit = await addProject(ctxFor(db, "add_project"), { contact: "ct_seed01", name: "Retrofit" });
  const garden = await addProject(ctxFor(db, "add_project"), { contact: "ct_seed03", name: "Garden" });
  return { db, retrofit: retrofit.projectId, garden: garden.projectId };
}

const task = (db: Db, id: string) => db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<TaskRow>();
const entry = (db: Db, id: string) => db.prepare("SELECT * FROM time_entries WHERE id = ?").bind(id).first<TimeEntryRow>();
const activity = (db: Db, id: string) => db.prepare("SELECT * FROM activities WHERE id = ?").bind(id).first<ActivityRow>();

test("add_task on a project: its id, its person, no deal, named in the summary", async () => {
  const { db, retrofit } = await setup();
  const result = await addTask(ctxFor(db), { project: "Retrofit", title: "Order anchors", dueAt: "2026-11-20" });
  assert.match(result.summary, /^Added task "Order anchors" for "Retrofit" \(Pat Example\), due Fri Nov 20, 12:00 AM \(change chg_[a-z0-9]{12}\)$/);
  const row = await task(db, result.taskId);
  assert.deepEqual([row?.project_id, row?.contact_id, row?.deal_id], [retrofit, "ct_seed01", null]);

  const byId = await addTask(ctxFor(db), { project: retrofit, contactId: "ct_seed01", title: "Call the engineer" });
  assert.equal((await task(db, byId.taskId))?.project_id, retrofit, "the project's own person may be given");

  await undoChange(ctxFor(db, "undo_change"), result.changeId);
  assert.equal(await task(db, result.taskId), null);
});

test("a task on a project refuses a deal, another person and an archived project", async () => {
  const { db, retrofit } = await setup();
  await assert.rejects(addTask(ctxFor(db), { project: "Retrofit", dealId: "dl_seed01", title: "x" }), /^UserError: Give the project or the deal, not both\.$/);
  await assert.rejects(addTask(ctxFor(db), { project: "Retrofit", contactId: "ct_seed03", title: "x" }), /belongs to Pat Example, not /);
  await db.prepare("UPDATE projects SET archived = 1 WHERE id = ?").bind(retrofit).run();
  await assert.rejects(addTask(ctxFor(db), { project: retrofit, title: "x" }), /is archived/);
});

test("complete and snooze name the project of a project task", async () => {
  const { db } = await setup();
  const added = await addTask(ctxFor(db), { project: "Retrofit", title: "Order anchors" });
  const snoozed = await snoozeTask(ctxFor(db, "snooze_task"), added.taskId, "2026-11-25");
  assert.match(snoozed.summary, /^Snoozed task "Order anchors" for "Retrofit" \(Pat Example\) until /);
  const done = await completeTask(ctxFor(db, "complete_task"), added.taskId);
  assert.match(done.summary, /^Completed task "Order anchors" for "Retrofit" \(Pat Example\) \(change /);
});

test("log_activity on a project: a note with project_id and the person, no deal", async () => {
  const { db, retrofit } = await setup();
  const result = await logActivity(ctxFor(db, "log_activity"), { project: "Retrofit", type: "note", summary: "Anchors ordered." });
  assert.match(result.summary, /^Logged a note on "Retrofit" \(Pat Example\): Anchors ordered\. \(change /);
  const row = await activity(db, result.activityId);
  assert.deepEqual([row?.project_id, row?.contact_id, row?.deal_id], [retrofit, "ct_seed01", null]);
  await assert.rejects(logActivity(ctxFor(db), { project: "Retrofit", dealId: "dl_seed01", type: "note", summary: "x" }), /not both/);
  await assert.rejects(logActivity(ctxFor(db), { project: "Retrofit", contactId: "ct_seed03", type: "note", summary: "x" }), /belongs to Pat Example/);
});

test("start_timer and add_time_entry on a project", async () => {
  const { db, retrofit } = await setup();
  const started = await startTimer(ctxFor(db, "start_timer"), { project: "Retrofit", workType: "Design" });
  assert.match(started.summary, /^Started a timer at 10:00 AM: Design, for "Retrofit" \(Pat Example\) \(change /);
  const running = await entry(db, started.entryId);
  assert.deepEqual([running?.project_id, running?.contact_id, running?.deal_id], [retrofit, "ct_seed01", null]);
  await assert.rejects(startTimer(ctxFor(db, "start_timer"), { project: "Garden" }), /already running for "Retrofit" \(Pat Example\)/);

  const added = await addTimeEntry(ctxFor(db, "add_time_entry"), { project: "Retrofit", startedAt: "2026-11-19T07:30", minutes: 60, workType: "Design" });
  assert.match(added.summary, /^Added time 1 h, Design, billable at \$95\.00\/h \(\$95\.00\), for "Retrofit" \(Pat Example\), started /);
  const row = await entry(db, added.entryId);
  assert.deepEqual([row?.project_id, row?.contact_id, row?.deal_id, row?.rate], [retrofit, "ct_seed01", null, 95]);
  await assert.rejects(addTimeEntry(ctxFor(db), { project: "Retrofit", deal: "dl_seed01", startedAt: "2026-11-19T07:30", minutes: 5 }), /not both/);
  await assert.rejects(addTimeEntry(ctxFor(db), { project: "Retrofit", contact: "ct_seed03", startedAt: "2026-11-19T07:30", minutes: 5 }), /belongs to Pat Example/);
});

test("a task on a project puts an entry on it; a task of another project, or of none, is refused with a project", async () => {
  const { db, retrofit, garden } = await setup();
  const onRetrofit = await addTask(ctxFor(db), { project: "Retrofit", title: "Order anchors" });
  const onGarden = await addTask(ctxFor(db), { project: "Garden", title: "Plant ferns" });
  const input = { startedAt: "2026-11-19T07:30", minutes: 30 };

  const alone = await addTimeEntry(ctxFor(db), { ...input, task: onRetrofit.taskId });
  const row = await entry(db, alone.entryId);
  assert.deepEqual([row?.project_id, row?.contact_id, row?.deal_id, row?.task_id], [retrofit, "ct_seed01", null, onRetrofit.taskId]);
  assert.match(alone.summary, /for "Retrofit" \(Pat Example\)/);

  const same = await addTimeEntry(ctxFor(db), { ...input, task: onRetrofit.taskId, project: "Retrofit" });
  assert.equal((await entry(db, same.entryId))?.project_id, retrofit);
  await assert.rejects(addTimeEntry(ctxFor(db), { ...input, task: onGarden.taskId, project: "Retrofit" }), /on another project/);
  await assert.rejects(addTimeEntry(ctxFor(db), { ...input, task: "tk_seed01", project: "Retrofit" }), /not on a project/);
  await assert.rejects(addTimeEntry(ctxFor(db), { ...input, task: onRetrofit.taskId, deal: "dl_seed01" }), /not both/);
  assert.equal((await entry(db, (await startTimer(ctxFor(db, "start_timer"), { task: onGarden.taskId })).entryId))?.project_id, garden);
});

test("update_time_entry sets a project, and null clears it but keeps the person", async () => {
  const { db, retrofit } = await setup();
  const added = await addTimeEntry(ctxFor(db), { deal: "dl_seed01", startedAt: "2026-11-19T07:30", minutes: 30 });
  const set = await updateTimeEntry(ctxFor(db, "update_time_entry"), added.entryId, { project: "Retrofit" });
  assert.match(set.summary, /now 30 min, not billable, for "Retrofit" \(Pat Example\)/);
  const onProject = await entry(db, added.entryId);
  assert.deepEqual([onProject?.project_id, onProject?.contact_id, onProject?.deal_id], [retrofit, "ct_seed01", null]);

  const cleared = await updateTimeEntry(ctxFor(db, "update_time_entry"), added.entryId, { project: null });
  const row = await entry(db, added.entryId);
  assert.deepEqual([row?.project_id, row?.contact_id, row?.deal_id], [null, "ct_seed01", null]);
  assert.match(cleared.summary, /for Pat Example$|for Pat Example \(change/);

  await undoChange(ctxFor(db, "undo_change"), cleared.changeId);
  assert.equal((await entry(db, added.entryId))?.project_id, retrofit, "undo restores the project");
  await assert.rejects(updateTimeEntry(ctxFor(db), added.entryId, { project: "Retrofit", deal: "dl_seed01" }), /not both/);
});

test("an edit never moves an entry off its project; project null does", async () => {
  const { db, retrofit } = await setup();
  const own = await addTask(ctxFor(db), { project: "Retrofit", title: "Order anchors" });
  const plain = await addTask(ctxFor(db), { contactId: "ct_seed01", title: "Call Pat" });
  const other = await addTask(ctxFor(db), { project: "Garden", title: "Plant ferns" });
  const added = await addTimeEntry(ctxFor(db), { task: own.taskId, startedAt: "2026-11-19T07:30", minutes: 30 });
  const edit = (patch: Parameters<typeof updateTimeEntry>[2]) => updateTimeEntry(ctxFor(db, "update_time_entry"), added.entryId, patch);

  await assert.rejects(edit({ deal: "dl_seed01" }), /is on project "Retrofit" \(Pat Example\)\. Give project null \(and task null\)/);
  await assert.rejects(edit({ contact: "ct_seed03" }), /is on project "Retrofit" \(Pat Example\)\. Give project null/);
  await assert.rejects(edit({ task: plain.taskId }), /Task "Call Pat" isn't on project "Retrofit" \(Pat Example\)\. Give a task of the project, or project null/);
  await assert.rejects(edit({ task: other.taskId }), /isn't on project "Retrofit"/);
  await edit({ task: own.taskId, notes: "same task" });
  assert.equal((await entry(db, added.entryId))?.project_id, retrofit);

  await edit({ project: null, task: null, deal: "dl_seed01" });
  const row = await entry(db, added.entryId);
  assert.deepEqual([row?.project_id, row?.deal_id, row?.task_id], [null, "dl_seed01", null]);
});

test("a stopped project timer logs its note and next step on the project", async () => {
  const { db, retrofit } = await setup();
  const started = await startTimer(ctxFor(db, "start_timer"), { project: "Retrofit", workType: "Design" });
  const stopped = await stopTimer({ ...ctxFor(db, "stop_timer"), now: new Date(NOW.getTime() + 90 * 60_000) }, { notes: "Measured the beams.", nextStepDate: "2026-11-21" });
  assert.match(stopped.summary, /^Stopped the timer: 1 h 30 min, Design, billable at \$95\.00\/h \(\$142\.50\), for "Retrofit" \(Pat Example\); logged a note; added task "Next step: Retrofit" due Sat Nov 21 /);
  const note = await activity(db, String(stopped.activityId));
  assert.deepEqual([note?.project_id, note?.contact_id, note?.deal_id], [retrofit, "ct_seed01", null]);
  const next = await task(db, String(stopped.taskId));
  assert.deepEqual([next?.project_id, next?.contact_id, next?.deal_id], [retrofit, "ct_seed01", null]);
  assert.equal((await entry(db, started.entryId))?.project_id, retrofit);
});

test("any project input is PROJECTS_OFF while projects are off", async () => {
  const db = await timeDb(NOW);
  const ref = "pj_aaaaaaaaaaaa";
  await assert.rejects(addTask(ctxFor(db), { project: ref, title: "x" }), OFF);
  await assert.rejects(logActivity(ctxFor(db), { project: ref, type: "note", summary: "x" }), OFF);
  await assert.rejects(startTimer(ctxFor(db), { project: ref }), OFF);
  await assert.rejects(addTimeEntry(ctxFor(db), { project: ref, startedAt: "2026-11-19T07:30", minutes: 5 }), OFF);
  const added = await addTimeEntry(ctxFor(db), { deal: "dl_seed01", startedAt: "2026-11-19T07:30", minutes: 5 });
  await assert.rejects(updateTimeEntry(ctxFor(db), added.entryId, { project: ref }), OFF);
  await assert.rejects(updateTimeEntry(ctxFor(db), added.entryId, { project: null }), OFF);
});
