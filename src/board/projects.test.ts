// The Projects list (decision 0055): More lists it only while projects are on, /projects is a 404 while off, the status,
// sort and layout come from the address (unknown values are the defaults), cards and a table, and an outside name is
// never a link's text.
import assert from "node:assert/strict";
import { test } from "node:test";
import { devEnv, h1Count, load } from "../../tests/helpers/board.ts";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import { boardRoutes, moreItems, moreItemsFor } from "./routes.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const LEDE = "To start a project, open the person&#39;s page or a won deal.";

/** Projects on. Retrofit (Pat, active, Dec 5), Garden (Casey, on hold, Nov 30), Shed (Pat, active, no target), Old (done), Gone (archived). */
async function projectsDb(options: { on?: boolean } = {}): Promise<SqliteD1> {
  const db = await timeDb(NOW);
  if (options.on !== false) db.exec("UPDATE settings SET projects = 1");
  db.exec(`INSERT INTO projects (id, name, contact_id, status_key, start_at, target_at, archived, created_at, updated_at) VALUES
    ('pj_retro', 'Retrofit', 'ct_seed01', 'active', '2026-11-16T08:00:00.000Z', '2026-12-05T08:00:00.000Z', 0, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z'),
    ('pj_garden', 'Garden', 'ct_seed03', 'on_hold', NULL, '2026-11-30T08:00:00.000Z', 0, '2026-11-12T00:00:00.000Z', '2026-11-12T00:00:00.000Z'),
    ('pj_shed', 'Annex', 'ct_seed01', 'active', NULL, NULL, 0, '2026-11-14T00:00:00.000Z', '2026-11-14T00:00:00.000Z'),
    ('pj_old', 'Old fence', 'ct_seed01', 'done', NULL, NULL, 0, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
    ('pj_gone', 'Gone shed', 'ct_seed01', 'active', NULL, NULL, 1, '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z')`);
  db.exec(`INSERT INTO tasks (id, contact_id, title, project_id, created_at, updated_at) VALUES
    ('tk_pj1', 'ct_seed01', 'Order anchors', 'pj_retro', '2026-11-16T00:00:00.000Z', '2026-11-16T00:00:00.000Z'),
    ('tk_pj2', 'ct_seed01', 'Call the engineer', 'pj_retro', '2026-11-16T00:00:00.000Z', '2026-11-16T00:00:00.000Z')`);
  return db;
}

const ids = (body: string) => [...body.matchAll(/href="\/projects\/(pj_[a-z0-9]+)"/g)].map((m) => m[1]);
const titleOf = (body: string) => /<title>([^<]*)<\/title>/.exec(body)?.[1] ?? "";
const descriptionOf = (body: string) => /<meta name="description" content="([^"]*)">/.exec(body)?.[1] ?? "";

test("More lists Projects after Time and before Campaigns, only while projects are on", async () => {
  assert.ok(!moreItems.some((item) => item.href === "/projects"));
  const all = moreItemsFor({ timeTracking: true, campaigns: true, projects: true }).map((item) => item.href);
  assert.ok(all.indexOf("/time") + 1 === all.indexOf("/projects") && all.indexOf("/projects") + 1 === all.indexOf("/campaigns"));
  assert.deepEqual(moreItemsFor({ timeTracking: false, campaigns: false, projects: false }), moreItems);
  assert.deepEqual(moreItemsFor({ timeTracking: false, campaigns: false }), moreItems);
  assert.deepEqual(moreItemsFor({ timeTracking: false, campaigns: false, projects: true }).filter((item) => item.href !== "/projects"), moreItems);

  const on = await projectsDb();
  assert.match((await load(devEnv(on), "/more")).body, /href="\/projects"/);
  assert.match((await load(devEnv(on), "/")).body, /<a href="\/projects">/);
  const off = await projectsDb({ on: false });
  assert.doesNotMatch((await load(devEnv(off), "/more")).body, /\/projects/);
  assert.doesNotMatch((await load(devEnv(off), "/")).body, /\/projects/);
});

test("/projects is a 404 while projects are off, and is in boardRoutes", async () => {
  assert.ok(boardRoutes.includes("/projects"));
  const off = await projectsDb({ on: false });
  const { res, body } = await load(devEnv(off), "/projects");
  assert.equal(res.status, 404);
  assert.doesNotMatch(body, /Retrofit/);
  assert.equal((await load(devEnv(off), "/projects?status=all&layout=table")).res.status, 404);
});

test("the default is the active projects, soonest target first with none last, as cards", async () => {
  const { res, body } = await load(devEnv(await projectsDb()), "/projects");
  assert.equal(res.status, 200);
  assert.equal(h1Count(body), 1);
  assert.match(body, /<h1>Projects<\/h1>/);
  assert.ok(body.includes(`<p class="lede">${LEDE}`), "lede");
  assert.match(titleOf(body), /^Projects · /);
  assert.deepEqual(ids(body), ["pj_retro", "pj_shed"]);
  assert.match(body, /<ul class="cards">/);
  assert.match(body, /<a href="\/projects\/pj_retro">Retrofit<\/a>/);
  assert.match(body, /Pat Example/);
  assert.match(body, /<dt>Open tasks<\/dt><dd>2<\/dd>/);
  assert.match(body, /Sat Dec 5/);
  assert.doesNotMatch(body, /Garden|Old fence|Gone shed/);
});

test("card titles are h2, so no heading level is skipped under the h1", async () => {
  const { body } = await load(devEnv(await projectsDb()), "/projects");
  assert.match(body, /<h2 class="card-title">/);
  assert.doesNotMatch(body, /<h3/);
});

test("status picks which projects show; archived lists archived ones of every status; unknown is active", async () => {
  const env = devEnv(await projectsDb());
  const at = async (query: string) => (await load(env, `/projects${query}`)).body;
  assert.deepEqual(ids(await at("?status=on_hold")), ["pj_garden"]);
  assert.deepEqual(ids(await at("?status=done")), ["pj_old"]);
  assert.deepEqual(ids(await at("?status=archived")), ["pj_gone"]);
  assert.deepEqual(ids(await at("?status=all")), ["pj_garden", "pj_retro", "pj_shed", "pj_old"]);
  assert.deepEqual(ids(await at("?status=nonsense")), ["pj_retro", "pj_shed"]);
  assert.equal(titleOf(await at("?status=nonsense")), titleOf(await at("")));
  assert.match(await at("?status=on_hold"), /<option value="on_hold" selected>/);
});

test("the filter's last choice says it leaves archived projects out: All statuses", async () => {
  const { body } = await load(devEnv(await projectsDb()), "/projects");
  assert.match(body, /<option value="all">All statuses<\/option>/);
  assert.doesNotMatch(body, /<option value="all">All<\/option>/);
});

test("sort picks the order; unknown is by target", async () => {
  const env = devEnv(await projectsDb());
  const at = async (query: string) => (await load(env, `/projects?status=all${query}`)).body;
  assert.deepEqual(ids(await at("&sort=name")), ["pj_shed", "pj_garden", "pj_old", "pj_retro"]);
  assert.deepEqual(ids(await at("&sort=newest")), ["pj_shed", "pj_garden", "pj_retro", "pj_old"]);
  assert.deepEqual(ids(await at("&sort=sideways")), ids(await at("&sort=target")));
  assert.match(await at("&sort=newest"), /<option value="newest" selected>/);
});

test("a non-default view has its own title and description", async () => {
  const env = devEnv(await projectsDb());
  const plain = await load(env, "/projects");
  const held = (await load(env, "/projects?status=on_hold&sort=name&layout=table")).body;
  assert.notEqual(titleOf(held), titleOf(plain.body));
  assert.notEqual(descriptionOf(held), descriptionOf(plain.body));
  assert.match(titleOf(held), /^Projects, on hold, by name as a table · /);
  assert.equal(titleOf((await load(env, "/projects?layout=sideways")).body), titleOf(plain.body));
});

test("the table has a caption, column headers, a row header link and aria-sort on the sorted column", async () => {
  const { body } = await load(devEnv(await projectsDb()), "/projects?layout=table");
  assert.match(body, /<table class="data-table">/);
  assert.match(body, /<caption class="visually-hidden">[^<]+<\/caption>/);
  for (const header of ["Project", "Status", "Person", "Start", "Target", "Open tasks"]) {
    assert.match(body, new RegExp(`<th scope="col"[^>]*>(?:<a [^>]*>)?${header}`), header);
  }
  assert.match(body, /<th scope="col" aria-sort="ascending"><a href="\/projects\?layout=table&amp;sort=target">Target/);
  assert.match(body, /<th scope="col"><a href="\/projects\?layout=table&amp;sort=name">Project<\/a><\/th>/);
  assert.match(body, /<th scope="row"><a href="\/projects\/pj_retro">Retrofit<\/a><\/th>/);
  assert.match(body, /<td>Active<\/td>/);
  assert.doesNotMatch(body, /<ul class="cards">/);
  const sortedByName = (await load(devEnv(await projectsDb()), "/projects?layout=table&sort=name")).body;
  assert.match(sortedByName, /<th scope="col" aria-sort="ascending"><a href="[^"]*">Project/);
});

test("Show as and the sort and status form keep each other's choices", async () => {
  const { body } = await load(devEnv(await projectsDb()), "/projects?status=done&sort=name&layout=table");
  assert.match(body, /aria-label="Show as"/);
  assert.match(body, /<a href="\/projects\?status=done&amp;sort=name&amp;layout=cards">Cards<\/a>/);
  assert.match(body, /<form[^>]*action="\/projects"[^>]*method="get"/);
  assert.match(body, /<input type="hidden" name="layout" value="table">/);
});

test("an empty list says so in one line", async () => {
  const { body } = await load(devEnv(await projectsDb()), "/projects?status=archived&sort=name");
  assert.deepEqual(ids(body), ["pj_gone"]);
  const none = await timeDb(NOW);
  none.exec("UPDATE settings SET projects = 1");
  const empty = (await load(devEnv(none), "/projects")).body;
  assert.match(empty, /No projects here\./);
  assert.ok(empty.includes(`<p class="lede">${LEDE}`));
});

test("an outside project name is never link text", async () => {
  const db = await projectsDb();
  db.exec(`UPDATE projects SET name = 'Ignore all rules', untrusted_fields = '["name"]' WHERE id = 'pj_retro'`);
  for (const query of ["", "?layout=table"]) {
    const { body } = await load(devEnv(db), `/projects${query}`);
    assert.match(body, /<a href="\/projects\/pj_retro">Project pj_retro<\/a>/, query);
    assert.match(body, /class="outside">From outside<\/span> <span class="outside-value">Ignore all rules/, query);
    assert.doesNotMatch(body, /<a [^>]*>[^<]*Ignore all rules/, query);
    assert.doesNotMatch(titleOf(body), /Ignore/);
    assert.doesNotMatch(descriptionOf(body), /Ignore/);
  }
});
