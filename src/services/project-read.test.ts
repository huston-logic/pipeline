// Reading projects (decision 0055): the list with open-task counts, one project's sections and time totals, and the
// project on task items and a deal's brief. Everything refuses while projects are off, except the task items, which
// then carry null.
import assert from "node:assert/strict";
import { test } from "node:test";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { Db } from "../db/db.ts";
import { DEFAULT_TZ } from "../time.ts";
import { logActivity } from "./activities.ts";
import type { Ctx } from "./change.ts";
import { getProject, listProjects } from "./project-read.ts";
import { addProject, updateProject } from "./projects.ts";
import { getDealBrief, listTaskItems, openTaskLists, projectTaskItems, whatsDue } from "./read.ts";
import { addTask, completeTask } from "./tasks.ts";
import { addTimeEntry } from "./time-entries.ts";
import { startTimer } from "./timer.ts";

// Thu Nov 19, 10:00 AM in Los Angeles.
const NOW = new Date("2026-11-19T18:00:00.000Z");
const ctxFor = (db: Db, tool = "add_project"): Ctx => ({ db, now: NOW, actor: "owner", tool });
const OFF = /^UserError: Projects are off\. The owner can turn them on \(update_settings projects true\)\.$/;
const ids = (items: { id: string }[]) => items.map((item) => item.id);

/** Projects on. Retrofit (Pat, target Dec 5), Garden (Casey, target Nov 30, On hold), Shed (Pat, no target). */
async function setup(options: { time?: boolean } = {}) {
  const db = await timeDb(NOW, { on: options.time !== false });
  await db.prepare("UPDATE settings SET projects = 1").run();
  const retrofit = await addProject(ctxFor(db), { contact: "ct_seed01", name: "Retrofit", targetAt: "2026-12-05" });
  const garden = await addProject(ctxFor(db), { contact: "ct_seed03", name: "Garden", status: "on_hold", targetAt: "2026-11-30" });
  const shed = await addProject(ctxFor(db), { contact: "ct_seed01", name: "Shed" });
  return { db, retrofit: retrofit.projectId, garden: garden.projectId, shed: shed.projectId };
}

test("listProjects and getProject refuse while projects are off", async () => {
  const db = await timeDb(NOW);
  await assert.rejects(listProjects(db, {}), OFF);
  await assert.rejects(getProject(db, "pj_nothing", NOW), OFF);
});

test("listProjects: soonest target first, none last, then name; archived left out", async () => {
  const { db, garden, retrofit, shed } = await setup();
  const all = await listProjects(db, {});
  assert.deepEqual(ids(all.items), [garden, retrofit, shed]);
  assert.equal(all.total, 3);
  assert.deepEqual(all.statuses.map((s) => s.key), ["active", "on_hold", "done"]);
  const first = all.items[0];
  assert.deepEqual(first, {
    id: garden,
    name: "Garden",
    status: "on_hold",
    statusLabel: "On hold",
    contactId: "ct_seed03",
    contactName: "Casey Placeholder",
    dealId: null,
    dealTitle: null,
    startAt: null,
    targetAt: first?.targetAt,
    archived: false,
    fields: {},
    openTasks: 0,
    untrusted_fields: [],
  });
  await updateProject(ctxFor(db, "update_project"), shed, { archived: true });
  assert.deepEqual(ids((await listProjects(db, {})).items), [garden, retrofit]);
  assert.deepEqual(ids((await listProjects(db, { includeArchived: true })).items), [garden, retrofit, shed]);
});

test("listProjects status open or closed means every live status of that kind, and statuses carry their kind", async () => {
  const { db, garden, retrofit, shed } = await setup();
  await updateProject(ctxFor(db, "update_project"), shed, { status: "done" });
  assert.deepEqual(ids((await listProjects(db, { status: "open" })).items), [garden, retrofit]);
  assert.deepEqual(ids((await listProjects(db, { status: "Closed" })).items), [shed]);
  const all = await listProjects(db, {});
  assert.deepEqual(all.statuses, [
    { key: "active", label: "Active", kind: "open" },
    { key: "on_hold", label: "On hold", kind: "open" },
    { key: "done", label: "Done", kind: "closed" },
  ]);
  await assert.rejects(listProjects(db, { status: "nope" }), /no status "nope"/);
});

test("listProjects sorts by name or newest and filters by status and person", async () => {
  const { db, garden, retrofit, shed } = await setup();
  for (const [i, id] of [retrofit, garden, shed].entries()) {
    await db.prepare("UPDATE projects SET created_at = ? WHERE id = ?").bind(`2026-11-1${i}T00:00:00.000Z`, id).run();
  }
  assert.deepEqual(ids((await listProjects(db, { sort: "name" })).items), [garden, retrofit, shed]);
  assert.deepEqual(ids((await listProjects(db, { sort: "newest" })).items), [shed, garden, retrofit]);
  assert.deepEqual(ids((await listProjects(db, { status: "On hold" })).items), [garden]);
  assert.deepEqual(ids((await listProjects(db, { status: "active" })).items), [retrofit, shed]);
  assert.deepEqual(ids((await listProjects(db, { contact: "Pat Example" })).items), [retrofit, shed]);
  await assert.rejects(listProjects(db, { status: "stuck" }), /There is no status "stuck"\. Statuses: Active, On hold, Done\./);
});

test("listProjects counts open tasks (snoozed ones too, done ones not) and caps the list at 200 with the total", async () => {
  const { db, retrofit } = await setup();
  await addTask(ctxFor(db, "add_task"), { project: "Retrofit", title: "Order anchors" });
  const second = await addTask(ctxFor(db, "add_task"), { project: "Retrofit", title: "Call the engineer" });
  const third = await addTask(ctxFor(db, "add_task"), { project: "Retrofit", title: "Pour footing" });
  await completeTask(ctxFor(db, "complete_task"), third.taskId);
  await db.prepare("UPDATE tasks SET snoozed_until = '2026-12-01T00:00:00.000Z' WHERE id = ?").bind(second.taskId).run();
  const found = (await listProjects(db, { status: "active" })).items.find((item) => item.id === retrofit);
  assert.equal(found?.openTasks, 2);

  const rows = Array.from({ length: 205 }, (_, i) => `('pj_bulk${i}', 'Bulk ${i}', 'ct_seed01', 'active', '${NOW.toISOString()}', '${NOW.toISOString()}')`);
  await db.exec(`INSERT INTO projects (id, name, contact_id, status_key, created_at, updated_at) VALUES ${rows.join(", ")}`);
  const capped = await listProjects(db, { limit: 500 });
  assert.equal(capped.items.length, 200);
  assert.equal(capped.total, 208);
  assert.equal((await listProjects(db, { limit: 2 })).items.length, 2);
});

test("a project's name, person and deal are outside text when their rows say so", async () => {
  const { db, retrofit } = await setup();
  await db.prepare("UPDATE projects SET untrusted_fields = '[\"name\"]' WHERE id = ?").bind(retrofit).run();
  await db.prepare("UPDATE contacts SET untrusted_fields = '[\"name\"]' WHERE id = 'ct_seed01'").run();
  const item = (await listProjects(db, {})).items.find((i) => i.id === retrofit);
  assert.deepEqual(item?.untrusted_fields, ["name", "contactName"]);
  assert.deepEqual((await getProject(db, retrofit, NOW)).untrusted_fields, ["name", "contactName"]);
});

test("a project from a deal names the deal", async () => {
  const { db } = await setup();
  const made = await addProject(ctxFor(db), { deal: "dl_seed07", name: "Rebuild" });
  const item = (await listProjects(db, {})).items.find((i) => i.id === made.projectId);
  assert.equal(item?.dealId, "dl_seed07");
  assert.ok(item?.dealTitle);
});

test("getProject: notes, open and done tasks, the timeline and the time totals", async () => {
  const { db, retrofit } = await setup();
  await db.prepare("UPDATE projects SET notes = 'Permit pending.' WHERE id = ?").bind(retrofit).run();
  await addTask(ctxFor(db, "add_task"), { project: "Retrofit", title: "Order anchors", dueAt: "2026-11-20" });
  const done = await addTask(ctxFor(db, "add_task"), { project: "Retrofit", title: "Pour footing" });
  await completeTask(ctxFor(db, "complete_task"), done.taskId);
  const note = await logActivity(ctxFor(db, "log_activity"), { project: "Retrofit", type: "note", summary: "Anchors ordered." });
  // 90 min billable Design at $95 ($142.50), 30 min not billable, one running timer, one archived entry.
  await addTimeEntry(ctxFor(db, "add_time_entry"), { project: "Retrofit", startedAt: "2026-11-17T09:00", minutes: 90, workType: "Design" });
  await addTimeEntry(ctxFor(db, "add_time_entry"), { project: "Retrofit", startedAt: "2026-11-18T09:00", minutes: 30, workType: "Admin" });
  const gone = await addTimeEntry(ctxFor(db, "add_time_entry"), { project: "Retrofit", startedAt: "2026-11-18T12:00", minutes: 45, workType: "Design" });
  await db.prepare("UPDATE time_entries SET archived = 1 WHERE id = ?").bind(gone.entryId).run();
  await startTimer(ctxFor(db, "start_timer"), { project: "Retrofit" });

  const detail = await getProject(db, "retrofit", NOW);
  assert.equal(detail.id, retrofit);
  assert.equal(detail.notes, "Permit pending.");
  assert.deepEqual(detail.openTasks.map((t) => [t.title, t.projectId, t.projectName, t.contactName]), [["Order anchors", retrofit, "Retrofit", "Pat Example"]]);
  assert.equal(detail.openTasks[0]?.dueAtLocal, "Fri Nov 20, 12:00 AM");
  assert.deepEqual(detail.doneTasks.map((t) => t.title), ["Pour footing"]);
  assert.equal(detail.openTasks.length, (await listProjects(db, {})).items.find((i) => i.id === retrofit)?.openTasks);
  assert.deepEqual(ids(detail.timeline), [note.activityId]);
  assert.equal(detail.timeline[0]?.summary, "Anchors ordered.");
  assert.deepEqual(detail.time, { minutes: 120, billableMinutes: 90, nonBillableMinutes: 30, amountCents: 14250, running: true });
});

test("getProject keeps the latest 20 done tasks and 20 notes; the time is null while time tracking is off", async () => {
  const { db, retrofit } = await setup({ time: false });
  for (let i = 0; i < 22; i++) {
    const t = await addTask(ctxFor(db, "add_task"), { project: "Retrofit", title: `Task ${i}` });
    await completeTask({ ...ctxFor(db, "complete_task"), now: new Date(NOW.getTime() + i * 60_000) }, t.taskId);
    await logActivity({ ...ctxFor(db, "log_activity"), now: new Date(NOW.getTime() + i * 60_000) }, { project: "Retrofit", type: "note", summary: `Note ${i}`, occurredAt: new Date(NOW.getTime() + i * 60_000).toISOString() });
  }
  const detail = await getProject(db, retrofit, NOW);
  assert.equal(detail.doneTasks.length, 20);
  assert.equal(detail.doneTasks[0]?.title, "Task 21", "latest done first");
  assert.equal(detail.timeline.length, 20);
  assert.equal(detail.time, null);
});

test("the done-task read selects only the latest rows, ties broken by id, in SQL", async () => {
  const { db, retrofit } = await setup({ time: false });
  for (let i = 0; i < 6; i++) {
    const t = await addTask(ctxFor(db, "add_task"), { project: "Retrofit", title: `Task ${i}` });
    await completeTask(ctxFor(db, "complete_task"), t.taskId);
  }
  const expected = (
    await db.prepare("SELECT id FROM tasks WHERE project_id = ? ORDER BY done_at DESC, id DESC LIMIT 3").bind(retrofit).all<{ id: string }>()
  ).results.map((r) => r.id);
  assert.deepEqual(ids(await projectTaskItems(db, retrofit, "done", DEFAULT_TZ, 3)), expected);
});

test("an unknown project is a plain refusal", async () => {
  const { db } = await setup();
  await assert.rejects(getProject(db, "Nothing", NOW), /No project matches "Nothing"/);
});

test("task items carry the project, null while projects are off", async () => {
  const { db, retrofit } = await setup();
  const added = await addTask(ctxFor(db, "add_task"), { project: "Retrofit", title: "Order anchors", dueAt: "2026-11-18" });
  await db.prepare("UPDATE projects SET untrusted_fields = '[\"name\"]' WHERE id = ?").bind(retrofit).run();
  const [item] = await listTaskItems(db, { project: "Retrofit" }, DEFAULT_TZ);
  assert.deepEqual([item?.id, item?.projectId, item?.projectName], [added.taskId, retrofit, "Retrofit"]);
  assert.ok(item?.untrusted_fields.includes("projectName"));
  assert.equal((await whatsDue(db, NOW, DEFAULT_TZ)).overdueTasks.find((t) => t.id === added.taskId)?.projectName, "Retrofit");
  const lists = await openTaskLists(db, NOW, DEFAULT_TZ, { sort: "due", show: "all" }, 50);
  assert.equal(lists.todo.find((t) => t.id === added.taskId)?.projectId, retrofit);
  const other = await listTaskItems(db, {}, DEFAULT_TZ);
  assert.equal(other.find((t) => t.id === "tk_seed01")?.projectId, null);
  assert.deepEqual(ids(await listTaskItems(db, { project: retrofit }, DEFAULT_TZ)), [added.taskId]);

  await db.prepare("UPDATE settings SET projects = 0").run();
  const off = (await listTaskItems(db, {}, DEFAULT_TZ)).find((t) => t.id === added.taskId);
  assert.deepEqual([off?.projectId, off?.projectName], [null, null]);
  assert.ok(!off?.untrusted_fields.includes("projectName"));
  await assert.rejects(listTaskItems(db, { project: "Retrofit" }, DEFAULT_TZ), OFF);
});

test("getDealBrief lists the deal's projects only while projects are on", async () => {
  const { db } = await setup();
  const made = await addProject(ctxFor(db), { deal: "dl_seed07", name: "Rebuild" });
  const brief = await getDealBrief(db, "dl_seed07", DEFAULT_TZ, NOW);
  assert.deepEqual(brief.projects, [{ id: made.projectId, name: "Rebuild", status: "active", statusLabel: "Active", untrusted_fields: [] }]);
  await updateProject(ctxFor(db, "update_project"), made.projectId, { archived: true });
  assert.deepEqual((await getDealBrief(db, "dl_seed07", DEFAULT_TZ, NOW)).projects, []);
  await db.prepare("UPDATE settings SET projects = 0").run();
  assert.equal("projects" in (await getDealBrief(db, "dl_seed07", DEFAULT_TZ, NOW)), false);
});

test("task items carry parent, depth, position and direct sub-task counts; an outside parent title is null; off hides them", async () => {
  const { db, retrofit } = await setup();
  const top = (await addTask(ctxFor(db, "add_task"), { project: retrofit, title: "Order anchors" })).taskId;
  const kid = (await addTask(ctxFor(db, "add_task"), { parent: top, title: "Pick supplier" })).taskId;
  const grand = (await addTask(ctxFor(db, "add_task"), { parent: kid, title: "Get quotes" })).taskId;
  const other = (await addTask(ctxFor(db, "add_task"), { parent: top, title: "Pay deposit" })).taskId;
  await completeTask(ctxFor(db, "complete_task"), other);
  const byId = async () => new Map((await listTaskItems(db, { status: "open", project: retrofit }, DEFAULT_TZ)).map((t) => [t.id, t]));
  const items = await byId();
  assert.deepEqual([items.get(top)?.parentId, items.get(top)?.depth, items.get(top)?.subTasks], [null, 0, { open: 1, done: 1 }]);
  assert.deepEqual([items.get(kid)?.parentId, items.get(kid)?.parentTitle, items.get(kid)?.depth, items.get(kid)?.position], [top, "Order anchors", 1, 1]);
  assert.deepEqual([items.get(grand)?.depth, items.get(grand)?.subTasks], [2, { open: 0, done: 0 }]);
  await db.prepare("UPDATE tasks SET untrusted_fields = '[\"title\"]' WHERE id = ?").bind(top).run();
  const outside = (await byId()).get(kid);
  assert.deepEqual([outside?.parentId, outside?.parentTitle], [top, null]);
  await db.prepare("UPDATE tasks SET parent_id = ? WHERE id = ?").bind(grand, top).run();
  assert.equal(((await byId()).get(top))?.depth, 2);
  await db.prepare("UPDATE settings SET projects = 0").run();
  const off = (await listTaskItems(db, {}, DEFAULT_TZ)).find((t) => t.id === kid);
  assert.deepEqual([off?.parentId, off?.parentTitle, off?.depth], [null, null, 0]);
});
