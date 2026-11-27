// The saved view tools (decision 0042): list_views, add_view, update_view and archive_view, the owner's sentence "give
// me a view of all my partners", and the plain refusals.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { CHANGE_LINE, connectInMemory, fails, ok } from "../../tests/helpers/mcp-client.ts";
import { createTestDb } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import { createMcpServer } from "./server.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");

async function setup() {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  return { db, c: await connectInMemory(createMcpServer({ db, now: () => NOW })) };
}

type View = { kind: string; id: string | null; name: string; path: string; filters: unknown; shows: string | null; archived: boolean };
const viewsOf = (data: unknown) => (data as { views: View[] }).views;

test('"give me a view of all my partners": add_view with personStatus partner, listed after the built-in and default views', async () => {
  const { db, c } = await setup();
  const added = await ok(c, "add_view", { name: "Partners", module: "people", filters: { personStatus: "partner" } });
  assert.match(added.headline, /^Added people view Partners \(vw_[a-z2-7]{12}\): person status Partner; by name, A to Z \(change chg_[a-z0-9]{12}\)$/);
  const { viewId, changeId } = added.data as { viewId: string; changeId: string };
  const audit = await db.prepare("SELECT actor, tool FROM audit_log WHERE id = ?").bind(changeId).first();
  assert.deepEqual({ ...audit }, { actor: "ai", tool: "add_view" });

  const listed = await ok(c, "list_views", { module: "people" });
  assert.equal(listed.headline, "5 views: Leads, Contacts, Accounts, Partner, Partners (saved).");
  const saved = viewsOf(listed.data).at(-1);
  assert.deepEqual(
    { kind: saved?.kind, id: saved?.id, path: saved?.path, filters: saved?.filters, shows: saved?.shows },
    { kind: "saved", id: viewId, path: `/people?view=${viewId}`, filters: { personStatus: "partner" }, shows: "person status Partner" },
  );
  assert.equal(viewsOf(listed.data)[3]?.path, "/people?status=partner");
});

test("update_view and archive_view are one audited change each; undo brings an archived view back", async () => {
  const { c } = await setup();
  const added = await ok(c, "add_view", { name: "Big jobs", module: "deals", sort: "value" });
  const { viewId } = added.data as { viewId: string };
  const updated = await ok(c, "update_view", { view: "big jobs", filters: { stage: "proposal_sent" }, layout: "table", columns: ["deal", "value", "Days in stage"] });
  assert.equal(updated.headline.replace(CHANGE_LINE, ""), "Updated view Big jobs: filters to stage Proposal sent; layout to table; columns to deal, value, days_in_stage ");
  const archived = await ok(c, "archive_view", { view: viewId });
  assert.match(archived.headline, /^Archived view Big jobs \(change chg_/);
  assert.deepEqual(viewsOf((await ok(c, "list_views", { module: "deals" })).data).map((view) => view.name), ["Board", "List"]);
  const all = viewsOf((await ok(c, "list_views", { module: "deals", includeArchived: true })).data);
  assert.deepEqual(all.map((view) => [view.name, view.archived]), [["Board", false], ["List", false], ["Big jobs", true]]);

  await ok(c, "undo_change", { changeId: (archived.data as { changeId: string }).changeId });
  assert.deepEqual(viewsOf((await ok(c, "list_views", { module: "deals" })).data).map((view) => view.name), ["Board", "List", "Big jobs"]);
});

test("the view tools refuse in plain English: wrong module filters, unknown filter keys, bad sorts and unknown views", async () => {
  const { c } = await setup();
  assert.equal(
    await fails(c, "add_view", { name: "X", module: "deals", filters: { personStatus: "partner" } }),
    "Person status filters people, not deals. Make a people view for it, or leave personStatus out.",
  );
  assert.match(await fails(c, "add_view", { name: "X", module: "people", filters: { colour: "blue" } }), /colour/);
  assert.match(await fails(c, "add_view", { name: "X", module: "people", sort: "value" }), /^A people view sorts by name, business, last_activity, next_task and created\./);
  assert.match(await fails(c, "add_view", { name: "X", module: "tasks" }), /module/);
  assert.match(await fails(c, "update_view", { view: "Nothing", name: "Y" }), /^There's no saved view "Nothing"\. There are none yet\.$/);
  assert.match(await fails(c, "archive_view", { view: "vw_nothing" }), /^There's no saved view "vw_nothing"/);
});
