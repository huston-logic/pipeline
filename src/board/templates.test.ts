// The Templates pages (run 10, area 4): More lists Templates only while projects are on, every /templates path is a 404
// while off, the list and the archived list, New template, the template page (info form, task tree to three levels, row
// actions, Add a task, Duplicate, Archive), a task's edit page, work types only while time tracking is on, and that each
// post is one audited change under its tool's name with a 303 back (a refusal is a 422 that keeps the values).
import assert from "node:assert/strict";
import { test } from "node:test";
import { auditCount, auditOf, changeIdOf, devEnv, h1Count, load, post } from "../../tests/helpers/board.ts";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import { addTemplate, type TemplateTaskInput } from "../services/templates.ts";
import { boardRoutes, moreItemsFor } from "./routes.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const ctxFor = (db: SqliteD1) => ({ db, now: NOW, actor: "owner" as const, tool: "add_template" });

async function templatesDb(options: { on?: boolean; tracking?: boolean } = {}): Promise<SqliteD1> {
  const db = await timeDb(NOW);
  if (options.on !== false) db.exec("UPDATE settings SET projects = 1");
  if (options.tracking === false) db.exec("UPDATE settings SET time_tracking = 0");
  return db;
}

async function make(db: SqliteD1, name: string, tasks: TemplateTaskInput[] = []) {
  return addTemplate(ctxFor(db), { name, description: "First line.\nSecond line.", tasks });
}

const toolOf = async (db: SqliteD1, location: string) => (await auditOf(db, changeIdOf(location)))?.tool;
const count = (body: string, text: string) => body.split(text).length - 1;

test("More lists Templates after Projects only while projects are on, and the paths are in boardRoutes", async () => {
  const hrefs = moreItemsFor({ timeTracking: false, campaigns: false, projects: true }).map((item) => item.href);
  assert.equal(hrefs.indexOf("/templates"), hrefs.indexOf("/projects") + 1);
  assert.ok(!moreItemsFor({ timeTracking: false, campaigns: false, projects: false }).some((item) => item.href === "/templates"));
  for (const path of ["/templates", "/templates?show=archived", "/templates/new", "/templates/tp_seed01", "/templates/tp_seed01/tasks/tt_seed01/edit"]) {
    assert.ok(boardRoutes.includes(path), path);
  }
  assert.match((await load(devEnv(await templatesDb()), "/more")).body, /href="\/templates"/);
  assert.match((await load(devEnv(await templatesDb()), "/projects")).body, /href="\/templates"/);
});

test("every /templates path is a 404 while projects are off, and its posts too", async () => {
  const db = await templatesDb({ on: false });
  const env = devEnv(db);
  assert.doesNotMatch((await load(env, "/more")).body, /\/templates/);
  for (const path of ["/templates", "/templates?show=archived", "/templates/new", "/templates/tp_abc", "/templates/tp_abc/tasks/tt_abc/edit"]) {
    assert.equal((await load(env, path)).res.status, 404, path);
  }
  assert.equal((await post(env, "/templates", { name: "Nope" })).res.status, 404);
  assert.equal((await post(env, "/template-tasks/tt_abc/move", { dir: "up" })).res.status, 404);
  assert.equal(await auditCount(db), 0);
});

test("the list shows live templates with the first line and task count; Archived lists the archived ones", async () => {
  const db = await templatesDb();
  await make(db, "Website build", [{ title: "Kickoff" }, { title: "Launch" }]);
  const old = await make(db, "Old plan");
  db.exec(`UPDATE project_templates SET archived = 1 WHERE id = '${old.templateId}'`);
  const env = devEnv(db);
  const { res, body } = await load(env, "/templates");
  assert.equal(res.status, 200);
  assert.equal(h1Count(body), 1);
  assert.match(body, /Website build/);
  assert.match(body, /First line\./);
  assert.doesNotMatch(body, /Second line/);
  assert.match(body, /2 tasks/);
  assert.doesNotMatch(body, /Old plan/);
  assert.match(body, /href="\/templates\/new"/);
  assert.match(body, /href="\/templates\?show=archived"/);
  const archived = (await load(env, "/templates?show=archived")).body;
  assert.match(archived, /Old plan/);
  assert.doesNotMatch(archived, /Website build/);
});

test("New template adds one change, tool add_template, and answers 303 to the template", async () => {
  const db = await templatesDb();
  const env = devEnv(db);
  const form = await load(env, "/templates/new");
  assert.equal(form.res.status, 200);
  assert.match(form.body, /action="\/templates"/);
  const { res, location } = await post(env, "/templates", { name: "Logo design", description: "Three rounds." });
  assert.equal(res.status, 303);
  assert.match(location, /^\/templates\/tp_[a-z0-9]+\?change=chg_/);
  assert.equal(await toolOf(db, location), "add_template");
  assert.match((await load(env, location)).body, /Logo design/);
});

test("a refused New template is a 422 that keeps the values", async () => {
  const db = await templatesDb();
  await make(db, "Logo design");
  const env = devEnv(db);
  const clash = await post(env, "/templates", { name: "logo design", description: "Keep this text." });
  assert.equal(clash.res.status, 422);
  assert.match(clash.body, /There&#39;s already a template called/);
  assert.match(clash.body, /Keep this text\./);
  const blank = await post(env, "/templates", { name: "  ", description: "Kept too." });
  assert.equal(blank.res.status, 422);
  assert.match(blank.body, /Name the template in a few words\./);
  assert.match(blank.body, /Kept too\./);
});

test("the template page saves only the changed fields as update_template", async () => {
  const db = await templatesDb();
  const made = await make(db, "Website build");
  const env = devEnv(db);
  const { body, cookie, token } = await load(env, `/templates/${made.templateId}`);
  assert.match(body, /<h1>Website build<\/h1>/);
  assert.equal(h1Count(body), 1);
  const was = /name="was\.name" value="([^"]*)"/.exec(body)?.[1] ?? "";
  const wasDescription = /name="was\.description" value="([^"]*)"/.exec(body)?.[1] ?? "";
  assert.ok(was !== "" && wasDescription !== "");
  const saved = await post(env, `/templates/${made.templateId}`, { name: "Site build", "was.name": was, description: "First line.\nSecond line.", "was.description": wasDescription }, { cookie, token });
  assert.equal(saved.res.status, 303);
  assert.equal(await toolOf(db, saved.location), "update_template");
  const row = await db.prepare("SELECT name, description FROM project_templates WHERE id = ?").bind(made.templateId).first<{ name: string; description: string }>();
  assert.equal(row?.name, "Site build");
  assert.equal(row?.description, "First line.\nSecond line.");
  const fresh = await load(env, `/templates/${made.templateId}`, cookie);
  const freshWas = /name="was\.name" value="([^"]*)"/.exec(fresh.body)?.[1] ?? "";
  const nothing = await post(env, `/templates/${made.templateId}`, { name: "Site build", "was.name": freshWas }, { cookie, token });
  assert.equal(nothing.res.status, 422);
  assert.match(nothing.body, /Nothing to save/);
});

test("the tree shows Day N, nests to three levels, and notes the levels below", async () => {
  const db = await templatesDb();
  const made = await make(db, "Deep", [
    { title: "Top", dueDays: 0 },
    { title: "Middle", dueDays: 7, under: 1 },
    { title: "Third", under: 2 },
    { title: "Fourth", under: 3 },
    { title: "Fifth", under: 4 },
  ]);
  const { body } = await load(devEnv(db), `/templates/${made.templateId}`);
  assert.equal(count(body, '<ul class="task-tree">'), 3);
  assert.match(body, /Day 0/);
  assert.match(body, /Day 7/);
  assert.match(body, /Has 2 more levels below\. Your AI app can show them\./);
  assert.doesNotMatch(body, /Fourth|Fifth/);
  assert.match(body, /<summary>Change<span class="visually-hidden">: Top<\/span><\/summary>/);
});

test("Indent is hidden where there is no task above and where it would make a fourth level", async () => {
  const db = await templatesDb();
  const flat = await make(db, "Flat", [{ title: "A" }, { title: "B" }, { title: "B1", under: 2 }, { title: "B2", under: 2 }]);
  // A is first, B has a child (1 + 1 + 1 levels fits), B1 is first in B, B2 would be the third level.
  assert.equal(count((await load(devEnv(db), `/templates/${flat.templateId}`)).body, "Move under the task above"), 2);
  const deep = await make(db, "Deep", [{ title: "A" }, { title: "A1", under: 1 }, { title: "A1a", under: 2 }, { title: "A1b", under: 2 }]);
  assert.equal(count((await load(devEnv(db), `/templates/${deep.templateId}`)).body, "Move under the task above"), 0);
});

test("each row action is one audited change with a 303 back to the template", async () => {
  const db = await templatesDb();
  const made = await make(db, "Plan", [{ title: "One" }, { title: "Two" }, { title: "Three", under: 2 }]);
  const env = devEnv(db);
  const [, two, three] = made.taskIds as [string, string, string];
  const page = `/templates/${made.templateId}`;
  const run = async (path: string, fields: Record<string, string>, tool: string) => {
    const before = await auditCount(db);
    const { res, location } = await post(env, path, { ...fields, return_to: page });
    assert.equal(res.status, 303, path);
    assert.match(location, new RegExp(`^${page}\\?change=chg_`));
    assert.equal(await auditCount(db), before + 1);
    assert.equal(await toolOf(db, location), tool);
  };
  await run(`/template-tasks/${two}/move`, { dir: "up" }, "move_template_task");
  await run(`/template-tasks/${two}/move`, { dir: "down" }, "move_template_task");
  await run(`/template-tasks/${two}/move`, { dir: "in" }, "move_template_task");
  await run(`/template-tasks/${two}/move`, { dir: "out" }, "move_template_task");
  await run(`/template-tasks/${three}/archive`, {}, "archive_template_task");
  await run(`${page}/tasks`, { title: "Four", dueDays: "2" }, "add_template_task");
  await run(`${page}/archive`, { archived: "1" }, "update_template");
  await run(`${page}/archive`, { archived: "0" }, "update_template");
  const copy = await post(env, `${page}/duplicate`, { return_to: page });
  assert.equal(copy.res.status, 303);
  assert.match(copy.location, /^\/templates\/tp_[a-z0-9]+\?change=chg_/);
  assert.notEqual(copy.location.split("?")[0], page);
  assert.equal(await toolOf(db, copy.location), "duplicate_template");
});

test("Add a task puts the task under the chosen one; a refusal is a 422 that keeps the values", async () => {
  const db = await templatesDb();
  const made = await make(db, "Plan", [{ title: "One" }]);
  const env = devEnv(db);
  const page = `/templates/${made.templateId}`;
  const form = (await load(env, page)).body;
  assert.match(form, /<option value="tt_[a-z0-9]+">1\. One<\/option>/);
  const added = await post(env, `${page}/tasks`, { title: "Sub", under: made.taskIds[0] ?? "", return_to: page });
  assert.equal(added.res.status, 303);
  const row = await db.prepare("SELECT parent_id FROM template_tasks WHERE title = 'Sub'").first<{ parent_id: string }>();
  assert.equal(row?.parent_id, made.taskIds[0]);
  const refused = await post(env, `${page}/tasks`, { title: "Late", dueDays: "99999", return_to: page });
  assert.equal(refused.res.status, 422);
  assert.match(refused.body, /dueDays must be a whole number/);
  assert.match(refused.body, /value="Late"/);
  const blank = await post(env, `${page}/tasks`, { title: " ", return_to: page });
  assert.equal(blank.res.status, 422);
  assert.match(blank.body, /Say in a few words what to do\./);
});

test("the Under choices carry outline numbers, so equal titles differ; the controls say what Remove and Archive do", async () => {
  const db = await templatesDb();
  const made = await make(db, "Plan", [{ title: "Prep" }, { title: "Order", under: 1 }, { title: "Prep" }, { title: "Order", under: 3 }, { title: "Deep", under: 4 }]);
  const body = (await load(devEnv(db), `/templates/${made.templateId}`)).body;
  for (const label of ["1. Prep", "1.1. Order", "2. Prep", "2.1. Order"]) assert.ok(body.includes(`>${label}</option>`), label);
  assert.doesNotMatch(body, />2\.1\.1\. Deep<\/option>/);
  assert.match(body, /The new task goes under the one you choose\./);
  assert.match(body, /Removes this task and its sub-tasks from the template\. You can undo it on the next page\./);
  assert.match(body, /Removes this task from the template\./);
  assert.match(body, /Archived templates aren't offered when you start a project\. You can bring one back\./);
  assert.match((await load(devEnv(db), "/templates")).body, />Archived templates<\/a>/);
});

test("a parent from another template through Under is a 422 that keeps the values", async () => {
  const db = await templatesDb();
  const mine = await make(db, "Mine", [{ title: "One" }]);
  const other = await make(db, "Other", [{ title: "Theirs" }]);
  const page = `/templates/${mine.templateId}`;
  const { res, body } = await post(devEnv(db), `${page}/tasks`, { title: "Kept title", under: other.taskIds[0] ?? "", return_to: page });
  assert.equal(res.status, 422);
  assert.match(body, /value="Kept title"/);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM template_tasks WHERE title = 'Kept title'").first<{ n: number }>())?.n, 0);
});

test("a task's edit page saves only changed fields, and a refusal keeps the values", async () => {
  const db = await templatesDb();
  const made = await make(db, "Plan", [{ title: "One", dueDays: 4 }]);
  const env = devEnv(db);
  const taskId = made.taskIds[0] ?? "";
  const path = `/templates/${made.templateId}/tasks/${taskId}/edit`;
  const { res, body, cookie, token } = await load(env, path);
  assert.equal(res.status, 200);
  assert.equal(h1Count(body), 1);
  assert.match(body, /action="\/template-tasks\/tt_[a-z0-9]+"/);
  assert.equal((await load(env, `/templates/${made.templateId}/tasks/tt_nope/edit`)).res.status, 404);
  const was = /name="was\.title" value="([^"]*)"/.exec(body)?.[1] ?? "";
  const wasDays = /name="was\.dueDays" value="([^"]*)"/.exec(body)?.[1] ?? "";
  const refused = await post(env, `/template-tasks/${taskId}`, { title: "Renamed", "was.title": was, dueDays: "-2", "was.dueDays": wasDays }, { cookie, token });
  assert.equal(refused.res.status, 422);
  assert.match(refused.body, /value="Renamed"/);
  const ok = await post(env, `/template-tasks/${taskId}`, { title: "Renamed", "was.title": was }, { cookie, token });
  assert.equal(ok.res.status, 303);
  assert.equal(await toolOf(db, ok.location), "update_template_task");
  const row = await db.prepare("SELECT title, due_days FROM template_tasks WHERE id = ?").bind(taskId).first<{ title: string; due_days: number }>();
  assert.deepEqual({ ...row }, { title: "Renamed", due_days: 4 });
});

test("work types show only while time tracking is on", async () => {
  const on = await templatesDb();
  const made = await make(on, "Plan", [{ title: "Design it", workType: "Design" }]);
  const onPage = (await load(devEnv(on), `/templates/${made.templateId}`)).body;
  assert.match(onPage, /<p class="row-head">Design<\/p>/);
  assert.match(onPage, /Work type/);
  assert.match((await load(devEnv(on), `/templates/${made.templateId}/tasks/${made.taskIds[0] ?? ""}/edit`)).body, /Work type/);
  on.exec("UPDATE settings SET time_tracking = 0");
  const offPage = (await load(devEnv(on), `/templates/${made.templateId}`)).body;
  assert.doesNotMatch(offPage, /Work type/);
  assert.doesNotMatch(offPage, /<p class="row-head">[^<]*Design/);
  assert.doesNotMatch((await load(devEnv(on), `/templates/${made.templateId}/tasks/${made.taskIds[0] ?? ""}/edit`)).body, /Work type/);
});

test("an archived template shows no row controls and offers Bring back", async () => {
  const db = await templatesDb();
  const made = await make(db, "Old", [{ title: "One" }]);
  db.exec(`UPDATE project_templates SET archived = 1 WHERE id = '${made.templateId}'`);
  const body = (await load(devEnv(db), `/templates/${made.templateId}`)).body;
  assert.match(body, /Bring back/);
  assert.doesNotMatch(body, /task-more/);
  assert.doesNotMatch(body, /Duplicate/);
});
