// Saved project views (decision 0042, run 10): the projects module's filters, sorts and columns, the refusals while
// projects are off, and the rows a view reads (filters in SQL, a person optional).
import assert from "node:assert/strict";
import { test } from "node:test";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { Db, ViewRow } from "../db/db.ts";
import type { Ctx } from "./change.ts";
import { addField } from "./fields.ts";
import { addProject, updateProject } from "./projects.ts";
import { projectsInView } from "./view-read.ts";
import { addView, archiveView, listViews, switchItems, updateView } from "./views.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const ctxFor = (db: Db, tool = "add_view"): Ctx => ({ db, now: NOW, actor: "ai", tool });
const OFF = /Projects are off/;
const ids = (items: { id: string }[]) => items.map((item) => item.id);

/** Projects on. Retrofit (Pat, active, target Dec 5), Garden (Casey, on hold, target Nov 30), Shed (Pat, active), Fence (done), Office (internal). */
async function setup() {
  const db = await timeDb(NOW);
  await db.prepare("UPDATE settings SET projects = 1").run();
  const owner = { ...ctxFor(db, "add_project"), actor: "owner" as const };
  await addField(owner, { entity: "project", label: "Phase", type: "choice", choices: ["Design", "Build"] });
  const retrofit = await addProject(owner, { contact: "ct_seed01", name: "Retrofit", targetAt: "2026-12-05", startAt: "2026-11-02", fields: { phase: "Build" } });
  const garden = await addProject(owner, { contact: "ct_seed03", name: "Garden", status: "on_hold", targetAt: "2026-11-30", startAt: "2026-11-10" });
  const shed = await addProject(owner, { contact: "ct_seed01", name: "Shed" });
  const fence = await addProject(owner, { contact: "ct_seed01", name: "Fence", status: "done" });
  const office = await addProject(owner, { name: "Office move" });
  const archived = await addProject(owner, { contact: "ct_seed01", name: "Gone shed" });
  await updateProject(owner, archived.projectId, { archived: true });
  return { db, retrofit: retrofit.projectId, garden: garden.projectId, shed: shed.projectId, fence: fence.projectId, office: office.projectId, gone: archived.projectId };
}

const stored = (db: Db, id: string) => db.prepare("SELECT * FROM views WHERE id = ?").bind(id).first<ViewRow>();

test("add_view with module projects stores filters by key, the sort, layout and the usual columns", async () => {
  const { db } = await setup();
  const result = await addView(ctxFor(db), { name: "Open work", module: "projects", filters: { status: "open", contact: "ct_seed01", fields: { phase: "Build" } }, sort: "name" });
  assert.match(result.summary, /^Added projects view Open work \(vw_\w+\): status open, person ct_seed01, Phase Build; by name, A to Z/);
  const row = await stored(db, result.viewId);
  assert.equal(row?.module, "projects");
  assert.equal(row?.filters, '{"status":"open","contact":"ct_seed01","fields":{"phase":"Build"}}');
  assert.equal(row?.sort, "name-asc");
  assert.equal(row?.columns, '["project","status","person","start","target","open_tasks"]');
});

test("a status filter takes a live status by key or label, open or closed; an archived or unknown one is refused", async () => {
  const { db } = await setup();
  const held = await addView(ctxFor(db), { name: "Held", module: "projects", filters: { status: "On hold" } });
  assert.equal((await stored(db, held.viewId))?.filters, '{"status":"on_hold"}');
  const closed = await addView(ctxFor(db), { name: "Closed", module: "projects", filters: { status: "Closed" } });
  assert.equal((await stored(db, closed.viewId))?.filters, '{"status":"closed"}');
  await assert.rejects(addView(ctxFor(db), { name: "Bad", module: "projects", filters: { status: "sideways" } }), /no status "sideways"/);
  const archived = await addView(ctxFor(db), { name: "Archived ones", module: "projects", filters: { archived: true } });
  assert.equal((await stored(db, archived.viewId))?.filters, '{"archived":true}');
});

test("people and deals filters are refused on a projects view, and a project filter on the other modules", async () => {
  const { db } = await setup();
  await assert.rejects(addView(ctxFor(db), { name: "A", module: "projects", filters: { personStatus: "Partner" } }), /isn't a filter of a projects view/);
  await assert.rejects(addView(ctxFor(db), { name: "B", module: "projects", filters: { stage: "won" } }), /isn't a filter of a projects view/);
  await assert.rejects(addView(ctxFor(db), { name: "C", module: "people", filters: { status: "open" } }), /Status filters projects/);
  await assert.rejects(addView(ctxFor(db), { name: "D", module: "deals", filters: { archived: true } }), /filters projects/);
  await assert.rejects(addView(ctxFor(db), { name: "E", module: "projects", filters: { contact: "ct_nobody" } }), /contact/i);
});

test("projects sorts and columns: target, name, newest, start; a custom field column; the first column is the project", async () => {
  const { db } = await setup();
  for (const sort of ["target", "name", "newest", "start"]) {
    const added = await addView(ctxFor(db), { name: `By ${sort}`, module: "projects", sort });
    assert.match((await stored(db, added.viewId))?.sort ?? "", new RegExp(`^${sort}-(asc|desc)$`));
  }
  assert.equal((await stored(db, (await addView(ctxFor(db), { name: "N", module: "projects", sort: "newest" })).viewId))?.sort, "newest-desc");
  await assert.rejects(addView(ctxFor(db), { name: "X", module: "projects", sort: "value" }), /sorts by target, name, newest and start/);
  const cols = await addView(ctxFor(db), { name: "Wide", module: "projects", layout: "table", columns: ["project", "status", "person", "deal", "start", "target", "open_tasks", "Phase"] });
  assert.equal((await stored(db, cols.viewId))?.columns, '["project","status","person","deal","start","target","open_tasks","fields.phase"]');
  await assert.rejects(addView(ctxFor(db), { name: "Y", module: "projects", columns: ["status", "project"] }), /Start the columns with project/);
});

test("every project view is refused while projects are off, and list_views leaves them out", async () => {
  const { db } = await setup();
  const made = await addView(ctxFor(db), { name: "Open work", module: "projects", filters: { status: "open" } });
  await db.prepare("UPDATE settings SET projects = 0").run();
  await assert.rejects(addView(ctxFor(db), { name: "Another", module: "projects" }), OFF);
  await assert.rejects(updateView(ctxFor(db, "update_view"), made.viewId, { name: "Renamed" }), OFF);
  await assert.rejects(archiveView(ctxFor(db, "archive_view"), made.viewId), OFF);
  assert.ok(!(await listViews(db)).some((v) => v.module === "projects"));
  assert.deepEqual(await listViews(db, { module: "projects" }), []);
  await db.prepare("UPDATE settings SET projects = 1").run();
  const on = await listViews(db, { module: "projects" });
  assert.deepEqual(on.map((v) => [v.kind, v.name, v.path]), [
    ["built_in", "Open", "/projects"],
    ["saved", "Open work", `/projects?view=${made.viewId}`],
  ]);
  assert.equal(on[1]?.shows, "status open");
});

test("update_view and archive_view work on a projects view while on", async () => {
  const { db } = await setup();
  const made = await addView(ctxFor(db), { name: "Open work", module: "projects", filters: { status: "open" } });
  const updated = await updateView(ctxFor(db, "update_view"), made.viewId, { filters: { status: "closed" }, sort: "start" });
  assert.match(updated.summary, /filters to status closed; sort to earliest start first/);
  await archiveView(ctxFor(db, "archive_view"), made.viewId);
  assert.equal((await stored(db, made.viewId))?.archived, 1);
});

test("the switch lists each live project status, then saved project views", async () => {
  const { db } = await setup();
  const made = await addView(ctxFor(db), { name: "Open work", module: "projects" });
  assert.deepEqual(
    (await switchItems(db, "projects")).map((i) => [i.kind, i.id, i.path]),
    [
      ["status", "active", "/projects?status=active"],
      ["status", "on_hold", "/projects?status=on_hold"],
      ["status", "done", "/projects?status=done"],
      ["saved", made.viewId, `/projects?view=${made.viewId}`],
    ],
  );
  assert.deepEqual((await switchItems(db, "people")).filter((i) => i.path.startsWith("/projects")), []);
});

test("projectsInView filters in SQL: status, open and closed, person, archived, custom field; a person is optional", async () => {
  const { db, retrofit, garden, shed, fence, office, gone } = await setup();
  const read = async (filters: Parameters<typeof projectsInView>[1], key = "name", dir: "asc" | "desc" = "asc") =>
    projectsInView(db,filters, { key: key as "name", dir });
  assert.deepEqual(ids((await read({})).items), [fence, garden, office, retrofit, shed]);
  assert.deepEqual(ids((await read({ status: "open" })).items), [garden, office, retrofit, shed]);
  assert.deepEqual(ids((await read({ status: "closed" })).items), [fence]);
  assert.deepEqual(ids((await read({ status: "on_hold" })).items), [garden]);
  assert.deepEqual(ids((await read({ contact: "ct_seed01" })).items), [fence, retrofit, shed]);
  assert.deepEqual(ids((await read({ archived: true })).items), [gone]);
  assert.deepEqual(ids((await read({ fields: { phase: "Build" } })).items), [retrofit]);
  const internal = (await read({})).items.find((p) => p.id === office);
  assert.equal(internal?.contactName, null);
  const all = await read({ status: "open" });
  assert.equal(all.total, 4);
});

test("projectsInView sorts: target soonest first with none last, start, newest, and a direction", async () => {
  const { db, retrofit, garden, shed, office } = await setup();
  for (const [n, id] of [retrofit, garden, shed, office].entries()) {
    await db.prepare("UPDATE projects SET created_at = ? WHERE id = ?").bind(`2026-11-1${n}T00:00:00.000Z`, id).run();
  }
  const at = async (key: string, dir: "asc" | "desc") =>
    ids((await projectsInView(db,{ status: "open" }, { key: key as "target", dir })).items);
  assert.deepEqual((await at("target", "asc")).slice(0, 2), [garden, retrofit]);
  assert.deepEqual((await at("target", "desc")).slice(0, 2), [retrofit, garden]);
  assert.deepEqual((await at("start", "asc")).slice(0, 2), [retrofit, garden]);
  assert.deepEqual(await at("newest", "desc"), [office, shed, garden, retrofit]);
  assert.deepEqual(await at("name", "desc"), [shed, retrofit, office, garden]);
});

test("projectsInView refuses while projects are off", async () => {
  const db = await timeDb(NOW);
  await assert.rejects(projectsInView(db,{}, { key: "name", dir: "asc" }), OFF);
});
