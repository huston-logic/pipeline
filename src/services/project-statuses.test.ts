import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db } from "../db/db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import type { Ctx } from "./change.ts";
import { UserError } from "./errors.ts";
import { projectStatusRows, ReadMemo } from "./memo.ts";
import { addContact } from "./add-contact.ts";
import {
  addProjectStatus,
  archiveProjectStatus,
  defaultProjectStatus,
  isClosedStatus,
  projectStatusLabels,
  updateProjectStatus,
} from "./project-statuses.ts";
import { addProject, updateProject } from "./projects.ts";
import { getSettings, PROJECTS_OFF, requireProjects, updateSettings } from "./settings.ts";
import { undoChange } from "./undo.ts";

const NOW = new Date("2026-11-25T18:00:00.000Z");
const ctxFor = (db: Db): Ctx => ({ db, now: NOW, actor: "ai", tool: "update_project_status" });

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => assert.fail("expected a refusal"),
    (e: unknown) => e,
  );
  assert.ok(error instanceof UserError, `expected a UserError, got ${String(error)}`);
  return error.message;
}

async function projectsOn(db: Db): Promise<void> {
  await updateSettings({ ...ctxFor(db), tool: "update_settings" }, { projects: true });
}

test("the projects setting starts off; update_settings turns it on and off with a summary", async () => {
  const db = await openTestDb();
  assert.equal((await getSettings(db)).projects, false);
  assert.equal(await refusal(requireProjects(db)), PROJECTS_OFF);
  assert.equal(PROJECTS_OFF, "Projects are off. The owner can turn them on (update_settings projects true).");
  const on = await updateSettings(ctxFor(db), { projects: true });
  assert.equal(on.summary, `Updated settings: projects on (change ${on.changeId})`);
  assert.equal((await getSettings(db)).projects, true);
  await requireProjects(db);
  const off = await updateSettings(ctxFor(db), { projects: false });
  assert.match(off.summary, /^Updated settings: projects off \(change /);
  assert.equal((await getSettings(db)).projects, false);
});

test("projectStatusLabels maps key to label, from the database and from a memo", async () => {
  const db = await openTestDb();
  const expected = new Map([
    ["active", "Active"],
    ["on_hold", "On hold"],
    ["done", "Done"],
  ]);
  assert.deepEqual(await projectStatusLabels(db), expected);
  assert.deepEqual(await projectStatusLabels({ db, memo: new ReadMemo(db) }), expected);
});

test("a rename is one undoable change", async () => {
  const db = await openTestDb();
  await projectsOn(db);
  const result = await updateProjectStatus(ctxFor(db), "on_hold", { label: "  Paused " });
  assert.equal(result.summary, `Renamed project status "On hold" to "Paused" (change ${result.changeId})`);
  assert.equal((await projectStatusLabels(db)).get("on_hold"), "Paused");
  await undoChange(ctxFor(db), result.changeId);
  assert.equal((await projectStatusLabels(db)).get("on_hold"), "On hold");
});

test("an unknown key, an empty, long or duplicate label, a same label, and off all refuse plainly", async () => {
  const db = await openTestDb();
  const rename = (key: string, label: string) => updateProjectStatus(ctxFor(db), key, { label });
  assert.equal(await refusal(rename("on_hold", "Paused")), PROJECTS_OFF);
  await projectsOn(db);
  assert.equal(
    await refusal(rename("paused", "Paused")),
    'There\'s no project status "paused". Use one of: active (Active), on_hold (On hold), done (Done).',
  );
  assert.match(await refusal(rename("done", "   ")), /needs a label/);
  assert.match(await refusal(rename("done", "x".repeat(61))), /at most 60 characters/);
  assert.match(await refusal(rename("done", "ACTIVE")), /already a project status called Active \(active\)/);
  assert.match(await refusal(rename("done", "Done")), /Nothing to change/);
  assert.match(await refusal(updateProjectStatus(ctxFor(db), "done", {})), /Nothing to change/);
  // Changing only the capitals of its own label is a real rename.
  const result = await rename("done", "DONE");
  assert.match(result.summary, /^Renamed project status "Done" to "DONE"/);
});

const live = async (db: Db) => (await projectStatusRows(db)).map((s) => `${s.position}:${s.key}`);

async function personProject(db: Db, status: string): Promise<string> {
  const known = await db.prepare("SELECT id FROM contacts LIMIT 1").first<string>("id");
  const contact = known ?? (await addContact({ ...ctxFor(db), tool: "add_contact" }, { name: "Pat Example" })).contactId;
  const added = await addProject({ ...ctxFor(db), tool: "add_project" }, { contact, name: "Retrofit", status });
  return added.projectId;
}

test("addProjectStatus makes a slug key, defaults to open and last, and refuses a repeated label", async () => {
  const db = await openTestDb();
  assert.equal(await refusal(addProjectStatus(ctxFor(db), { label: "Waiting" })), PROJECTS_OFF);
  await projectsOn(db);
  const added = await addProjectStatus(ctxFor(db), { label: " Waiting on client " });
  assert.equal(added.key, "waiting_on_client");
  assert.match(added.summary, /^Added project status "Waiting on client" \(key waiting_on_client, open\)/);
  assert.deepEqual(await live(db), ["1:active", "2:on_hold", "3:done", "4:waiting_on_client"]);
  assert.equal(await isClosedStatus(db, "waiting_on_client"), false);
  const closed = await addProjectStatus(ctxFor(db), { label: "Cancelled", kind: "closed", position: 1 });
  assert.equal(await isClosedStatus(db, closed.key), true);
  assert.deepEqual(await live(db), ["1:cancelled", "2:active", "3:on_hold", "4:done", "5:waiting_on_client"]);
  assert.match(await refusal(addProjectStatus(ctxFor(db), { label: "ON HOLD" })), /already a project status called On hold \(on_hold\)/);
  assert.match(await refusal(addProjectStatus(ctxFor(db), { label: "Late", position: 9 })), /between 1 and 6/);
  await undoChange(ctxFor(db), closed.changeId);
  assert.deepEqual(await live(db), ["1:active", "2:on_hold", "3:done", "4:waiting_on_client"]);
});

test("a rename keeps the key; a move shifts the others; a kind change is one change", async () => {
  const db = await openTestDb();
  await projectsOn(db);
  const moved = await updateProjectStatus(ctxFor(db), "Done", { position: 1 });
  assert.match(moved.summary, /^Updated project status "Done": moved to position 1 of 3/);
  assert.deepEqual(await live(db), ["1:done", "2:active", "3:on_hold"]);
  await updateProjectStatus(ctxFor(db), "active", { label: "Underway" });
  assert.deepEqual(await live(db), ["1:done", "2:active", "3:on_hold"]);
  assert.equal((await projectStatusLabels(db)).get("active"), "Underway");
  await addProjectStatus(ctxFor(db), { label: "Shipped", kind: "closed" });
  const kind = await updateProjectStatus(ctxFor(db), "on_hold", { kind: "closed" });
  assert.match(kind.summary, /closed/);
  assert.equal(await isClosedStatus(db, "on_hold"), true);
  assert.match(await refusal(updateProjectStatus(ctxFor(db), "active", { position: 9 })), /between 1 and 4/);
});

test("the last live open or closed status can't be archived or changed to the other kind", async () => {
  const db = await openTestDb();
  await projectsOn(db);
  assert.match(await refusal(archiveProjectStatus(ctxFor(db), "done")), /last closed status/);
  assert.match(await refusal(updateProjectStatus(ctxFor(db), "done", { kind: "open" })), /last closed status/);
  await archiveProjectStatus(ctxFor(db), "on_hold");
  assert.match(await refusal(archiveProjectStatus(ctxFor(db), "active")), /last open status/);
  assert.match(await refusal(updateProjectStatus(ctxFor(db), "active", { kind: "closed" })), /last open status/);
});

test("archive refuses while an unarchived project has the status, with the count", async () => {
  const db = await openTestDb();
  await projectsOn(db);
  await addProjectStatus(ctxFor(db), { label: "Waiting" });
  const first = await personProject(db, "waiting");
  await personProject(db, "waiting");
  assert.match(await refusal(archiveProjectStatus(ctxFor(db), "waiting")), /2 projects have Waiting\. Move them first with update_project/);
  await updateProject({ ...ctxFor(db), tool: "update_project" }, first, { status: "active" });
  assert.match(await refusal(archiveProjectStatus(ctxFor(db), "waiting")), /1 project has Waiting\. Move it first/);
  await updateProject({ ...ctxFor(db), tool: "update_project" }, (await db.prepare("SELECT id FROM projects WHERE status_key = 'waiting'").first<string>("id")) ?? "", { archived: true });
  const result = await archiveProjectStatus(ctxFor(db), "Waiting");
  assert.equal(result.summary, `Archived project status Waiting (change ${result.changeId})`);
  assert.deepEqual(await live(db), ["1:active", "2:on_hold", "3:done"]);
  assert.match(await refusal(archiveProjectStatus(ctxFor(db), "waiting")), /already archived/);
  assert.equal((await projectStatusLabels(db)).get("waiting"), "Waiting");
  assert.match(await refusal(updateProjectStatus(ctxFor(db), "waiting", { label: "x" })), /archived/);
  assert.match(await refusal(addProjectStatus(ctxFor(db), { label: "waiting" })), /already a project status called Waiting/);
});

test("an archived status is never accepted on a project, and new projects take the first live open status", async () => {
  const db = await openTestDb();
  await projectsOn(db);
  assert.equal((await defaultProjectStatus(db)).key, "active");
  await addProjectStatus(ctxFor(db), { label: "Kickoff", position: 1 });
  assert.equal((await defaultProjectStatus(db)).key, "kickoff");
  const id = await personProject(db, "active");
  await archiveProjectStatus(ctxFor(db), "kickoff");
  assert.equal((await defaultProjectStatus(db)).key, "active");
  await addProjectStatus(ctxFor(db), { label: "Later" });
  await archiveProjectStatus(ctxFor(db), "later");
  assert.match(await refusal(updateProject({ ...ctxFor(db), tool: "update_project" }, id, { status: "later" })), /no status "later"/);
  const contact = (await db.prepare("SELECT id FROM contacts LIMIT 1").first<string>("id")) ?? "";
  const added = await addProject({ ...ctxFor(db), tool: "add_project" }, { contact, name: "Default one" });
  assert.equal((await db.prepare("SELECT status_key FROM projects WHERE id = ?").bind(added.projectId).first<string>("status_key")), "active");
  assert.match(await refusal(addProject({ ...ctxFor(db), tool: "add_project" }, { contact, name: "x", status: "kickoff" })), /no status "kickoff"/);
});
