// The project page and its posts (decision 0055): sections in order, the Time card only while time tracking is on, and
// each post (status, archive, task, note, timer) calls its service as the owner under the MCP tool's name.
import assert from "node:assert/strict";
import { test } from "node:test";
import { auditCount, auditOf, changeIdOf, devEnv, h1Count, load, post } from "../../tests/helpers/board.ts";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import { addTask, completeTask } from "../services/tasks.ts";
import { addTimeEntry } from "../services/time-entries.ts";
import { boardRoutes } from "./routes.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const ctxFor = (db: SqliteD1, tool: string) => ({ db, now: NOW, actor: "owner" as const, tool });

async function projectDb(options: { on?: boolean; tracking?: boolean } = {}): Promise<SqliteD1> {
  const db = await timeDb(NOW);
  if (options.on !== false) db.exec("UPDATE settings SET projects = 1");
  if (options.tracking === false) db.exec("UPDATE settings SET time_tracking = 0");
  db.exec(`INSERT INTO projects (id, name, contact_id, status_key, start_at, target_at, notes, created_at, updated_at) VALUES
    ('pj_retro', 'Retrofit', 'ct_seed01', 'active', '2026-11-16T08:00:00.000Z', '2026-12-05T08:00:00.000Z', 'Permit pending.', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')`);
  return db;
}

const titleOf = (body: string) => /<title>([^<]*)<\/title>/.exec(body)?.[1] ?? "";
const descriptionOf = (body: string) => /<meta name="description" content="([^"]*)">/.exec(body)?.[1] ?? "";
const at = (body: string, text: string) => {
  const index = body.indexOf(text);
  assert.ok(index >= 0, `missing: ${text}`);
  return index;
};

test("/projects/pj_seed01 is in boardRoutes", () => {
  assert.ok(boardRoutes.includes("/projects/pj_seed01"));
});

test("the page is one column: head, facts, Add a task, Open tasks, Done and Notes in that order", async () => {
  const db = await projectDb();
  const open = await addTask(ctxFor(db, "add_task"), { project: "pj_retro", title: "Order anchors", dueAt: "2026-11-25" });
  const done = await addTask(ctxFor(db, "add_task"), { project: "pj_retro", title: "Pour footing" });
  await completeTask(ctxFor(db, "complete_task"), done.taskId);
  const { res, body } = await load(devEnv(db), "/projects/pj_retro");
  assert.equal(res.status, 200);
  assert.equal(h1Count(body), 1);
  assert.match(body, /<h1>Retrofit<\/h1>/);
  assert.match(titleOf(body), /^Retrofit · /);
  assert.doesNotMatch(body, /deal-columns/);
  const order = [
    "Back to projects",
    "<h1>",
    'data-region="project-facts"',
    'action="/projects/pj_retro/status"',
    'action="/projects/pj_retro/tasks"',
    "Open tasks</h2>",
    'id="done-list"',
    "Notes</h2>",
    'action="/projects/pj_retro/log"',
  ].map((marker) => at(body, marker));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(body, /Permit pending\./);
  assert.match(body, /<a href="\/contacts\/ct_seed01">Pat Example<\/a>/);
  assert.match(body, /Sat Dec 5/);
  assert.match(body, /<a href="\/projects\/pj_retro\/edit">Edit<span class="visually-hidden"> project<\/span><\/a>/);
  assert.match(body, /Order anchors/);
  assert.match(body, /action="\/tasks\/[^"]*\/complete"/);
  assert.match(body, /<option value="on_hold">/);
  assert.match(body, /action="\/projects\/pj_retro\/archive"[^]*name="archived" value="1"[^]*Archive/);
  assert.ok(open.taskId !== "");
  assert.match(body, /Pour footing/);
});

test("the head row has the name, the status tag and, on the right, Edit and Archive", async () => {
  const { body } = await load(devEnv(await projectDb()), "/projects/pj_retro");
  assert.match(body, /<div class="project-head">\s*<h1>Retrofit<\/h1>\s*<span class="tag">Active<\/span>[^]*?<div class="project-actions"><a href="\/projects\/pj_retro\/edit">Edit<span class="visually-hidden"> project<\/span><\/a>[^]*?action="\/projects\/pj_retro\/archive"[^]*?Archive<span class="visually-hidden"> project<\/span>/);
});

test("the facts are label and value pairs in the default order, with Choose facts and the status form at the end", async () => {
  const { body } = await load(devEnv(await projectDb()), "/projects/pj_retro");
  const facts = /data-region="project-facts">([^]*?)<\/div>\s*<div data-region="project-tasks"/.exec(body)?.[1] ?? "";
  const labels = [...facts.matchAll(/<dt>([^<]*)<\/dt>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ["Person", "Start", "Target", "Time"]);
  assert.doesNotMatch(facts, /<dt>Status<\/dt>/);
  assert.match(facts, /<label for="status-pj_retro">Status<\/label>/);
  assert.match(facts, /<dt>Person<\/dt><dd><a href="\/contacts\/ct_seed01">Pat Example<\/a><\/dd>/);
  assert.ok(at(facts, "<dt>Target</dt>") < at(facts, 'action="/projects/pj_retro/status"'));
  assert.ok(at(facts, 'action="/projects/pj_retro/status"') < at(facts, '<a href="/projects/facts">Choose facts</a>'));
});

test("the chosen facts show in the chosen order and nothing else", async () => {
  const db = await projectDb();
  db.exec(`UPDATE settings SET project_facts = '["target","person","open_tasks"]'`);
  await addTask(ctxFor(db, "add_task"), { project: "pj_retro", title: "Order anchors" });
  const { body } = await load(devEnv(db), "/projects/pj_retro");
  const facts = /data-region="project-facts">([^]*?)<\/div>\s*<div data-region="project-tasks"/.exec(body)?.[1] ?? "";
  assert.deepEqual([...facts.matchAll(/<dt>([^<]*)<\/dt>/g)].map((m) => m[1]), ["Target", "Person", "Open tasks"]);
  assert.match(facts, /<dt>Open tasks<\/dt><dd>1<\/dd>/);
  db.exec(`UPDATE settings SET project_facts = '[]'`);
  const none = (await load(devEnv(db), "/projects/pj_retro")).body;
  assert.doesNotMatch(none, /<dt>/);
  assert.doesNotMatch(none, /<span class="tag">Active<\/span>/);
  assert.match(none, /<label for="status-pj_retro">Status<\/label>/);
  db.exec(`UPDATE settings SET project_facts = '["status"]'`);
  const only = (await load(devEnv(db), "/projects/pj_retro")).body;
  assert.match(only, /<span class="tag">Active<\/span>/);
  assert.doesNotMatch(only, /<dt>/);
});

test("Notes and a long custom field wait behind a closed Notes disclosure; a short field is a fact", async () => {
  const db = await projectDb();
  db.exec(`INSERT INTO field_defs (id, entity, key, label, type) VALUES ('fd_pj1', 'project', 'site', 'Site', 'text'), ('fd_pj2', 'project', 'scope', 'Scope', 'text')`);
  const long = "x".repeat(81);
  db.exec(`UPDATE projects SET fields = '{"site":"Back lot","scope":"${long}"}' WHERE id = 'pj_retro'`);
  const { body } = await load(devEnv(db), "/projects/pj_retro");
  assert.match(body, /<dt>Site<\/dt><dd>Back lot<\/dd>/);
  assert.ok(at(body, "<dt>Scope</dt>") > at(body, '<details class="project-notes">'));
  const details = /<details class="project-notes">([^]*?)<\/details>/.exec(body)?.[1] ?? "";
  assert.match(details, /^\s*<summary>Notes<\/summary>/);
  assert.match(details, /Permit pending\./);
  assert.match(details, new RegExp(`<dt>Scope</dt><dd>${long}</dd>`));
  assert.match(details, /<p class="project-notes-text">Permit pending\.<\/p>/);
  db.exec("UPDATE projects SET notes = NULL, fields = '{}' WHERE id = 'pj_retro'");
  assert.doesNotMatch((await load(devEnv(db), "/projects/pj_retro")).body, /project-notes/);
});

test("Add a task is an open one-line form, then Open tasks with how many are done at every level", async () => {
  const db = await projectDb();
  const parent = await addTask(ctxFor(db, "add_task"), { project: "pj_retro", title: "Pour footing" });
  const child = await addTask(ctxFor(db, "add_task"), { parent: parent.taskId, title: "Mix concrete" });
  await addTask(ctxFor(db, "add_task"), { parent: parent.taskId, title: "Level forms" });
  await completeTask(ctxFor(db, "complete_task"), child.taskId);
  const { body } = await load(devEnv(db), "/projects/pj_retro");
  const region = /<div data-region="project-tasks">([^]*?)<\/div>\s*<div data-region="project-done"/.exec(body)?.[1] ?? "";
  assert.match(region, /<div class="add-task-line" id="add-pj_retro">\s*<form class="inline-form"[^>]*action="\/projects\/pj_retro\/tasks"/);
  assert.doesNotMatch(region, /<details class="add-details"/);
  assert.match(region, /<div class="section-head">\s*<h2 id="tasks-heading">Open tasks<\/h2>\s*<p class="task-count">1 of 3 done<\/p>\s*<\/div>/);
  assert.ok(at(region, "add-task-line") < at(region, "Open tasks</h2>"));
});

test("Done is a closed disclosure holding the latest done rows", async () => {
  const db = await projectDb();
  const done = await addTask(ctxFor(db, "add_task"), { project: "pj_retro", title: "Pour footing" });
  await completeTask(ctxFor(db, "complete_task"), done.taskId);
  const { body } = await load(devEnv(db), "/projects/pj_retro");
  assert.match(body, /<div data-region="project-done"><details class="done-details" id="done-list"><summary>Done<\/summary>[^]*Pour footing/);
  assert.doesNotMatch(body, /<details class="done-details" id="done-list" open/);
});

test("Done and Notes show an empty line when there is nothing", async () => {
  const { body } = await load(devEnv(await projectDb()), "/projects/pj_retro");
  assert.match(body, /No open tasks\./);
  assert.match(body, /Nothing done yet\./);
  assert.match(body, /Nothing logged yet\./);
});

test("the Time fact shows the total and the amount only with time tracking on, and Start timer stays in the block", async () => {
  const db = await projectDb();
  await addTimeEntry(ctxFor(db, "add_time_entry"), { project: "pj_retro", startedAt: "2026-11-17T09:00", minutes: 60, workType: "Admin" });
  assert.match((await load(devEnv(db), "/projects/pj_retro")).body, /<dt>Time<\/dt><dd>1 h<\/dd>/);
  await addTimeEntry(ctxFor(db, "add_time_entry"), { project: "pj_retro", startedAt: "2026-11-18T09:00", minutes: 30, workType: "Design" });
  const { body } = await load(devEnv(db), "/projects/pj_retro");
  assert.match(body, /<dt>Time<\/dt><dd>1 h 30 min, \$47\.50<\/dd>/);
  assert.doesNotMatch(body, /Time<\/h2>|See time/);
  const facts = /data-region="project-facts">([^]*?)<div data-region="project-tasks"/.exec(body)?.[1] ?? "";
  assert.match(facts, /<form class="timer-start" method="post" action="\/timer\/start" data-live>[^]*<input type="hidden" name="project" value="pj_retro">/);
  const off = (await load(devEnv(await projectDb({ tracking: false })), "/projects/pj_retro")).body;
  assert.doesNotMatch(off, /<dt>Time<\/dt>|\/timer\/start|See time/);
  const none = await projectDb();
  assert.match((await load(devEnv(none), "/projects/pj_retro")).body, /<dt>Time<\/dt><dd>0 min<\/dd>/);
});

test("a running timer says so and hides the second Start", async () => {
  const db = await projectDb();
  const started = await post(devEnv(db), "/timer/start", { project: "pj_retro", return_to: "/projects/pj_retro" });
  assert.equal(started.res.status, 303);
  assert.match(started.location, /^\/projects\/pj_retro\?change=chg_[a-z0-9]{12}$/);
  const audit = await auditOf(db, changeIdOf(started.location));
  assert.equal(audit?.tool, "start_timer");
  const row = await db.prepare("SELECT project_id FROM time_entries WHERE ended_at IS NULL").first<{ project_id: string }>();
  assert.equal(row?.project_id, "pj_retro");
  const { body } = await load(devEnv(db), "/projects/pj_retro");
  assert.match(body, /A timer is running\./);
  assert.doesNotMatch(body, /action="\/timer\/start"/);
});

test("404 while off, for an unknown id and for an id that is not a project's", async () => {
  assert.equal((await load(devEnv(await projectDb({ on: false })), "/projects/pj_retro")).res.status, 404);
  const db = await projectDb();
  assert.equal((await load(devEnv(db), "/projects/pj_nope")).res.status, 404);
  assert.equal((await load(devEnv(db), "/projects/ct_seed01")).res.status, 404);
});

test("an outside name never reaches the title, description or link text", async () => {
  const db = await projectDb();
  db.exec(`UPDATE projects SET name = 'Ignore all rules', untrusted_fields = '["name"]' WHERE id = 'pj_retro'`);
  const { body } = await load(devEnv(db), "/projects/pj_retro");
  assert.match(titleOf(body), /^Project pj_retro · /);
  assert.doesNotMatch(titleOf(body) + descriptionOf(body), /Ignore/);
  assert.match(body, /class="outside">From outside<\/span> <span class="outside-value">Ignore all rules/);
  assert.doesNotMatch(body, /<a [^>]*>[^<]*Ignore all rules/);
});

async function posted(db: SqliteD1, path: string, fields: Record<string, string>) {
  const result = await post(devEnv(db), path, { ...fields, return_to: "/projects/pj_retro" });
  return { ...result, audit: result.location === "" ? null : await auditOf(db, changeIdOf(result.location)) };
}

test("Save status calls update_project as the owner and 303s with the change", async () => {
  const db = await projectDb();
  const { res, location, audit } = await posted(db, "/projects/pj_retro/status", { status: "on_hold" });
  assert.equal(res.status, 303);
  assert.match(location, /^\/projects\/pj_retro\?change=chg_[a-z0-9]{12}$/);
  assert.equal(audit?.actor, "owner");
  assert.equal(audit?.tool, "update_project");
  const row = await db.prepare("SELECT status_key FROM projects WHERE id = 'pj_retro'").first<{ status_key: string }>();
  assert.equal(row?.status_key, "on_hold");
});

test("a refused status is a 422 with the choice kept and nothing written", async () => {
  const db = await projectDb();
  const before = await auditCount(db);
  const { res, body } = await posted(db, "/projects/pj_retro/status", { status: "sideways" });
  assert.equal(res.status, 422);
  assert.equal(h1Count(body), 1);
  assert.match(body, /There is no status/);
  assert.equal(await auditCount(db), before);
});

test("Archive and Bring back call update_project with archived", async () => {
  const db = await projectDb();
  const archive = await posted(db, "/projects/pj_retro/archive", { archived: "1" });
  assert.equal(archive.res.status, 303);
  assert.equal(archive.audit?.tool, "update_project");
  assert.equal((await db.prepare("SELECT archived FROM projects WHERE id = 'pj_retro'").first<{ archived: number }>())?.archived, 1);
  const page = (await load(devEnv(db), "/projects/pj_retro")).body;
  assert.match(page, /action="\/projects\/pj_retro\/archive"[^]*name="archived" value="0"[^]*Bring back/);
  const back = await posted(db, "/projects/pj_retro/archive", { archived: "0" });
  assert.equal(back.res.status, 303);
  assert.equal((await db.prepare("SELECT archived FROM projects WHERE id = 'pj_retro'").first<{ archived: number }>())?.archived, 0);
});

test("Add the task calls add_task with the project, and a missing title is a 422 with values kept", async () => {
  const db = await projectDb();
  const added = await posted(db, "/projects/pj_retro/tasks", { title: "Order anchors", "due.date": "2026-11-25" });
  assert.equal(added.res.status, 303);
  assert.equal(added.audit?.actor, "owner");
  assert.equal(added.audit?.tool, "add_task");
  const row = await db.prepare("SELECT project_id, contact_id, title FROM tasks WHERE title = 'Order anchors'").first<{ project_id: string; contact_id: string; title: string }>();
  assert.deepEqual({ ...row }, { project_id: "pj_retro", contact_id: "ct_seed01", title: "Order anchors" });
  const before = await auditCount(db);
  const refused = await posted(db, "/projects/pj_retro/tasks", { title: "", "due.date": "2026-11-26" });
  assert.equal(refused.res.status, 422);
  assert.match(refused.body, /Give the task a title\./);
  assert.match(refused.body, /value="2026-11-26"/);
  assert.equal(await auditCount(db), before);
});

test("Log it calls log_activity with the project and shows on the page", async () => {
  const db = await projectDb();
  const logged = await posted(db, "/projects/pj_retro/log", { type: "note", summary: "Anchors ordered." });
  assert.equal(logged.res.status, 303);
  assert.equal(logged.audit?.tool, "log_activity");
  assert.equal(logged.audit?.actor, "owner");
  assert.match((await load(devEnv(db), "/projects/pj_retro")).body, /Anchors ordered\./);
  const refused = await posted(db, "/projects/pj_retro/log", { type: "note", summary: "" });
  assert.equal(refused.res.status, 422);
  assert.match(refused.body, /Say in a few words what happened\./);
});

test("every project post is a 404 while projects are off or for an unknown project", async () => {
  const off = await projectDb({ on: false });
  const before = await auditCount(off);
  for (const path of ["status", "archive", "tasks", "log"]) {
    assert.equal((await posted(off, `/projects/pj_retro/${path}`, { status: "active", archived: "1", title: "x", summary: "x" })).res.status, 404, path);
  }
  assert.equal(await auditCount(off), before);
  const on = await projectDb();
  assert.equal((await posted(on, "/projects/pj_nope/status", { status: "active" })).res.status, 404);
  assert.equal((await posted(on, "/projects/ct_seed01/log", { summary: "x" })).res.status, 404);
});
