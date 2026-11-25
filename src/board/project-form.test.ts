// New project and Edit project (decision 0055): the forms, their posts, and the 404s. A refused form is a 422 with the
// values kept; an edit sends only what the owner changed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { auditCount, auditOf, changeIdOf, devEnv, formFields, h1Count, load, post } from "../../tests/helpers/board.ts";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { ProjectRow, TaskRow } from "../db/db.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import { addTask } from "../services/tasks.ts";
import { boardRoutes } from "./routes.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const ctxFor = (db: SqliteD1, tool: string) => ({ db, now: NOW, actor: "owner" as const, tool });

async function projectDb(options: { on?: boolean } = {}): Promise<SqliteD1> {
  const db = await timeDb(NOW);
  if (options.on !== false) db.exec("UPDATE settings SET projects = 1");
  db.exec(`INSERT INTO projects (id, name, contact_id, status_key, start_at, target_at, notes, created_at, updated_at) VALUES
    ('pj_retro', 'Retrofit', 'ct_seed01', 'active', '2026-11-16T08:00:00.000Z', '2026-12-05T20:30:00.000Z', 'Permit pending.', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')`);
  return db;
}

const projects = async (db: SqliteD1) => (await db.prepare("SELECT * FROM projects ORDER BY created_at, id").all<ProjectRow>()).results;
const projectRow = async (db: SqliteD1, id: string) => (await db.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first<ProjectRow>()) ?? null;
const tasksOf = async (db: SqliteD1, deal: string) => (await db.prepare("SELECT * FROM tasks WHERE deal_id = ?").bind(deal).all<TaskRow>()).results;

test("the three project form pages are in boardRoutes", () => {
  for (const path of ["/contacts/ct_seed07/projects/new", "/deals/dl_seed07/projects/new", "/projects/pj_seed01/edit"]) {
    assert.ok(boardRoutes.includes(path), path);
  }
});

test("New project for a person: heading, fields and Active by default", async () => {
  const { res, body } = await load(devEnv(await projectDb()), "/contacts/ct_seed01/projects/new");
  assert.equal(res.status, 200);
  assert.equal(h1Count(body), 1);
  assert.match(body, /<h1>New project for Pat Example<\/h1>/);
  assert.match(body, /action="\/contacts\/ct_seed01\/projects"/);
  assert.match(body, /<input id="project-name" name="name" type="text" value=""[^>]*required/);
  assert.match(body, /<option value="active" selected>Active<\/option>/);
  assert.match(body, /name="start.date"/);
  assert.match(body, /name="target.time"/);
  assert.match(body, /<textarea id="project-notes" name="notes"/);
  assert.doesNotMatch(body, /move_tasks/);
});

test("the form pages are 404 for an unknown or archived person, and while projects are off", async () => {
  const db = await projectDb();
  db.exec("UPDATE contacts SET archived = 1 WHERE id = 'ct_seed02'");
  const env = devEnv(db);
  assert.equal((await load(env, "/contacts/ct_nope/projects/new")).res.status, 404);
  assert.equal((await load(env, "/contacts/ct_seed02/projects/new")).res.status, 404);
  const off = devEnv(await projectDb({ on: false }));
  for (const path of ["/contacts/ct_seed01/projects/new", "/deals/dl_seed07/projects/new", "/projects/pj_retro/edit"]) {
    assert.equal((await load(off, path)).res.status, 404, path);
  }
  assert.equal((await post(off, "/contacts/ct_seed01/projects", { name: "X" })).res.status, 404);
  assert.equal((await post(off, "/projects/pj_retro", { name: "X" })).res.status, 404);
});

test("adding from a person creates the project, reads dates in the owner's timezone, and 303s to its page", async () => {
  const db = await projectDb();
  const before = await auditCount(db);
  const { res, location } = await post(devEnv(db), "/contacts/ct_seed01/projects", {
    name: "Garden wall",
    status: "on_hold",
    "start.date": "2026-12-01",
    "target.date": "2026-12-20",
    "target.time": "14:30",
    notes: "Wait for the permit.",
  });
  assert.equal(res.status, 303);
  assert.match(location, /^\/projects\/pj_[a-z0-9]+\?change=chg_[a-z0-9]{12}$/);
  assert.equal(await auditCount(db), before + 1);
  const audit = await auditOf(db, changeIdOf(location));
  assert.equal(audit?.actor, "owner");
  assert.equal(audit?.tool, "add_project");
  const made = (await projects(db)).find((p) => p.name === "Garden wall");
  assert.equal(made?.contact_id, "ct_seed01");
  assert.equal(made?.status_key, "on_hold");
  assert.equal(made?.start_at, "2026-12-01T08:00:00.000Z");
  assert.equal(made?.target_at, "2026-12-20T22:30:00.000Z");
  assert.equal(made?.notes, "Wait for the permit.");
  assert.equal(made?.deal_id, null);
});

test("a refused add is a 422 with the values kept and the message in the error summary", async () => {
  const db = await projectDb();
  const before = await auditCount(db);
  const { res, body } = await post(devEnv(db), "/contacts/ct_seed01/projects", {
    name: "",
    status: "active",
    "start.date": "2026-12-20",
    "target.date": "2026-12-01",
    notes: "Keep this note.",
  });
  assert.equal(res.status, 422);
  assert.equal(h1Count(body), 1);
  assert.match(body, /class="error-summary"/);
  assert.match(body, /Name the project in a few words\./);
  assert.match(body, /Keep this note\./);
  assert.match(body, /name="start.date" type="date" value="2026-12-20"/);
  assert.equal(await auditCount(db), before);

  const early = await post(devEnv(db), "/contacts/ct_seed01/projects", { name: "Wall", "start.date": "2026-12-20", "target.date": "2026-12-01" });
  assert.equal(early.res.status, 422);
  assert.match(early.body, /class="error-summary"/);
  assert.match(early.body, /name="name" type="text" value="Wall"/);
  assert.equal(await auditCount(db), before);
});

test("New project from a won deal: the name is the deal's title, and no box without open tasks", async () => {
  const { res, body } = await load(devEnv(await projectDb()), "/deals/dl_seed07/projects/new");
  assert.equal(res.status, 200);
  assert.match(body, /<h1>New project from Salon booking site<\/h1>/);
  assert.match(body, /action="\/deals\/dl_seed07\/projects"/);
  assert.match(body, /name="name" type="text" value="Salon booking site"/);
  assert.doesNotMatch(body, /move_tasks/);
});

test("the move box is ticked and counts the open tasks, in the singular for one", async () => {
  const db = await projectDb();
  await addTask(ctxFor(db, "add_task"), { dealId: "dl_seed07", title: "Send the contract" });
  const one = (await load(devEnv(db), "/deals/dl_seed07/projects/new")).body;
  assert.match(one, /<input id="[^"]*" name="move_tasks" type="checkbox" value="yes" checked/);
  assert.match(one, /This deal has 1 open task\./);
  await addTask(ctxFor(db, "add_task"), { dealId: "dl_seed07", title: "Book the site visit" });
  const two = (await load(devEnv(db), "/deals/dl_seed07/projects/new")).body;
  assert.match(two, /This deal has 2 open tasks\./);
});

test("an outside deal title leaves the name empty with a hint, and the heading uses the id", async () => {
  const db = await projectDb();
  db.exec(`UPDATE deals SET untrusted_fields = '["title"]' WHERE id = 'dl_seed07'`);
  const { body } = await load(devEnv(db), "/deals/dl_seed07/projects/new");
  assert.match(body, /<h1>New project from deal dl_seed07<\/h1>/);
  assert.doesNotMatch(body, /Salon booking site/);
  assert.match(body, /name="name" type="text" value=""/);
  assert.match(body, /The deal(?:'|&#39;)s title came from outside\. Name the project in a few words\./);
});

test("a deal that is not won, or is archived, or is unknown, is a 404", async () => {
  const db = await projectDb();
  db.exec("UPDATE deals SET archived = 1 WHERE id = 'dl_seed07'");
  const env = devEnv(db);
  assert.equal((await load(env, "/deals/dl_seed01/projects/new")).res.status, 404);
  assert.equal((await load(env, "/deals/dl_seed07/projects/new")).res.status, 404);
  assert.equal((await load(env, "/deals/dl_nope/projects/new")).res.status, 404);
  assert.equal((await post(env, "/deals/dl_seed01/projects", { name: "X" })).res.status, 404);
});

test("adding from a deal moves its open tasks only when the box is ticked", async () => {
  const db = await projectDb();
  await addTask(ctxFor(db, "add_task"), { dealId: "dl_seed07", title: "Send the contract" });
  const env = devEnv(db);
  const start = (await tasksOf(db, "dl_seed07")).length;
  const plain = await post(env, "/deals/dl_seed07/projects", { name: "Salon site build" });
  assert.equal(plain.res.status, 303);
  const made = (await projects(db)).find((p) => p.name === "Salon site build");
  assert.equal(made?.deal_id, "dl_seed07");
  assert.equal((await auditOf(db, changeIdOf(plain.location)))?.tool, "add_project");
  assert.equal((await tasksOf(db, "dl_seed07")).length, start, "the task stays on the deal");

  const moved = await post(env, "/deals/dl_seed07/projects", { name: "Salon site build 2", move_tasks: "yes" });
  assert.equal(moved.res.status, 303);
  assert.equal((await tasksOf(db, "dl_seed07")).length, start - 1, "the open task moved to the project");
  const second = (await projects(db)).find((p) => p.name === "Salon site build 2");
  const onProject = (await db.prepare("SELECT * FROM tasks WHERE project_id = ?").bind(second?.id).all<TaskRow>()).results;
  assert.equal(onProject.length, 1);
});

test("a refused add from a deal keeps the ticked box and the name", async () => {
  const db = await projectDb();
  await addTask(ctxFor(db, "add_task"), { dealId: "dl_seed07", title: "Send the contract" });
  const { res, body } = await post(devEnv(db), "/deals/dl_seed07/projects", { name: "", move_tasks: "yes", notes: "Kept." });
  assert.equal(res.status, 422);
  assert.match(body, /name="move_tasks" type="checkbox" value="yes" checked/);
  assert.match(body, /Kept\./);
});

test("an outside deal title needs a name: the post is refused with the service's words", async () => {
  const db = await projectDb();
  db.exec(`UPDATE deals SET untrusted_fields = '["title"]' WHERE id = 'dl_seed07'`);
  const before = await auditCount(db);
  const { res } = await post(devEnv(db), "/deals/dl_seed07/projects", { name: "" });
  assert.equal(res.status, 422);
  assert.equal(await auditCount(db), before);
});

test("Edit project: prefilled in the owner's timezone, with a fingerprint on each field", async () => {
  const { res, body } = await load(devEnv(await projectDb()), "/projects/pj_retro/edit");
  assert.equal(res.status, 200);
  assert.match(body, /<h1>Edit project<\/h1>/);
  assert.match(body, /action="\/projects\/pj_retro"/);
  assert.match(body, /name="name" type="text" value="Retrofit"/);
  assert.match(body, /name="start.date" type="date" value="2026-11-16"/);
  assert.match(body, /name="target.date" type="date" value="2026-12-05"/);
  assert.match(body, /name="target.time" type="time" value="12:30"/);
  assert.match(body, /name="was.name"/);
  assert.match(body, /Permit pending\./);
});

test("an edit sends only the changed fields", async () => {
  const db = await projectDb();
  const env = devEnv(db);
  const path = "/projects/pj_retro";
  const page = await load(env, `${path}/edit`);
  const fields = formFields(page.body, path);
  fields.set("status", "on_hold");
  const { res, location } = await post(env, path, fields, { cookie: page.cookie, token: page.token });
  assert.equal(res.status, 303);
  assert.match(location, /^\/projects\/pj_retro\?change=chg_[a-z0-9]{12}$/);
  const audit = await auditOf(db, changeIdOf(location));
  assert.equal(audit?.tool, "update_project");
  assert.equal(audit?.actor, "owner");
  assert.match(audit?.summary ?? "", /status Active -> On hold/);
  assert.doesNotMatch(audit?.summary ?? "", /name|start|target|notes/);
  const row = await projectRow(db, "pj_retro");
  assert.equal(row?.status_key, "on_hold");
  assert.equal(row?.start_at, "2026-11-16T08:00:00.000Z");
  assert.equal(row?.target_at, "2026-12-05T20:30:00.000Z");
  assert.equal(row?.notes, "Permit pending.");
});

test("an edit can clear a date and change the notes, and nothing changed is refused", async () => {
  const db = await projectDb();
  const env = devEnv(db);
  const path = "/projects/pj_retro";
  const page = await load(env, `${path}/edit`);
  const before = await auditCount(db);
  const same = await post(env, path, formFields(page.body, path), { cookie: page.cookie, token: page.token });
  assert.equal(same.res.status, 422);
  assert.match(same.body, /Nothing to save/);
  assert.equal(await auditCount(db), before);

  const fields = formFields(page.body, path);
  fields.set("target.date", "");
  fields.set("target.time", "");
  fields.set("notes", "Permit approved.");
  const saved = await post(env, path, fields, { cookie: page.cookie, token: page.token });
  assert.equal(saved.res.status, 303);
  const row = await projectRow(db, "pj_retro");
  assert.equal(row?.target_at, null);
  assert.equal(row?.notes, "Permit approved.");
  assert.equal(row?.name, "Retrofit");
});

test("a refused edit is a 422 with the posted values kept, and an archived project can be edited", async () => {
  const db = await projectDb();
  const env = devEnv(db);
  const path = "/projects/pj_retro";
  const page = await load(env, `${path}/edit`);
  const fields = formFields(page.body, path);
  fields.set("name", "");
  fields.set("notes", "New words.");
  const bad = await post(env, path, fields, { cookie: page.cookie, token: page.token });
  assert.equal(bad.res.status, 422);
  assert.match(bad.body, /class="error-summary"/);
  assert.match(bad.body, /New words\./);

  db.exec("UPDATE projects SET archived = 1 WHERE id = 'pj_retro'");
  const archived = await load(env, `${path}/edit`);
  assert.equal(archived.res.status, 200);
  const next = formFields(archived.body, path);
  next.set("name", "Retrofit phase two");
  const saved = await post(env, path, next, { cookie: archived.cookie, token: archived.token });
  assert.equal(saved.res.status, 303);
  assert.equal((await projectRow(db, "pj_retro"))?.name, "Retrofit phase two");
  assert.equal((await load(env, "/projects/pj_nope/edit")).res.status, 404);
});
