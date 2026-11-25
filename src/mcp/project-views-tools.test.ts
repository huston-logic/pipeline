// list_fields counts and shows project fields only while projects are on; the view tools take module "projects".
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { connectInMemory, fails, ok } from "../../tests/helpers/mcp-client.ts";
import { createTestDb } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import { createMcpServer } from "./server.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");

async function setup() {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  db.exec(`INSERT INTO field_defs (id, entity, key, label, type, choices, archived, version, created_at, updated_at)
    VALUES ('fd_proj1', 'project', 'budget', 'Budget', 'number', NULL, 0, 1, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`);
  return { db, c: await connectInMemory(createMcpServer({ db, now: () => NOW })) };
}

test("list_fields leaves project fields out while projects are off, and counts them while on", async () => {
  const { db, c } = await setup();
  const off = await ok(c, "list_fields");
  assert.ok(!(off.data as { fields: { entity: string }[] }).fields.some((f) => f.entity === "project"));
  assert.doesNotMatch(off.headline, /project/);
  assert.match((await ok(c, "list_fields", { entity: "project" })).headline, /^There are no custom fields yet\./);
  db.exec("UPDATE settings SET projects = 1");
  const on = await ok(c, "list_fields");
  assert.ok((on.data as { fields: { entity: string }[] }).fields.some((f) => f.entity === "project"));
  assert.match(on.headline, /^\d+ deal fields?, \d+ contact fields? and 1 project field\.$/);
});

test("add_view, list_views and the refusal while off take module projects", async () => {
  const { db, c } = await setup();
  assert.match(await fails(c, "add_view", { name: "Open work", module: "projects" }), /Projects are off/);
  db.exec("UPDATE settings SET projects = 1");
  const added = await ok(c, "add_view", { name: "Open work", module: "projects", filters: { status: "open", archived: false }, sort: "target", layout: "table" });
  assert.match(added.headline, /^Added projects view Open work/);
  const listed = (await ok(c, "list_views", { module: "projects" })).data as { views: { name: string; module: string; sort: string | null }[] };
  assert.deepEqual(listed.views.map((v) => [v.name, v.module]), [["Open", "projects"], ["Open work", "projects"]]);
  db.exec("UPDATE settings SET projects = 0");
  const hidden = (await ok(c, "list_views")).data as { views: { module: string }[] };
  assert.ok(!hidden.views.some((v) => v.module === "projects"));
});
