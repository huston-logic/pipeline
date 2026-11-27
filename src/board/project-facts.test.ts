// /projects/facts (run 12, ruling 8): choose the facts the project page shows and their order. A page behind the projects
// switch, a form that saves through update_settings as the owner, and a small form that restores the default.
import assert from "node:assert/strict";
import { test } from "node:test";
import { countingDb } from "../../tests/helpers/counting-db.ts";
import { auditCount, auditOf, changeIdOf, devEnv, h1Count, load, post } from "../../tests/helpers/board.ts";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import { addTask } from "../services/tasks.ts";
import { boardRoutes } from "./routes.ts";
import { matchBoardPage } from "./router.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");

async function factsDb(options: { on?: boolean; tracking?: boolean } = {}): Promise<SqliteD1> {
  const db = await timeDb(NOW);
  if (options.on !== false) db.exec("UPDATE settings SET projects = 1");
  if (options.tracking === false) db.exec("UPDATE settings SET time_tracking = 0");
  db.exec(`INSERT INTO field_defs (id, entity, key, label, type) VALUES ('fd_pj1', 'project', 'site', 'Site', 'text')`);
  return db;
}

const storedFacts = async (db: SqliteD1) => (await db.prepare("SELECT project_facts FROM settings").first<{ project_facts: string | null }>())?.project_facts;

test("/projects/facts is in boardRoutes", () => {
  assert.ok(boardRoutes.includes("/projects/facts"));
});

test("the page lists every fact with a Show box and a Position, in the current order", async () => {
  const { res, body } = await load(devEnv(await factsDb()), "/projects/facts");
  assert.equal(res.status, 200);
  assert.equal(h1Count(body), 1);
  assert.match(body, /<h1>Choose project facts<\/h1>/);
  assert.match(body, /Pick what the project page shows at the top, and in what order\./);
  assert.match(body, /<title>Choose project facts · /);
  const labels = [...body.matchAll(/<th scope="row">([^<]*)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ["Status", "Person", "Deal", "Start", "Target", "Time", "Site", "Open tasks"]);
  assert.match(body, /<input type="checkbox" id="show-status" name="show\.status" value="yes" checked>/);
  assert.match(body, /<input type="checkbox" id="show-open_tasks" name="show\.open_tasks" value="yes">/);
  assert.match(body, /<input type="number" id="pos-status" name="pos\.status" min="1" max="20" value="1"/);
  assert.match(body, /<input type="checkbox" id="show-fields\.site" name="show\.fields\.site" value="yes" checked>/);
  assert.match(body, /<label for="show-status">Show<span class="visually-hidden"> Status<\/span><\/label>/);
  assert.match(body, /<label for="pos-status">Position<span class="visually-hidden"> of Status<\/span><\/label>/);
  assert.match(body, /<button class="button" type="submit">Save<\/button>/);
  assert.match(body, /<a href="\/projects">Cancel<\/a>/);
  assert.match(body, /action="\/projects\/facts"[^]*name="default" value="1"[^]*Use the default/);
});

test("a chosen list shows first in its order, then the rest unticked", async () => {
  const db = await factsDb();
  db.exec(`UPDATE settings SET project_facts = '["target","status"]'`);
  const { body } = await load(devEnv(db), "/projects/facts");
  const labels = [...body.matchAll(/<th scope="row">([^<]*)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(labels.slice(0, 2), ["Target", "Status"]);
  assert.match(body, /id="show-target" name="show\.target" value="yes" checked/);
  assert.match(body, /id="pos-target" name="pos\.target" min="1" max="20" value="1"/);
  assert.match(body, /id="show-person" name="show\.person" value="yes">/);
});

test("Time is listed only while time tracking is on, and the page is a 404 while projects are off", async () => {
  const off = (await load(devEnv(await factsDb({ tracking: false })), "/projects/facts")).body;
  assert.doesNotMatch(off, /<th scope="row">Time<\/th>/);
  assert.equal((await load(devEnv(await factsDb({ on: false })), "/projects/facts")).res.status, 404);
});

test("Save writes the ticked facts in position order through update_settings as the owner", async () => {
  const db = await factsDb();
  const { res, location } = await post(devEnv(db), "/projects/facts", {
    "show.status": "yes",
    "pos.status": "3",
    "show.target": "yes",
    "pos.target": "1",
    "show.fields.site": "yes",
    "pos.fields.site": "2",
    "pos.person": "4",
    return_to: "/projects/facts",
  });
  assert.equal(res.status, 303);
  assert.match(location, /^\/projects\/facts\?change=chg_[a-z0-9]{12}$/);
  assert.equal(await storedFacts(db), '["target","fields.site","status"]');
  const audit = await auditOf(db, changeIdOf(location));
  assert.deepEqual([audit?.actor, audit?.tool], ["owner", "update_settings"]);
  assert.match(audit?.summary ?? "", /project facts to target, fields\.site, status/);
});

test("Save with nothing ticked stores an empty list, and an unchanged list writes nothing", async () => {
  const db = await factsDb();
  const first = await post(devEnv(db), "/projects/facts", { return_to: "/projects/facts" });
  assert.equal(first.res.status, 303);
  assert.equal(await storedFacts(db), "[]");
  const before = await auditCount(db);
  const again = await post(devEnv(db), "/projects/facts", { return_to: "/projects/facts" });
  assert.equal(again.res.status, 303);
  assert.equal(again.location, "/projects/facts");
  assert.equal(await auditCount(db), before);
});

test("a position that is not a whole number from 1 to 20 is a 422 and nothing is written", async () => {
  const db = await factsDb();
  const before = await auditCount(db);
  for (const bad of ["0", "21", "two", "1.5"]) {
    const { res, body } = await post(devEnv(db), "/projects/facts", { "show.status": "yes", "pos.status": bad, return_to: "/projects/facts" });
    assert.equal(res.status, 422, bad);
    assert.match(body, /Position must be a whole number from 1 to 20\./);
  }
  assert.equal(await auditCount(db), before);
  assert.equal(await storedFacts(db), null);
});

test("Use the default clears the stored list", async () => {
  const db = await factsDb();
  db.exec(`UPDATE settings SET project_facts = '["target"]'`);
  const { res, location } = await post(devEnv(db), "/projects/facts", { default: "1", return_to: "/projects/facts" });
  assert.equal(res.status, 303);
  assert.match(location, /^\/projects\/facts\?change=chg_/);
  assert.equal(await storedFacts(db), null);
});

test("the post is a 404 while projects are off and writes nothing", async () => {
  const db = await factsDb({ on: false });
  const before = await auditCount(db);
  assert.equal((await post(devEnv(db), "/projects/facts", { "show.status": "yes" })).res.status, 404);
  assert.equal(await auditCount(db), before);
});

test("the whole project page render makes at most 20 D1 calls with 25 tasks, notes and facts", async (t) => {
  const raw = await factsDb();
  raw.exec(`INSERT INTO projects (id, name, contact_id, status_key, notes, fields, created_at, updated_at)
    VALUES ('pj_load', 'Load', 'ct_seed01', 'active', 'Some notes', '{"site":"Back lot"}', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')`);
  const ctx = { db: raw, now: NOW, actor: "owner" as const, tool: "add_task" };
  for (let i = 0; i < 25; i++) await addTask(ctx, { project: "pj_load", title: `Task ${i}` });
  const db = countingDb(raw);
  const page = matchBoardPage("/projects/pj_load");
  assert.ok(page);
  const { status, body } = await page({ db, now: NOW, url: new URL("http://localhost:4821/projects/pj_load"), csrf: "token", pushKey: null, emailLogAddress: null });
  assert.equal(status, 200);
  assert.match(body, /Task 24/);
  t.diagnostic(`${db.calls} D1 calls`);
  assert.ok(db.calls <= 20, `${db.calls} calls:\n${db.log.join("\n")}`);
});
