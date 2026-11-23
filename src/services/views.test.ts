import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db, ViewRow } from "../db/db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import type { Ctx } from "./change.ts";
import { UserError } from "./errors.ts";
import { addField } from "./fields.ts";
import { addPersonStatus, addSubStatus, updatePersonStatus } from "./person-status.ts";
import { addStage } from "./stages.ts";
import { undoChange } from "./undo.ts";
import { addView, archiveView, listViews, switchItems, updateView } from "./views.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const ctxFor = (db: Db, tool: string): Ctx => ({ db, now: NOW, actor: "ai", tool });

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => assert.fail("expected a refusal"),
    (e: unknown) => e,
  );
  assert.ok(error instanceof UserError, `expected a UserError, got ${String(error)}`);
  return error.message;
}

const view = (db: Db, id: string) => db.prepare("SELECT * FROM views WHERE id = ?").bind(id).first<ViewRow>();
const order = async (db: Db, module: string) =>
  (await db.prepare("SELECT name, position, archived FROM views WHERE module = ? ORDER BY position").bind(module).all<ViewRow>()).results.map(
    (row) => `${row.position}:${row.name}${row.archived === 1 ? " (archived)" : ""}`,
  );

test("add_view: a people view by status label is stored by key, with the usual sort, layout and columns, in one change", async () => {
  const db = await openTestDb();
  const result = await addView(ctxFor(db, "add_view"), { name: "Partners", module: "people", filters: { personStatus: "Partner" } });
  assert.match(result.viewId, /^vw_[a-z2-7]{12}$/);
  assert.equal(result.summary, `Added people view Partners (${result.viewId}): person status Partner; by name, A to Z (change ${result.changeId})`);
  const row = await view(db, result.viewId);
  assert.deepEqual(
    { ...row, id: "", created_at: "", updated_at: "" },
    {
      id: "",
      name: "Partners",
      module: "people",
      filters: '{"person_status":"partner"}',
      sort: "name-asc",
      layout: "cards",
      columns: '["name","business","person_status","sub_status","next_task","last_activity"]',
      position: 1,
      archived: 0,
      version: 1,
      created_at: "",
      updated_at: "",
    },
  );
  const audit = await db.prepare("SELECT actor, tool, target_table, target_id FROM audit_log WHERE id = ?").bind(result.changeId).first();
  assert.deepEqual({ ...audit }, { actor: "ai", tool: "add_view", target_table: "views", target_id: result.viewId });

  const undone = await undoChange(ctxFor(db, "undo_change"), result.changeId);
  assert.match(undone.summary, /^Undid chg_\w+: Removed view Partners/);
  assert.equal(await view(db, result.viewId), null);
});

test("add_view checks every filter: keys and labels, sub-status under its status, fields by label and type, stage for deals", async () => {
  const db = await openTestDb();
  await addField(ctxFor(db, "add_field"), { entity: "contact", label: "Budget", type: "number" });
  await addField(ctxFor(db, "add_field"), { entity: "deal", label: "Project type", type: "choice", choices: ["Commercial", "Public"] });
  const people = await addView(ctxFor(db, "add_view"), {
    name: "Clients on a budget",
    module: "people",
    filters: { personStatus: "contact", subStatus: "Client", source: " Referral ", q: "smith", fields: { Budget: "1,500" } },
    sort: "last_activity",
  });
  assert.deepEqual(JSON.parse((await view(db, people.viewId))?.filters ?? ""), {
    person_status: "contact",
    sub_status: "client",
    source: "Referral",
    fields: { budget: 1500 },
    q: "smith",
  });
  assert.equal((await view(db, people.viewId))?.sort, "last_activity-desc");
  assert.match(people.summary, /: person status Contact \(Client\), source Referral, Budget 1500, search "smith"; latest activity first/);

  const deals = await addView(ctxFor(db, "add_view"), {
    name: "Public jobs won",
    module: "deals",
    filters: { stage: "Won", fields: { project_type: "Public" } },
    sort: "value",
    direction: "asc",
  });
  assert.deepEqual(JSON.parse((await view(db, deals.viewId))?.filters ?? ""), { stage: "won", fields: { project_type: "Public" } });
  assert.equal((await view(db, deals.viewId))?.sort, "value-asc");
  assert.equal((await view(db, deals.viewId))?.columns, '["deal","person","stage","value","next_step","days_in_stage"]');

  const add = (input: Parameters<typeof addView>[1]) => refusal(addView(ctxFor(db, "add_view"), input));
  assert.equal(await add({ name: "X", module: "deals", filters: { personStatus: "partner" } }), "Person status filters people, not deals. Make a people view for it, or leave personStatus out.");
  assert.equal(await add({ name: "X", module: "people", filters: { stage: "won" } }), "Stage filters deals, not people. Make a deals view for it, or leave stage out.");
  assert.match(await add({ name: "X", module: "people", filters: { colour: "blue" } as never }), /^"colour" isn't a view filter\. A people view filters by personStatus, subStatus, source, q and fields\.$/);
  assert.match(await add({ name: "X", module: "people", filters: { subStatus: "client" } }), /^A sub-status belongs to one person status\. Give personStatus too/);
  assert.match(await add({ name: "X", module: "people", filters: { personStatus: "supplier" } }), /^There's no person status "supplier"\. Use one of: Lead \(lead\), Contact \(contact\), Partner \(partner\)\.$/);
  assert.match(await add({ name: "X", module: "people", filters: { personStatus: "partner", subStatus: "client" } }), /^Partner has no sub-statuses/);
  assert.match(await add({ name: "X", module: "people", filters: { fields: { project_type: "Public" } } }), /^Project type is a deal field\. A people view uses contact fields/);
  assert.equal(await add({ name: "X", module: "people", filters: { fields: { budget: "lots" } } }), "Budget is a number field. Give a number as its value, for example 1500.");
  assert.match(await add({ name: "X", module: "deals", filters: { fields: { project_type: "Private" } } }), /isn't one of the choices for Project type: Commercial, Public/);
  assert.equal(await add({ name: "X", module: "people", filters: { q: "  " } }), "The search filter can't be empty. Leave it out to show everyone.");
  assert.match(await add({ name: "X", module: "deals", filters: { stage: "Nowhere" } }), /^There's no stage "Nowhere"/);
});

test("add_view refuses a missing, long, duplicate or built-in name, an unknown sort or layout, and bad columns", async () => {
  const db = await openTestDb();
  await addField(ctxFor(db, "add_field"), { entity: "contact", label: "Role", type: "text" });
  await addView(ctxFor(db, "add_view"), { name: "Partners", module: "people" });
  const add = (input: Parameters<typeof addView>[1]) => refusal(addView(ctxFor(db, "add_view"), input));
  assert.match(await add({ name: " ", module: "people" }), /^A view needs a name/);
  assert.match(await add({ name: "x".repeat(61), module: "people" }), /at most 60 characters \(got 61\)/);
  assert.match(await add({ name: "partners", module: "people" }), /^There's already a people view called Partners \(vw_\w+\)\. Pick a different name\.$/);
  assert.equal(await add({ name: "Leads", module: "people" }), "Leads is a built-in view of people. Pick a different name.");
  assert.equal(await add({ name: "list", module: "deals" }), "List is a built-in view of deals. Pick a different name.");
  assert.equal(await add({ name: "X", module: "deals", sort: "name" }), 'A deals view sorts by days_in_stage, value, next_date and created. "name" isn\'t one of them.');
  assert.equal(await add({ name: "X", module: "people", layout: "grid" as never }), 'A view\'s layout is cards or table (got "grid").');
  assert.equal(await add({ name: "X", module: "people", columns: ["business", "name"] }), "Start the columns with name: it links to each person.");
  assert.match(await add({ name: "X", module: "people", columns: ["name", "colour"] }), /^"colour" isn't a column of a people view\. Use name, business, .* or a contact field's key/);
  assert.equal(await add({ name: "X", module: "people", columns: ["name", "Company", "business"] }), "The column business is listed twice. Give each column once.");
  assert.match(await add({ name: "X", module: "people", position: 3 }), /^The position must be a whole number between 1 and 2 \(got 3\)\.$/);

  const ok = await addView(ctxFor(db, "add_view"), { name: "Roles", module: "people", columns: ["name", "Person status", "Role", "fields.role "].slice(0, 3), layout: "table" });
  const row = await view(db, ok.viewId);
  assert.deepEqual([row?.columns, row?.layout], ['["name","person_status","fields.role"]', "table"]);
  // Partners in one module doesn't clash with the other module.
  await addView(ctxFor(db, "add_view"), { name: "Partners", module: "deals" });
});

test("update_view renames, replaces the filters, changes direction only, moves it, and refuses a no-op or an archived view", async () => {
  const db = await openTestDb();
  const a = await addView(ctxFor(db, "add_view"), { name: "A", module: "people", filters: { personStatus: "partner", q: "smith" } });
  await addView(ctxFor(db, "add_view"), { name: "B", module: "people" });
  const c = await addView(ctxFor(db, "add_view"), { name: "C", module: "people" });
  assert.deepEqual(await order(db, "people"), ["1:A", "2:B", "3:C"]);

  const renamed = await updateView(ctxFor(db, "update_view"), "a", { name: "Partners", filters: { personStatus: "partner" }, direction: "desc" });
  assert.equal(renamed.summary, `Updated view A: name to Partners; filters to person status Partner; sort to by name, Z to A (change ${renamed.changeId})`);
  assert.deepEqual(JSON.parse((await view(db, a.viewId))?.filters ?? ""), { person_status: "partner" });
  assert.equal((await view(db, a.viewId))?.sort, "name-desc");

  const moved = await updateView(ctxFor(db, "update_view"), c.viewId, { position: 1, sort: "created" });
  assert.match(moved.summary, /^Updated view C: sort to newest first; position 1 of 3 \(change/);
  assert.deepEqual(await order(db, "people"), ["1:C", "2:Partners", "3:B"]);

  assert.equal(await refusal(updateView(ctxFor(db, "update_view"), "B", { name: "B", layout: "cards" })), "Nothing to change on B: give a new name, filters, sort, layout, columns or position.");
  assert.match(await refusal(updateView(ctxFor(db, "update_view"), "Nobody", { name: "X" })), /^There's no saved view "Nobody"\. Views: /);

  // Undo of the move puts every position back.
  await undoChange(ctxFor(db, "undo_change"), moved.changeId);
  assert.deepEqual(await order(db, "people"), ["1:Partners", "2:B", "3:C"]);

  await archiveView(ctxFor(db, "archive_view"), "B");
  assert.deepEqual(await order(db, "people"), ["1:Partners", "2:C", "3:B (archived)"]);
  const b = (await db.prepare("SELECT id FROM views WHERE name = 'B'").first<{ id: string }>())?.id ?? "";
  assert.equal(await refusal(updateView(ctxFor(db, "update_view"), b, { name: "Bee" })), "B is archived. Undo the change that archived it to bring it back.");
  // By name, an archived view isn't found: a new one may take its name.
  assert.match(await refusal(updateView(ctxFor(db, "update_view"), "B", { name: "Bee" })), /^There's no saved view "B"/);
  await addView(ctxFor(db, "add_view"), { name: "B", module: "people" });
});

test("archive_view takes it out of the switch and the list, keeps it with includeArchived, and undo brings it back", async () => {
  const db = await openTestDb();
  const a = await addView(ctxFor(db, "add_view"), { name: "Partners", module: "people", filters: { personStatus: "partner" } });
  const b = await addView(ctxFor(db, "add_view"), { name: "Big jobs", module: "people" });
  const archived = await archiveView(ctxFor(db, "archive_view"), "Partners");
  assert.equal(archived.summary, `Archived view Partners (change ${archived.changeId})`);
  assert.deepEqual(await order(db, "people"), ["1:Big jobs", "2:Partners (archived)"]);
  assert.deepEqual((await switchItems(db, "people")).map((item) => item.name), ["Partner", "Big jobs"]);
  assert.deepEqual((await listViews(db, { module: "people" })).map((item) => item.name), ["Contacts", "Leads", "Companies", "Partner", "Big jobs"]);
  const all = await listViews(db, { module: "people", includeArchived: true });
  assert.equal(all.find((item) => item.id === a.viewId)?.archived, true);
  assert.match(await refusal(archiveView(ctxFor(db, "archive_view"), a.viewId)), /^Partners is already archived/);

  await undoChange(ctxFor(db, "undo_change"), archived.changeId);
  assert.deepEqual(await order(db, "people"), ["1:Partners", "2:Big jobs"]);
  assert.deepEqual((await switchItems(db, "people")).map((item) => item.path), ["/people?status=partner", `/people?view=${a.viewId}`, `/people?view=${b.viewId}`]);
});

test("list_views: built-in views, then each live status but Lead and Contact (no row), then saved views, per module", async () => {
  const db = await openTestDb();
  await addPersonStatus(ctxFor(db, "add_person_status"), { label: "Supplier" });
  const deals = await addView(ctxFor(db, "add_view"), { name: "Won jobs", module: "deals", filters: { stage: "won" }, sort: "value" });
  const views = await listViews(db);
  assert.deepEqual(
    views.map((item) => `${item.module} ${item.kind} ${item.name} ${item.path}`),
    [
      "people built_in Contacts /contacts",
      "people built_in Leads /leads",
      "people built_in Companies /companies",
      "people status Partner /people?status=partner",
      "people status Supplier /people?status=supplier",
      "deals built_in Board /pipeline",
      "deals built_in List /pipeline?view=list",
      `deals saved Won jobs /pipeline?view=${deals.viewId}`,
    ],
  );
  const saved = views.at(-1);
  assert.deepEqual(
    { filters: saved?.filters, shows: saved?.shows, sort: saved?.sort, direction: saved?.direction, layout: saved?.layout, position: saved?.position },
    { filters: { stage: "won" }, shows: "stage Won", sort: "value", direction: "desc", layout: "cards", position: 1 },
  );
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM views").first("n"), 1, "the status views have no row");
  // A new status shows with no code; an archived one leaves.
  await updatePersonStatus(ctxFor(db, "update_person_status"), "supplier", { archived: true });
  assert.deepEqual((await switchItems(db, "people")).map((item) => item.name), ["Partner"]);
  assert.deepEqual((await switchItems(db, "deals")).map((item) => item.name), ["Won jobs"]);
});

test("undo of adding a status, a sub-status's status or a stage that a saved view uses refuses in plain English", async () => {
  const db = await openTestDb();
  const status = await addPersonStatus(ctxFor(db, "add_person_status"), { label: "Supplier" });
  await addSubStatus(ctxFor(db, "add_sub_status"), "supplier", { label: "Wholesale" });
  await addView(ctxFor(db, "add_view"), { name: "Wholesale suppliers", module: "people", filters: { personStatus: "Supplier", subStatus: "Wholesale" } });
  const stage = await addStage(ctxFor(db, "add_stage"), { label: "Demo booked" });
  await addView(ctxFor(db, "add_view"), { name: "Demos", module: "deals", filters: { stage: "demo_booked" } });

  assert.match(
    await refusal(undoChange(ctxFor(db, "undo_change"), status.changeId)),
    /^Can't undo chg_\w+: other records now depend on it \(1 sub-status; view Wholesale suppliers shows Supplier\)/,
  );
  assert.match(await refusal(undoChange(ctxFor(db, "undo_change"), stage.changeId)), /view Demos shows Demo booked/);
});

test("undo of adding a stage or status is blocked by a live saved view, not an archived one", async () => {
  const db = await openTestDb();
  const stage = await addStage(ctxFor(db, "add_stage"), { label: "Demo booked" });
  const status = await addPersonStatus(ctxFor(db, "add_person_status"), { label: "Supplier" });
  await addView(ctxFor(db, "add_view"), { name: "Demos", module: "deals", filters: { stage: "demo_booked" } });
  await addView(ctxFor(db, "add_view"), { name: "Suppliers", module: "people", filters: { personStatus: "Supplier" } });
  assert.match(await refusal(undoChange(ctxFor(db, "undo_change"), stage.changeId)), /view Demos shows Demo booked/);
  assert.match(await refusal(undoChange(ctxFor(db, "undo_change"), status.changeId)), /view Suppliers shows Supplier/);

  await archiveView(ctxFor(db, "archive_view"), "Demos");
  await archiveView(ctxFor(db, "archive_view"), "Suppliers");
  await undoChange(ctxFor(db, "undo_change"), stage.changeId);
  await undoChange(ctxFor(db, "undo_change"), status.changeId);
});
