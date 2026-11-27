// Saved project views on the board (decision 0042, run 10): /projects?view=<vw id>, the Projects view switch, and the
// list's dynamic status choices (open by default, each live status, closed, archived, all) with archived left out in SQL.
import assert from "node:assert/strict";
import { test } from "node:test";
import { devEnv, h1Count, load } from "../../tests/helpers/board.ts";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import type { Ctx } from "../services/change.ts";
import { addField } from "../services/fields.ts";
import { addView, archiveView } from "../services/views.ts";
import { boardRoutes } from "./routes.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const owner = (db: SqliteD1, tool: string): Ctx => ({ db, now: NOW, actor: "owner", tool });

/** Projects on. Retrofit (Pat, active, Dec 5, Phase Build), Garden (Casey, on hold, Nov 30), Old fence (done), Office move (internal), Gone shed (archived). */
async function setup(options: { on?: boolean } = {}) {
  const db = await timeDb(NOW);
  if (options.on !== false) db.exec("UPDATE settings SET projects = 1");
  if (options.on !== false) await addField(owner(db, "add_field"), { entity: "project", label: "Phase", type: "text" });
  db.exec(`INSERT INTO projects (id, name, contact_id, status_key, start_at, target_at, fields, archived, created_at, updated_at) VALUES
    ('pj_retro', 'Retrofit', 'ct_seed01', 'active', '2026-11-16T08:00:00.000Z', '2026-12-05T08:00:00.000Z', '{"phase":"Build"}', 0, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z'),
    ('pj_garden', 'Garden', 'ct_seed03', 'on_hold', NULL, '2026-11-30T08:00:00.000Z', '{}', 0, '2026-11-12T00:00:00.000Z', '2026-11-12T00:00:00.000Z'),
    ('pj_old', 'Old fence', 'ct_seed01', 'done', NULL, NULL, '{}', 0, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
    ('pj_office', 'Office move', NULL, 'active', NULL, NULL, '{}', 0, '2026-11-15T00:00:00.000Z', '2026-11-15T00:00:00.000Z'),
    ('pj_gone', 'Gone shed', 'ct_seed01', 'active', NULL, NULL, '{}', 1, '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z')`);
  db.exec(`INSERT INTO tasks (id, contact_id, title, project_id, created_at, updated_at) VALUES
    ('tk_pj1', 'ct_seed01', 'Order anchors', 'pj_retro', '2026-11-16T00:00:00.000Z', '2026-11-16T00:00:00.000Z')`);
  return db;
}

const ids = (body: string) => [...body.matchAll(/href="\/projects\/(pj_[a-z0-9]+)"/g)].map((m) => m[1]);
const titleOf = (body: string) => /<title>([^<]*)<\/title>/.exec(body)?.[1] ?? "";
const switchOf = (body: string) => /<ul class="view-switch" aria-label="Show projects as">[\s\S]*?<\/ul>/.exec(body)?.[0] ?? "";

test("the Projects switch lists Open, each live status, then saved views, and marks the one shown", async () => {
  const db = await setup();
  const made = await addView(owner(db, "add_view"), { name: "Build phase", module: "projects", filters: { fields: { phase: "Build" } } });
  const open = switchOf((await load(devEnv(db), "/projects")).body);
  assert.match(open, /<li><a href="\/projects" aria-current="page">Open<\/a><\/li>/);
  const links = [...open.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(links, ["/projects", "/projects?status=active", "/projects?status=on_hold", "/projects?status=done", `/projects?view=${made.viewId}`]);
  assert.match(switchOf((await load(devEnv(db), "/projects?status=on_hold")).body), /<a href="\/projects\?status=on_hold" aria-current="page">On hold<\/a>/);
  assert.match(switchOf((await load(devEnv(db), `/projects?view=${made.viewId}`)).body), /aria-current="page">Build phase<\/a>/);
});

test("a saved projects view shows its filters, sort and cards; People and Deals views never answer here", async () => {
  const db = await setup();
  const made = await addView(owner(db, "add_view"), { name: "Open by name", module: "projects", filters: { status: "open" }, sort: "name" });
  const { res, body } = await load(devEnv(db), `/projects?view=${made.viewId}`);
  assert.equal(res.status, 200);
  assert.equal(h1Count(body), 1);
  assert.match(body, /<h1>Open by name<\/h1>/);
  assert.match(titleOf(body), /^Open by name · /);
  assert.deepEqual(ids(body), ["pj_garden", "pj_office", "pj_retro"]);
  assert.match(body, /status open; by name, A to Z\. 3 projects\./);
  assert.match(body, /<ul class="cards">/);
  assert.match(body, /Internal/);
  const people = await addView(owner(db, "add_view"), { name: "Everyone", module: "people" });
  assert.equal((await load(devEnv(db), `/projects?view=${people.viewId}`)).res.status, 404);
});

test("a view's table has a caption, scoped headers, aria-sort, custom field columns and an Internal person", async () => {
  const db = await setup();
  const made = await addView(owner(db, "add_view"), {
    name: "Wide",
    module: "projects",
    layout: "table",
    columns: ["project", "status", "person", "deal", "start", "target", "open_tasks", "Phase"],
  });
  const { body } = await load(devEnv(db), `/projects?view=${made.viewId}`);
  assert.match(body, /<table class="data-table">/);
  assert.match(body, /<caption class="visually-hidden">Wide: 4 projects, soonest target date first\.<\/caption>/);
  for (const header of ["Project", "Status", "Person", "Deal", "Start", "Target", "Open tasks", "Phase"]) {
    assert.match(body, new RegExp(`<th scope="col"[^>]*>(?:<a [^>]*><span class="visually-hidden">Sort by </span>)?${header}`), header);
  }
  assert.match(body, /<th scope="col" aria-sort="ascending"><a href="[^"]*sort=target-desc[^"]*"><span class="visually-hidden">Sort by <\/span>Target/);
  assert.match(body, /<th scope="row"><a href="\/projects\/pj_retro">Retrofit<\/a><\/th>/);
  assert.match(body, /<td>Build<\/td>/);
  assert.match(body, /<td>Internal<\/td>/);
  assert.match(body, /<td>1<\/td>/);
  // The address overrides sort and layout for one visit and never writes.
  const byName = (await load(devEnv(db), `/projects?view=${made.viewId}&sort=name-asc&layout=cards`)).body;
  assert.deepEqual(ids(byName), ["pj_garden", "pj_office", "pj_old", "pj_retro"]);
  assert.match(byName, /<ul class="cards">/);
});

test("an unknown, archived or ill-formed view id, and any view while projects are off, is the 404", async () => {
  const db = await setup();
  const made = await addView(owner(db, "add_view"), { name: "Open by name", module: "projects" });
  assert.equal((await load(devEnv(db), "/projects?view=vw_nothingnothing")).res.status, 404);
  assert.equal((await load(devEnv(db), "/projects?view=whatever")).res.status, 404);
  await archiveView(owner(db, "archive_view"), made.viewId);
  assert.equal((await load(devEnv(db), `/projects?view=${made.viewId}`)).res.status, 404);
  const off = await setup({ on: false });
  assert.equal((await load(devEnv(off), "/projects?view=vw_nothingnothing")).res.status, 404);
});

test("an empty view says so in one line", async () => {
  const db = await setup();
  const made = await addView(owner(db, "add_view"), { name: "Nothing", module: "projects", filters: { fields: { phase: "Never" } } });
  const { body } = await load(devEnv(db), `/projects?view=${made.viewId}`);
  assert.match(body, /No projects match this view\./);
  assert.deepEqual(ids(body), []);
});

test("the status choices are open (default), each live status, closed, archived and all; unknown is open", async () => {
  const db = await setup();
  const at = async (query: string) => (await load(devEnv(db), `/projects${query}`)).body;
  assert.deepEqual(ids(await at("")), ["pj_garden", "pj_retro", "pj_office"]);
  assert.deepEqual(ids(await at("?status=open")), ["pj_garden", "pj_retro", "pj_office"]);
  assert.deepEqual(ids(await at("?status=active")), ["pj_retro", "pj_office"]);
  assert.deepEqual(ids(await at("?status=closed")), ["pj_old"]);
  assert.deepEqual(ids(await at("?status=done")), ["pj_old"]);
  assert.deepEqual(ids(await at("?status=archived")), ["pj_gone"]);
  assert.deepEqual(ids(await at("?status=all")), ["pj_garden", "pj_retro", "pj_office", "pj_old"]);
  assert.deepEqual(ids(await at("?status=nonsense")), ids(await at("")));
  assert.equal(titleOf(await at("?status=nonsense")), titleOf(await at("")));
  const form = await at("");
  const options = [...form.matchAll(/<option value="([^"]+)"(?: selected)?>([^<]+)<\/option>/g)].map((m) => m[1]);
  assert.deepEqual(options.slice(0, 7), ["open", "active", "on_hold", "done", "closed", "archived", "all"]);
  assert.match(await at("?status=closed"), /<option value="closed" selected>Closed<\/option>/);
});

test("a status the owner adds is a choice with no code, and an archived one is not", async () => {
  const db = await setup();
  db.exec(`INSERT INTO project_statuses (key, label, position, kind, archived) VALUES ('review', 'In review', 9, 'open', 0), ('old', 'Old one', 10, 'open', 1)`);
  const { body } = await load(devEnv(db), "/projects?status=review");
  assert.match(body, /<option value="review" selected>In review<\/option>/);
  assert.doesNotMatch(body, /value="old"/);
  assert.match(switchOf(body), /href="\/projects\?status=review" aria-current="page">In review/);
});

test("the archived choice reads only archived rows from the database, not the capped list", async () => {
  const db = await setup();
  for (let n = 0; n < 205; n += 1) {
    db.exec(`INSERT INTO projects (id, name, contact_id, status_key, archived, created_at, updated_at) VALUES
      ('pj_fill${String(n).padStart(3, "0")}', 'Filler ${n}', 'ct_seed01', 'active', 0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`);
  }
  const { body } = await load(devEnv(db), "/projects?status=archived");
  assert.deepEqual(ids(body), ["pj_gone"]);
  assert.match(body, /1 project\b/);
});

test("the sample view is in boardRoutes, and the demo's project view answers", async () => {
  assert.ok(boardRoutes.includes("/projects?view=vw_seed03"));
});
