import assert from "node:assert/strict";
import { test } from "node:test";
import { call, connectInMemory } from "../../tests/helpers/mcp-client.ts";
import type { Db } from "../db/db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import { GENERIC_ERROR } from "./format.ts";
import { SERVER_INSTRUCTIONS } from "./instructions.ts";
import { createMcpServer } from "./server.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");

// The spec's tool lists, minus the tools of later plan tasks (5: stages, fields, tasks, rulebook and settings
// writes; 6: rules). Each of those tasks adds its names here.
const READ_TOOLS = ["get_deal", "get_rulebook", "list_deals", "pipeline_summary", "recent_changes", "search_contacts", "whats_due"];
const WRITE_TOOLS = ["add_lead", "add_task", "log_activity", "undo_change", "update_contact", "update_deal"];

async function client(db?: Db) {
  return connectInMemory(createMcpServer({ db: db ?? (await openTestDb()), now: () => NOW }));
}

test("the server offers exactly the tools built so far", async () => {
  const { tools } = await (await client()).listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...READ_TOOLS, ...WRITE_TOOLS].sort());
});

test("every read tool is annotated read-only and every write tool is not", async () => {
  const { tools } = await (await client()).listTools();
  for (const tool of tools) {
    const read = READ_TOOLS.includes(tool.name);
    assert.equal(tool.annotations?.readOnlyHint, read, tool.name);
    assert.equal(tool.annotations?.openWorldHint, false, tool.name);
    if (!read) {
      assert.equal(typeof tool.annotations?.destructiveHint, "boolean", tool.name);
      assert.equal(typeof tool.annotations?.idempotentHint, "boolean", tool.name);
    }
    assert.ok(tool.description && tool.description.length > 20, tool.name);
    assert.equal(tool.inputSchema.type, "object", tool.name);
  }
  const byName = new Map(tools.map((t) => [t.name, t]));
  assert.equal(byName.get("add_lead")?.annotations?.destructiveHint, false);
  assert.equal(byName.get("add_lead")?.annotations?.idempotentHint, false);
  assert.equal(byName.get("undo_change")?.annotations?.destructiveHint, true);
});

test("date inputs describe the accepted formats", async () => {
  const { tools } = await (await client()).listTools();
  const dateInputs = tools.flatMap((tool) =>
    Object.entries((tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>)
      .filter(([key]) => ["nextAt", "dueAt", "occurredAt", "since"].includes(key))
      .map(([key, schema]) => [`${tool.name}.${key}`, schema.description ?? ""] as const),
  );
  assert.equal(dateInputs.length, 5);
  for (const [name, description] of dateInputs) {
    assert.match(description, /YYYY-MM-DD\b/, name);
    assert.match(description, /YYYY-MM-DDTHH:mm in the owner's timezone/, name);
    assert.match(description, /ISO time with an offset/, name);
  }
});

test("clients receive the server instructions", async () => {
  assert.equal((await client()).getInstructions(), SERVER_INSTRUCTIONS);
});

test("an unexpected failure answers the generic message and logs no details", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const broken: Db = {
    prepare() {
      throw new Error("D1_ERROR: no such table: deals (pat@example.com)");
    },
    batch() {
      throw new Error("D1_ERROR: batch failed");
    },
  };
  const c = await client(broken);
  for (const name of ["pipeline_summary", "add_lead"]) {
    const answer = await call(c, name, name === "add_lead" ? { name: "Pat Example" } : {});
    assert.equal(answer.isError, true, name);
    assert.equal(answer.text, GENERIC_ERROR, name);
  }
  const lines = logged.mock.calls.map((c) => JSON.stringify(c.arguments)).join("\n");
  assert.match(lines, /mcp_tool_failed/);
  assert.doesNotMatch(lines, /D1_ERROR|pat@example\.com|Pat Example/);
});
