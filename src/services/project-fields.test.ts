import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db, ProjectRow } from "../db/db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import { exportAll, exportTableCsv } from "../http/export.ts";
import type { Ctx } from "./change.ts";
import { addField, fieldOverview, updateField } from "./fields.ts";
import { getProject, listProjects } from "./project-read.ts";
import { addProject, updateProject } from "./projects.ts";
import { proposeChanges } from "./proposals.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const ctxFor = (db: Db, tool = "add_project"): Ctx => ({ db, now: NOW, actor: "owner", tool });

/** Projects on, with a number field Budget and a choice field Phase on projects. */
async function setup() {
  const db = await openTestDb();
  await db.prepare("UPDATE settings SET projects = 1").run();
  await addField(ctxFor(db, "add_field"), { entity: "project", label: "Budget", type: "number" });
  await addField(ctxFor(db, "add_field"), { entity: "project", label: "Phase", type: "choice", choices: ["Design", "Build"] });
  return db;
}

const stored = async (db: Db, id: string) => {
  const row = await db.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first<ProjectRow>();
  assert.ok(row);
  return JSON.parse(row.fields) as Record<string, unknown>;
};

test("a project field is refused while projects are off, and added, renamed and archived while on", async () => {
  const db = await openTestDb();
  await assert.rejects(addField(ctxFor(db, "add_field"), { entity: "project", label: "Budget", type: "number" }), /Projects are off/);
  await db.prepare("UPDATE settings SET projects = 1").run();
  const added = await addField(ctxFor(db, "add_field"), { entity: "project", label: "Budget", type: "number" });
  assert.match(added.summary, /^Added project field Budget \(key budget, number\)/);
  const renamed = await updateField(ctxFor(db, "update_field"), "budget", { label: "Budget ($)", entity: "project" });
  assert.match(renamed.summary, /^Updated project field Budget: renamed to Budget \(\$\)/);
  await updateField(ctxFor(db, "update_field"), added.fieldId, { archived: true });
  assert.deepEqual((await fieldOverview(db, { entity: "project", includeArchived: true })).map((f) => [f.key, f.archived]), [["budget", true]]);
  assert.deepEqual(await fieldOverview(db, { entity: "project" }), []);
  assert.deepEqual(await fieldOverview(db, { entity: "deal" }), []);
});

test("addProject stores field values checked like a deal's, and refuses a wrong type or an unknown key", async () => {
  const db = await setup();
  const result = await addProject(ctxFor(db), { name: "Office move", fields: { budget: 900, phase: "Design" } });
  assert.deepEqual(await stored(db, result.projectId), { budget: 900, phase: "Design" });
  await assert.rejects(addProject(ctxFor(db), { name: "A", fields: { budget: "lots" } }), /needs a number/);
  await assert.rejects(addProject(ctxFor(db), { name: "B", fields: { phase: "Ship" } }), /isn't one of the choices/);
  await assert.rejects(addProject(ctxFor(db), { name: "C", fields: { colour: "red" } }), /Unknown project field "colour"/);
  const none = await addProject(ctxFor(db), { name: "D", fields: { budget: null } });
  assert.deepEqual(await stored(db, none.projectId), {});
});

test("updateProject writes only the keys given, clears with null, and refuses a change that changes nothing", async () => {
  const db = await setup();
  const { projectId } = await addProject(ctxFor(db), { name: "Office move", fields: { budget: 900, phase: "Design" } });
  const result = await updateProject(ctxFor(db, "update_project"), projectId, { fields: { budget: 1200 } });
  assert.match(result.summary, /Updated project "Office move": .*[Bb]udget/);
  assert.deepEqual(await stored(db, projectId), { budget: 1200, phase: "Design" });
  await updateProject(ctxFor(db, "update_project"), projectId, { fields: { phase: null } });
  assert.deepEqual(await stored(db, projectId), { budget: 1200 });
  await assert.rejects(updateProject(ctxFor(db, "update_project"), projectId, { fields: { budget: 1200 } }), /Nothing to change/);
  await assert.rejects(updateProject(ctxFor(db, "update_project"), projectId, { fields: { budget: "x" } }), /needs a number/);
});

test("get_project and list_projects items carry the fields", async () => {
  const db = await setup();
  const { projectId } = await addProject(ctxFor(db), { name: "Office move", fields: { budget: 900 } });
  await addProject(ctxFor(db), { name: "Plain" });
  assert.deepEqual((await getProject(db, projectId, NOW)).fields, { budget: 900 });
  const list = await listProjects(db);
  assert.deepEqual(list.items.map((item) => [item.name, item.fields]).sort(), [["Office move", { budget: 900 }], ["Plain", {}]]);
});

test("the proposal list shows a project's field by its label, added and changed", async () => {
  const db = await setup();
  const { projectId } = await addProject(ctxFor(db), { name: "Office move", fields: { budget: 900 } });
  const deps = { extraOwnerEmails: [] };
  const ai: Ctx = { db, now: NOW, actor: "ai", tool: "propose_changes" };
  const added = await proposeChanges(ai, { actions: [{ action: "add_project", name: "Garage", fields: { budget: 50, phase: "Build" } }] }, deps);
  assert.equal(added.kind, "proposal");
  const addedText = added.kind === "proposal" ? added.text : "";
  assert.match(addedText, /Budget 50/);
  assert.match(addedText, /Phase/);
  const changed = await proposeChanges(ai, { actions: [{ action: "update_project", project: projectId, fields: { budget: 1000 } }] }, deps);
  assert.match(changed.kind === "proposal" ? changed.text : "", /Budget 900 -> 1000/);
});

test("the export carries the fields column in JSON and CSV", async () => {
  const db = await setup();
  await addProject(ctxFor(db), { name: "Office move", fields: { budget: 900 } });
  const projects = (await exportAll(db, NOW)).tables.projects;
  assert.equal(projects[0]?.fields, '{"budget":900}');
  const csv = await exportTableCsv(db, "projects");
  assert.match(csv.split("\r\n")[0] ?? "", /(^|,)fields(,|$)/);
  assert.match(csv, /"\{""budget"":900\}"/);
});
