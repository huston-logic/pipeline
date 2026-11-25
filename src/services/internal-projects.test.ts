// A project with no person (an internal project, projects design area 1): its records have no person and no deal, every
// summary names the project alone, every reader keeps its rows, and time uses the work type's rate.
import assert from "node:assert/strict";
import { test } from "node:test";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { ActivityRow, Db, TaskRow, TimeEntryRow } from "../db/db.ts";
import { timeCsv } from "../http/time-csv.ts";
import { DEFAULT_TZ } from "../time.ts";
import { logActivity } from "./activities.ts";
import type { Ctx } from "./change.ts";
import { checkOnProject, projectLinks } from "./project-links.ts";
import { getProject, listProjects } from "./project-read.ts";
import { addProject, updateProject } from "./projects.ts";
import { listTaskItems, openTaskLists } from "./read.ts";
import { addTask, completeTask } from "./tasks.ts";
import { addTimeEntry, updateTimeEntry } from "./time-entries.ts";
import { listTime, timeByClientMonth } from "./time-read.ts";
import { startTimer, stopTimer } from "./timer.ts";
import { undoChange } from "./undo.ts";
import { setClientRate } from "./work-types.ts";

// Thu Nov 19, 10:00 AM in Los Angeles.
const NOW = new Date("2026-11-19T18:00:00.000Z");
const ctxFor = (db: Db, tool = "add_task"): Ctx => ({ db, now: NOW, actor: "owner", tool });

/** Projects and time on; the internal project "Office move"; Pat has her own Design rate that must never apply to it. */
async function setup() {
  const db = await timeDb(NOW);
  await db.prepare("UPDATE settings SET projects = 1").run();
  await setClientRate(ctxFor(db, "set_client_rate"), { workType: "Design", contact: "ct_seed01", hourlyRate: 150 });
  const added = await addProject(ctxFor(db, "add_project"), { name: "Office move", targetAt: "2026-12-15" });
  return { db, project: added.projectId, added };
}

const task = (db: Db, id: string) => db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<TaskRow>();
const entry = (db: Db, id: string) => db.prepare("SELECT * FROM time_entries WHERE id = ?").bind(id).first<TimeEntryRow>();
const activity = (db: Db, id: string) => db.prepare("SELECT * FROM activities WHERE id = ?").bind(id).first<ActivityRow>();
const bare = (row: { contact_id: string | null; deal_id: string | null; project_id?: string | null } | null) => [row?.contact_id, row?.deal_id, row?.project_id];

test("addProject with neither person nor deal is an internal project", async () => {
  const { db, project, added } = await setup();
  assert.match(added.summary, /^Added project "Office move" \(change chg_[a-z0-9]{12}\)$/);
  assert.equal(added.contactId, undefined);
  const row = await db.prepare("SELECT * FROM projects WHERE id = ?").bind(project).first<{ contact_id: string | null; deal_id: string | null }>();
  assert.deepEqual([row?.contact_id, row?.deal_id], [null, null]);
  const links = await projectLinks(db, "Office move");
  assert.equal(links.contact, null);
  await undoChange(ctxFor(db, "undo_change"), added.changeId);
  assert.equal(await db.prepare("SELECT id FROM projects WHERE id = ?").bind(project).first(), null);
});

test("records on an internal project have no person and no deal, and read as the project alone", async () => {
  const { db, project } = await setup();
  const made = await addTask(ctxFor(db), { project: "Office move", title: "Book movers", dueAt: "2026-11-20" });
  assert.match(made.summary, /^Added task "Book movers" for "Office move", due Fri Nov 20, 12:00 AM \(change chg_[a-z0-9]{12}\)$/);
  assert.deepEqual(bare(await task(db, made.taskId)), [null, null, project]);
  assert.match((await completeTask(ctxFor(db, "complete_task"), made.taskId)).summary, /^Completed task "Book movers" for "Office move" \(change /);

  const note = await logActivity(ctxFor(db, "log_activity"), { project: project, type: "note", summary: "Movers booked." });
  assert.match(note.summary, /^Logged a note on "Office move": Movers booked\.\s\(change /);
  assert.deepEqual(bare(await activity(db, note.activityId)), [null, null, project]);

  const added = await addTimeEntry(ctxFor(db, "add_time_entry"), { project: "Office move", startedAt: "2026-11-18T09:00", minutes: 60, workType: "Design", billable: true });
  assert.match(added.summary, /^Added time 1 h, Design, billable at \$95\.00\/h \(\$95\.00\), for "Office move", started /);
  assert.deepEqual(bare(await entry(db, added.entryId)), [null, null, project]);
  assert.equal((await entry(db, added.entryId))?.rate, 95, "the work type's rate, not Pat's own");
});

test("a person given for an internal project is refused", async () => {
  const { db } = await setup();
  const refusal = /^UserError: "Office move" is an internal project with no person\. Leave out the person\.$/;
  await assert.rejects(addTask(ctxFor(db), { project: "Office move", contactId: "ct_seed01", title: "x" }), refusal);
  await assert.rejects(logActivity(ctxFor(db), { project: "Office move", contactId: "Pat Example", type: "note", summary: "x" }), refusal);
  await assert.rejects(addTask(ctxFor(db), { project: "Office move", dealId: "dl_seed01", title: "x" }), /not both/);
  const { project, contact } = await projectLinks(db, "Office move");
  checkOnProject(project, contact, { deal: false, contact: null });
});

test("the timer on an internal project: start, stop with a note and a next step", async () => {
  const { db, project } = await setup();
  const started = await startTimer(ctxFor(db, "start_timer"), { project: "Office move", workType: "Design" });
  assert.match(started.summary, /^Started a timer at 10:00 AM: Design, for "Office move" \(change /);
  assert.deepEqual(bare(await entry(db, started.entryId)), [null, null, project]);

  const later = { ...ctxFor(db, "stop_timer"), now: new Date("2026-11-19T19:00:00.000Z") };
  const stopped = await stopTimer(later, { notes: "Boxed the lab.", nextStepDate: "2026-11-25", billable: true });
  assert.ok(stopped.activityId && stopped.taskId);
  assert.deepEqual(bare(await activity(db, stopped.activityId)), [null, null, project]);
  assert.deepEqual(bare(await task(db, stopped.taskId)), [null, null, project]);
  assert.equal((await task(db, stopped.taskId))?.title, "Next step: Office move");
  assert.equal((await entry(db, started.entryId))?.rate, 95);
});

test("editing time on an internal project keeps it there and reprices at the work type's rate", async () => {
  const { db, project } = await setup();
  const added = await addTimeEntry(ctxFor(db, "add_time_entry"), { project: "Office move", startedAt: "2026-11-18T09:00", minutes: 60, workType: "Admin" });
  const edited = await updateTimeEntry(ctxFor(db, "update_time_entry"), added.entryId, { workType: "Design", billable: true });
  assert.match(edited.summary, /for "Office move"/);
  const row = await entry(db, added.entryId);
  assert.deepEqual([row?.project_id, row?.contact_id, row?.rate], [project, null, 95]);
  await updateTimeEntry(ctxFor(db, "update_time_entry"), added.entryId, { minutes: 90 });
  await assert.rejects(updateTimeEntry(ctxFor(db, "update_time_entry"), added.entryId, { contact: "ct_seed01" }), /is on project "Office move"/);
  await assert.rejects(updateTimeEntry(ctxFor(db, "update_time_entry"), added.entryId, { project: "Office move", contact: "ct_seed01" }), /internal project/);
});

test("update_project and the project readers keep an internal project", async () => {
  const { db, project } = await setup();
  const updated = await updateProject(ctxFor(db, "update_project"), project, { status: "done" });
  assert.match(updated.summary, /^Updated project "Office move": status Active -> Done \(change /);
  await assert.rejects(updateProject(ctxFor(db, "update_project"), project, { status: "done" }), /^UserError: Nothing to change on "Office move": /);

  await addTask(ctxFor(db), { project, title: "Book movers" });
  const list = await listProjects(db);
  assert.deepEqual(list.items.map((item) => [item.id, item.contactId, item.contactName, item.openTasks, item.untrusted_fields]), [[project, null, null, 1, []]]);
  assert.equal(list.total, 1);
  assert.equal((await listProjects(db, { contact: "ct_seed01" })).total, 0);
  const detail = await getProject(db, "Office move", NOW);
  assert.deepEqual([detail.contactId, detail.contactName, detail.openTasks.map((t) => [t.title, t.contactId, t.contactName, t.projectName])], [null, null, [["Book movers", null, null, "Office move"]]]);
});

test("task readers list an internal project's task, as linked and not standalone", async () => {
  const { db, project } = await setup();
  const made = await addTask(ctxFor(db), { project, title: "Book movers" });
  await addTask(ctxFor(db), { title: "Buy stamps" });
  const mine = new Set(["Book movers", "Buy stamps"]);
  const titles = (items: { title: string }[]) => items.map((item) => item.title).filter((title) => mine.has(title)).sort();
  const lists = (show: "all" | "linked" | "standalone") => openTaskLists(db, NOW, DEFAULT_TZ, { sort: "due", show }, 50);
  assert.deepEqual(titles((await lists("all")).undated), ["Book movers", "Buy stamps"]);
  assert.deepEqual(titles((await lists("linked")).undated), ["Book movers"]);
  assert.deepEqual(titles((await lists("standalone")).undated), ["Buy stamps"]);
  assert.deepEqual(titles(await listTaskItems(db, { standalone: true }, DEFAULT_TZ)), ["Buy stamps"]);
  const byProject = await listTaskItems(db, { project }, DEFAULT_TZ);
  assert.deepEqual(byProject.map((t) => [t.id, t.contactName, t.projectName]), [[made.taskId, null, "Office move"]]);
});

test("time readers group an internal project's time as No person and the CSV keeps its project", async () => {
  const { db } = await setup();
  await addTimeEntry(ctxFor(db, "add_time_entry"), { project: "Office move", startedAt: "2026-11-18T09:00", minutes: 60, workType: "Design", billable: true });
  const week = await listTime(db, { period: { from: "2026-11-16", to: "2026-11-22" } }, DEFAULT_TZ);
  assert.equal(week.entries.length, 1);
  assert.deepEqual(week.byPerson.map((p) => [p.id, p.label, p.minutes, p.amount]), [[null, "No person", 60, 95]]);
  assert.deepEqual((await timeByClientMonth(db, "2026-11", DEFAULT_TZ)).map((row) => [row.contactId, row.contact, row.amount]), [[null, "No person", 95]]);
  const csv = await timeCsv(db, "2026-11", DEFAULT_TZ);
  assert.match(csv, /No person,Office move,Design,1\.00,1\.00,95\.00,95\.00/);
});
