import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContactRow, Db, DealRow, ProjectRow, TaskRow } from "../db/db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import { addDeal } from "./add-deal.ts";
import type { Ctx } from "./change.ts";
import { updateDeal } from "./deals.ts";
import { checkOnProject, projectLinks } from "./project-links.ts";
import { addProject, findProject, updateProject } from "./projects.ts";
import { addTask, snoozeTask } from "./tasks.ts";
import { undoChange } from "./undo.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const ctxFor = (db: Db, tool = "add_project", actor: Ctx["actor"] = "owner"): Ctx => ({ db, now: NOW, actor, tool });

/** Projects on, and Pat Example with a won deal "Seismic retrofit" that has tasks. */
async function setup(options: { on?: boolean } = {}) {
  const db = await openTestDb();
  if (options.on !== false) await db.prepare("UPDATE settings SET projects = 1").run();
  const lead = await addDeal(ctxFor(db, "add_deal"), { name: "Pat Example", dealTitle: "Seismic retrofit" });
  await updateDeal(ctxFor(db, "update_deal"), lead.dealId, { status: "won" });
  return { db, ...lead };
}

const projectRow = async (db: Db, id: string) => {
  const row = await db.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first<ProjectRow>();
  assert.ok(row);
  return row;
};
const taskRow = async (db: Db, id: string) => {
  const row = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<TaskRow>();
  assert.ok(row);
  return row;
};
const dealRow = (db: Db, id: string) => db.prepare("SELECT * FROM deals WHERE id = ?").bind(id).first<DealRow>();

test("every project service refuses while projects are off", async () => {
  const { db, dealId } = await setup({ on: false });
  const off = /Projects are off/;
  await assert.rejects(addProject(ctxFor(db), { deal: dealId }), off);
  await assert.rejects(updateProject(ctxFor(db), "pj_aaaaaaaaaaaa", { name: "x" }), off);
  await assert.rejects(findProject(db, "pj_aaaaaaaaaaaa"), off);
  await assert.rejects(projectLinks(db, "pj_aaaaaaaaaaaa"), off);
});

test("addProject from a won deal takes the deal's title, status Active and the deal's person", async () => {
  const { db, dealId, contactId } = await setup();
  const dealBefore = JSON.stringify(await dealRow(db, dealId));
  const result = await addProject(ctxFor(db), { deal: "Seismic retrofit", name: "Retrofit", startAt: "2026-12-01", targetAt: "2027-01-30" });

  assert.equal(result.summary, `Added project "Retrofit" for Pat Example, from "Seismic retrofit" (change ${result.changeId})`);
  assert.equal(result.contactId, contactId);
  const row = await projectRow(db, result.projectId);
  assert.match(row.id, /^pj_[a-z2-7]{12}$/);
  assert.equal(row.deal_id, dealId);
  assert.equal(row.contact_id, contactId);
  assert.equal(row.status_key, "active");
  assert.equal(row.start_at, "2026-12-01T08:00:00.000Z");
  assert.equal(row.target_at, "2027-01-30T08:00:00.000Z");
  assert.equal(row.archived, 0);
  assert.equal(row.untrusted_fields, "[]");
  assert.equal(JSON.stringify(await dealRow(db, dealId)), dealBefore, "the deal is untouched");

  const defaulted = await addProject(ctxFor(db), { deal: dealId });
  assert.equal((await projectRow(db, defaulted.projectId)).name, "Seismic retrofit");
});

test("addProject by hand takes a person, a status by label and notes; the name is required", async () => {
  const { db, contactId } = await setup();
  const result = await addProject(ctxFor(db), { contact: "Pat Example", name: " Pilot ", status: "on hold", notes: " First ring " });
  const row = await projectRow(db, result.projectId);
  assert.equal(row.name, "Pilot");
  assert.equal(row.deal_id, null);
  assert.equal(row.contact_id, contactId);
  assert.equal(row.status_key, "on_hold");
  assert.equal(row.notes, "First ring");
  assert.equal(result.summary, `Added project "Pilot" for Pat Example (change ${result.changeId})`);
  await assert.rejects(addProject(ctxFor(db), { contact: contactId }), /Name the project in a few words\./);
});

test("a project is refused for an archived person, by contact or by deal", async () => {
  const { db, dealId, contactId } = await setup();
  await db.prepare("UPDATE contacts SET archived = 1 WHERE id = ?").bind(contactId).run();
  const refusal = /Pat Example is archived, so no project can be added for them\./;
  await assert.rejects(addProject(ctxFor(db), { contact: contactId, name: "x" }), refusal);
  await assert.rejects(addProject(ctxFor(db), { deal: dealId, name: "x" }), refusal);
});

test("an outside deal title is never the default name", async () => {
  const { db, dealId } = await setup();
  await db.prepare(`UPDATE deals SET untrusted_fields = '["title"]' WHERE id = ?`).bind(dealId).run();
  await assert.rejects(addProject(ctxFor(db), { deal: dealId }), /Name the project in a few words \(the deal's title came from outside\)\./);
  const named = await addProject(ctxFor(db), { deal: dealId, name: "Retrofit" });
  assert.equal(named.summary, `Added project "Retrofit" for Pat Example, from deal ${dealId} (change ${named.changeId})`);
});

test("addProject refuses what the link rules forbid", async () => {
  const { db, dealId, contactId } = await setup();
  const other = await addDeal(ctxFor(db, "add_deal"), { name: "Sam Example", dealTitle: "Open one" });

  await assert.rejects(addProject(ctxFor(db), { name: "Nobody" }), /A project needs a person: give contact, or a won deal\./);
  await assert.rejects(addProject(ctxFor(db), { deal: other.dealId }), /A project comes from a won deal\. Mark "Open one" Won first, or leave the deal out\./);
  await assert.rejects(addProject(ctxFor(db), { deal: dealId, contact: other.contactId }), /belongs to Pat Example, not Sam Example/);
  await assert.rejects(addProject(ctxFor(db), { contact: contactId, moveOpenTasks: true, name: "x" }), /moveOpenTasks needs a deal/);
  await assert.rejects(addProject(ctxFor(db), { contact: contactId, name: "x", status: "paused" }), /no status "paused"\. Statuses: Active, On hold, Done/);
  await assert.rejects(addProject(ctxFor(db), { contact: contactId, name: "x".repeat(201) }), /200 characters/);
  await assert.rejects(addProject(ctxFor(db), { contact: contactId, name: "a\nb" }), /one line/);
  await assert.rejects(
    addProject(ctxFor(db), { contact: contactId, name: "x", startAt: "2026-12-10", targetAt: "2026-12-01" }),
    /target date is before the start date/,
  );
  await db.prepare("UPDATE deals SET archived = 1 WHERE id = ?").bind(dealId).run();
  await assert.rejects(addProject(ctxFor(db), { deal: dealId }), /is archived/);
});

test("moveOpenTasks moves open and snoozed tasks off the deal, leaves done ones, and undo puts them back", async () => {
  const { db, dealId, contactId } = await setup();
  const open = await addTask(ctxFor(db, "add_task"), { dealId, title: "Order steel", dueAt: "2026-12-02" });
  const snoozed = await addTask(ctxFor(db, "add_task"), { dealId, title: "Call engineer" });
  await snoozeTask(ctxFor(db, "snooze_task"), snoozed.taskId, "2026-12-05");
  const done = await addTask(ctxFor(db, "add_task"), { dealId, title: "Sign contract" });
  await db.prepare("UPDATE tasks SET done_at = ? WHERE id = ?").bind(NOW.toISOString(), done.taskId).run();
  const before = [await taskRow(db, open.taskId), await taskRow(db, snoozed.taskId), await taskRow(db, done.taskId)];
  const dealBefore = JSON.stringify(await dealRow(db, dealId));

  const result = await addProject(ctxFor(db), { deal: dealId, name: "Retrofit", moveOpenTasks: true });
  assert.equal(result.summary, `Added project "Retrofit" for Pat Example, from "Seismic retrofit" (moved 2 open tasks) (change ${result.changeId})`);
  for (const id of [open.taskId, snoozed.taskId]) {
    const row = await taskRow(db, id);
    assert.equal(row.project_id, result.projectId);
    assert.equal(row.deal_id, null);
    assert.equal(row.contact_id, contactId);
  }
  assert.equal((await taskRow(db, open.taskId)).due_at, before[0]?.due_at);
  assert.equal((await taskRow(db, snoozed.taskId)).snoozed_until, before[1]?.snoozed_until);
  assert.deepEqual(await taskRow(db, done.taskId), before[2]);
  assert.equal(JSON.stringify(await dealRow(db, dealId)), dealBefore);

  await undoChange(ctxFor(db, "undo_change"), result.changeId);
  for (const [id, was] of [[open.taskId, before[0]], [snoozed.taskId, before[1]]] as const) {
    const row = await taskRow(db, id);
    assert.equal(row.project_id, null);
    assert.equal(row.deal_id, dealId);
    assert.equal(row.contact_id, was?.contact_id);
    assert.equal(row.due_at, was?.due_at);
  }
  assert.equal(await db.prepare("SELECT id FROM projects WHERE id = ?").bind(result.projectId).first(), null);
});

test("updateProject changes the fields it is given and says what changed", async () => {
  const { db, dealId } = await setup();
  const { projectId } = await addProject(ctxFor(db), { deal: dealId, name: "Retrofit", startAt: "2026-12-01", targetAt: "2027-01-30" });
  const up = (patch: Parameters<typeof updateProject>[2]) => updateProject(ctxFor(db, "update_project"), projectId, patch);

  const status = await up({ status: "Done" });
  assert.equal(status.summary, `Updated project "Retrofit" (Pat Example): status Active -> Done (change ${status.changeId})`);
  const row = await projectRow(db, projectId);
  assert.equal(row.status_key, "done");
  assert.equal(row.version, 2);

  const many = await up({ name: "Retrofit B", targetAt: null, notes: "Hold the steel" });
  assert.match(many.summary, /^Updated project "Retrofit" \(Pat Example\): name "Retrofit B", target cleared, notes updated \(change/);
  const cleared = await projectRow(db, projectId);
  assert.equal(cleared.target_at, null);
  assert.equal(cleared.notes, "Hold the steel");
  assert.equal(cleared.start_at, "2026-12-01T08:00:00.000Z");

  await up({ notes: null });
  assert.equal((await projectRow(db, projectId)).notes, null);
});

test("updateProject refuses a patch that changes nothing or puts the target before the start", async () => {
  const { db, dealId } = await setup();
  const { projectId } = await addProject(ctxFor(db), { deal: dealId, name: "Retrofit", startAt: "2026-12-01" });
  const up = (patch: Parameters<typeof updateProject>[2]) => updateProject(ctxFor(db, "update_project"), projectId, patch);
  await assert.rejects(up({}), /Nothing to change/);
  await assert.rejects(up({ name: "Retrofit", status: "active" }), /Nothing to change/);
  await assert.rejects(up({ targetAt: "2026-11-01" }), /target date is before the start date/);
  await assert.rejects(up({ name: " " }), /Name the project/);
  await assert.rejects(up({ status: "paused" }), /Statuses: Active, On hold, Done/);
});

test("archive and bring back; an archived project is not found by name and links refuse it", async () => {
  const { db, dealId, contactId } = await setup();
  const { projectId } = await addProject(ctxFor(db), { deal: dealId, name: "Retrofit" });
  const up = (patch: Parameters<typeof updateProject>[2]) => updateProject(ctxFor(db, "update_project"), projectId, patch);

  const archived = await up({ archived: true });
  assert.match(archived.summary, /: archived \(change/);
  assert.equal((await projectRow(db, projectId)).archived, 1);
  await assert.rejects(findProject(db, "Retrofit"), /No project matches "Retrofit"\. Use list_projects/);
  assert.equal((await findProject(db, projectId)).id, projectId);
  await assert.rejects(projectLinks(db, projectId), /Project "Retrofit" is archived\. Bring it back first \(update_project archived false\)\./);

  const back = await up({ archived: false });
  assert.match(back.summary, /: brought back \(change/);
  const links = await projectLinks(db, "retrofit");
  assert.equal(links.project.id, projectId);
  assert.equal((links.contact satisfies ContactRow).id, contactId);
});

test("findProject names several matches with their ids", async () => {
  const { db, dealId } = await setup();
  const a = await addProject(ctxFor(db), { deal: dealId, name: "Retrofit" });
  const b = await addProject(ctxFor(db), { deal: dealId, name: "RETROFIT" });
  await assert.rejects(findProject(db, "retrofit"), (error: Error) => {
    assert.match(error.message, /matches more than one project/);
    assert.ok(error.message.includes(`"Retrofit" (${a.projectId})`) && error.message.includes(`"RETROFIT" (${b.projectId})`));
    return true;
  });
  await assert.rejects(findProject(db, " "), /Say which project/);
});

test("a Done or On hold project still takes records", async () => {
  const { db, dealId } = await setup();
  const { projectId } = await addProject(ctxFor(db), { deal: dealId, name: "Retrofit", status: "done" });
  assert.equal((await projectLinks(db, projectId)).project.status_key, "done");
});

test("checkOnProject refuses a deal beside a project and another person", async () => {
  const { db, dealId, contactId } = await setup();
  const { projectId } = await addProject(ctxFor(db), { deal: dealId, name: "Retrofit" });
  const other = await addDeal(ctxFor(db, "add_deal"), { name: "Sam Example", dealTitle: "Open one" });
  const { project, contact } = await projectLinks(db, projectId);
  const sam = await db.prepare("SELECT * FROM contacts WHERE id = ?").bind(other.contactId).first<ContactRow>();
  assert.ok(sam);

  assert.throws(() => checkOnProject(project, contact, { deal: true, contact: null }), /Give the project or the deal, not both\./);
  assert.throws(() => checkOnProject(project, contact, { deal: false, contact: sam }), /"Retrofit" belongs to Pat Example, not Sam Example\./);
  checkOnProject(project, contact, { deal: false, contact });
  checkOnProject(project, contact, { deal: false, contact: null });
  assert.equal(contact.id, contactId);
});
