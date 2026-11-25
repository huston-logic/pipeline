// Shaped projects on the board (decision 0055, run 10): custom project fields on the page and forms, an internal project
// from /projects/new, an archived current status on the edit form, the Won flow and the two task boxes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { auditOf, changeIdOf, devEnv, formFields, h1Count, load, post } from "../../tests/helpers/board.ts";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { ProjectRow, TaskRow } from "../db/db.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import { addField } from "../services/fields.ts";
import { updateProject } from "../services/projects.ts";
import { addTask } from "../services/tasks.ts";
import { boardRoutes } from "./routes.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const ctxFor = (db: SqliteD1, tool: string) => ({ db, now: NOW, actor: "owner" as const, tool });

async function projectDb(options: { on?: boolean } = {}): Promise<SqliteD1> {
  const db = await timeDb(NOW);
  if (options.on !== false) db.exec("UPDATE settings SET projects = 1");
  db.exec(`INSERT INTO projects (id, name, contact_id, status_key, created_at, updated_at) VALUES
    ('pj_retro', 'Retrofit', 'ct_seed01', 'active', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')`);
  return db;
}

const projectRow = async (db: SqliteD1, id: string) => (await db.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first<ProjectRow>()) ?? null;
const tasksOf = async (db: SqliteD1, deal: string) => (await db.prepare("SELECT * FROM tasks WHERE deal_id = ?").bind(deal).all<TaskRow>()).results;

test("/projects/new is in boardRoutes", () => {
  assert.ok(boardRoutes.includes("/projects/new"));
});

test("the project page shows custom field values by label, and the forms draw and save only changed fields", async () => {
  const db = await projectDb();
  const field = await addField(ctxFor(db, "add_field"), { entity: "project", label: "Budget code", type: "text" });
  await addField(ctxFor(db, "add_field"), { entity: "project", label: "Site", type: "text" });
  await updateProject(ctxFor(db, "update_project"), "pj_retro", { fields: { [field.key]: "B-12" } });
  const env = devEnv(db);
  const shown = await load(env, "/projects/pj_retro");
  assert.match(shown.body, /Budget code/);
  assert.match(shown.body, /B-12/);
  const page = await load(env, "/projects/pj_retro/edit");
  assert.match(page.body, new RegExp(`name="df\\.${field.key}"[^>]*value="B-12"`));
  const fields = formFields(page.body, "/projects/pj_retro");
  fields.set("df.site", "North yard");
  const saved = await post(env, "/projects/pj_retro", fields, { cookie: page.cookie, token: page.token });
  assert.equal(saved.res.status, 303);
  const audit = await auditOf(db, changeIdOf(saved.location));
  assert.match(audit?.summary ?? "", /\(site\)/);
  assert.doesNotMatch(audit?.summary ?? "", /budget/);
  const row = await projectRow(db, "pj_retro");
  assert.deepEqual(JSON.parse(row?.fields ?? "{}"), { [field.key]: "B-12", site: "North yard" });
});

test("GET and POST /projects/new make an internal project, with fields and no person", async () => {
  const db = await projectDb();
  await addField(ctxFor(db, "add_field"), { entity: "project", label: "Site", type: "text" });
  const env = devEnv(db);
  const page = await load(env, "/projects/new");
  assert.equal(page.res.status, 200);
  assert.equal(h1Count(page.body), 1);
  assert.match(page.body, /action="\/projects\/new"/);
  assert.match(page.body, /name="df\.site"/);
  const { res, location } = await post(env, "/projects/new", { name: "Shop tidy", status: "active", "df.site": "Yard" });
  assert.equal(res.status, 303);
  assert.match(location, /^\/projects\/pj_[a-z0-9]+\?change=chg_/);
  const made = (await db.prepare("SELECT * FROM projects WHERE name = 'Shop tidy'").first<ProjectRow>()) ?? null;
  assert.equal(made?.contact_id, null);
  assert.equal(made?.deal_id, null);
  assert.deepEqual(JSON.parse(made?.fields ?? "{}"), { site: "Yard" });
  const audit = await auditOf(db, changeIdOf(location));
  assert.equal(audit?.tool, "add_project");
  assert.equal(audit?.actor, "owner");
  const refused = await post(env, "/projects/new", { name: "" });
  assert.equal(refused.res.status, 422);
  assert.match(refused.body, /Name the project in a few words\./);
});

test("/projects/new is a 404 while projects are off, and the projects list links to it", async () => {
  const off = devEnv(await projectDb({ on: false }));
  assert.equal((await load(off, "/projects/new")).res.status, 404);
  assert.equal((await post(off, "/projects/new", { name: "X" })).res.status, 404);
  const list = await load(devEnv(await projectDb()), "/projects");
  assert.match(list.body, /<a [^>]*href="\/projects\/new"[^>]*>Start a project<\/a>/);
});

test("the edit form shows the project's own archived status, marked, and other projects do not offer it", async () => {
  const db = await projectDb();
  db.exec("UPDATE project_statuses SET archived = 1 WHERE key = 'on_hold'");
  db.exec("UPDATE projects SET status_key = 'on_hold' WHERE id = 'pj_retro'");
  db.exec(`INSERT INTO projects (id, name, contact_id, status_key, created_at, updated_at) VALUES
    ('pj_other', 'Other', 'ct_seed01', 'active', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')`);
  const env = devEnv(db);
  const edit = await load(env, "/projects/pj_retro/edit");
  assert.match(edit.body, /<option value="on_hold" selected>On hold \(archived\)<\/option>/);
  const page = await load(env, "/projects/pj_retro");
  assert.match(page.body, /<option value="on_hold" selected>On hold \(archived\)<\/option>/);
  const other = await load(env, "/projects/pj_other/edit");
  assert.doesNotMatch(other.body, /value="on_hold"/);
  const fields = formFields(edit.body, "/projects/pj_retro");
  fields.set("notes", "Still waiting.");
  const saved = await post(env, "/projects/pj_retro", fields, { cookie: edit.cookie, token: edit.token });
  assert.equal(saved.res.status, 303);
});

test("a confirmed Won with projects on and no live project goes to Start a project, with the banner", async () => {
  const db = await projectDb();
  const env = devEnv(db);
  const { res, location } = await post(env, "/deals/dl_seed01/move", { stage: "won", confirm: "yes", return_to: "/pipeline" });
  assert.equal(res.status, 303);
  assert.match(location, /^\/deals\/dl_seed01\/projects\/new\?change=chg_[a-z0-9]{12}$/);
  const next = await load(env, location);
  assert.equal(next.res.status, 200);
  assert.match(next.body, /<div class="banner" role="status">/);
  assert.match(next.body, /action="\/changes\/chg_[a-z0-9]{12}\/undo"[^]*Undo/);
});

test("a confirmed Won keeps the usual redirect when projects are off or the deal has a live project", async () => {
  const off = await post(devEnv(await projectDb({ on: false })), "/deals/dl_seed01/move", { stage: "won", confirm: "yes", return_to: "/pipeline" });
  assert.match(off.location, /^\/pipeline\?change=/);
  const db = await projectDb();
  db.exec("UPDATE projects SET deal_id = 'dl_seed01' WHERE id = 'pj_retro'");
  const has = await post(devEnv(db), "/deals/dl_seed01/move", { stage: "won", confirm: "yes", return_to: "/pipeline" });
  assert.match(has.location, /^\/pipeline\?change=/);
});

test("Start a project from a deal: move box ticked, complete box not, both only with open tasks", async () => {
  const db = await projectDb();
  const env = devEnv(db);
  const none = await load(env, "/deals/dl_seed07/projects/new");
  assert.doesNotMatch(none.body, /name="move_tasks"|name="complete_tasks"/);
  await addTask(ctxFor(db, "add_task"), { dealId: "dl_seed07", title: "Order anchors" });
  const page = await load(env, "/deals/dl_seed07/projects/new");
  assert.match(page.body, /<input id="project-move-tasks" name="move_tasks" type="checkbox" value="yes" checked[ >]/);
  assert.match(page.body, /Move open tasks to the project/);
  assert.match(page.body, /<input id="project-complete-tasks" name="complete_tasks" type="checkbox" value="yes" aria-describedby/);
  assert.match(page.body, /Complete all open tasks/);
  assert.match(page.body, /<fieldset[^>]*>\s*<legend>This deal(?:'|&#39;)s open tasks<\/legend>[^]*project-complete-tasks[^]*<\/fieldset>/);
  assert.match(page.body, /aria-describedby="project-complete-tasks-hint"/);
  assert.match(page.body, /Marks them done and leaves them on the deal, instead of moving them\./);
});

test("the two boxes: move moves, complete completes and wins, and a refusal keeps both as posted", async () => {
  const db = await projectDb();
  await addTask(ctxFor(db, "add_task"), { dealId: "dl_seed07", title: "Order anchors" });
  const env = devEnv(db);
  const refused = await post(env, "/deals/dl_seed07/projects", { name: "", move_tasks: "yes", complete_tasks: "yes" });
  assert.equal(refused.res.status, 422);
  assert.match(refused.body, /name="move_tasks" type="checkbox" value="yes" checked/);
  assert.match(refused.body, /name="complete_tasks" type="checkbox" value="yes" checked/);
  const unticked = await post(env, "/deals/dl_seed07/projects", { name: "Plain", "status": "active" });
  assert.equal(unticked.res.status, 303);
  assert.equal((await tasksOf(db, "dl_seed07")).filter((t) => t.done_at === null).length, 1);
  const both = await post(env, "/deals/dl_seed07/projects", { name: "Both", move_tasks: "yes", complete_tasks: "yes" });
  assert.equal(both.res.status, 303);
  const rows = await tasksOf(db, "dl_seed07");
  assert.equal(rows.filter((t) => t.done_at === null).length, 0);
  assert.equal(rows.filter((t) => t.project_id != null).length, 0);
});
