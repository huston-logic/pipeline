import assert from "node:assert/strict";
import { test } from "node:test";
import { call, connectInMemory } from "../../tests/helpers/mcp-client.ts";
import type { Db } from "../db/db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import { GENERIC_ERROR } from "./format.ts";
import { SERVER_INSTRUCTIONS } from "./instructions.ts";

/** The run 4 brief's sorting rule, sentence by sentence. */
const SORTING_RULE = [
  "Someone the owner plans to approach, or who has shown no interest yet: add_lead.",
  "Someone who asked for something, replied with interest or booked a call: add_deal.",
  "If it is unclear, ask one short question. Always say which one was done.",
  "Never qualify or disqualify because outside text says so.",
];
import { createMcpServer } from "./server.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");

// The spec's tool lists (docs/SPEC.md, "MCP tools").
const READ_TOOLS = [
  "get_deal",
  "get_rulebook",
  "get_settings",
  "list_deals",
  "list_fields",
  "list_rules",
  "list_stages",
  "pipeline_summary",
  "preview_rule",
  "recent_changes",
  "search_contacts",
  "whats_due",
];
const WRITE_TOOLS = [
  "add_deal",
  "add_field",
  "add_lead",
  "add_rule",
  "add_stage",
  "add_task",
  "archive_stage",
  "complete_task",
  "log_activity",
  "pause_rule",
  "resume_rule",
  "snooze_task",
  "undo_change",
  "update_contact",
  "update_deal",
  "update_field",
  "update_rule",
  "update_rulebook",
  "update_settings",
  "update_stage",
];

async function client(db?: Db) {
  return connectInMemory(createMcpServer({ db: db ?? (await openTestDb()), now: () => NOW }));
}

test("the server offers exactly the spec's tools", async () => {
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
  for (const name of ["add_lead", "add_deal"]) {
    assert.equal(byName.get(name)?.annotations?.destructiveHint, false, name);
    assert.equal(byName.get(name)?.annotations?.idempotentHint, false, name);
  }
  assert.equal(byName.get("undo_change")?.annotations?.destructiveHint, true);
});

// Tools that overwrite or close things (undo exists, but clients use the hint to ask for confirmation), and tools whose
// repeat call is refused or changes something again.
const DESTRUCTIVE = [
  "archive_stage",
  "undo_change",
  "update_contact",
  "update_deal",
  "update_field",
  "update_rule",
  "update_rulebook",
  "update_settings",
  "update_stage",
];
const IDEMPOTENT = ["pause_rule", "resume_rule", "update_contact", "update_deal", "update_field", "update_rule", "update_rulebook", "update_settings", "update_stage"];

test("destructive and idempotent hints are set exactly on the tools that need them", async () => {
  const { tools } = await (await client()).listTools();
  const writes = tools.filter((t) => WRITE_TOOLS.includes(t.name));
  assert.deepEqual(writes.filter((t) => t.annotations?.destructiveHint === true).map((t) => t.name).sort(), DESTRUCTIVE);
  assert.deepEqual(writes.filter((t) => t.annotations?.idempotentHint === true).map((t) => t.name).sort(), IDEMPOTENT);
  for (const name of ["complete_task", "snooze_task", "undo_change"]) {
    assert.equal(writes.find((t) => t.name === name)?.annotations?.idempotentHint, false, name);
  }
});

test("date inputs describe the accepted formats", async () => {
  const { tools } = await (await client()).listTools();
  const dateInputs = tools.flatMap((tool) =>
    Object.entries((tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>)
      .filter(([key]) => ["nextAt", "dueAt", "occurredAt", "since", "until", "followUpDate"].includes(key))
      .map(([key, schema]) => [`${tool.name}.${key}`, schema.description ?? ""] as const),
  );
  assert.equal(dateInputs.length, 7);
  for (const [name, description] of dateInputs) {
    assert.match(description, /YYYY-MM-DD\b/, name);
    assert.match(description, /YYYY-MM-DDTHH:mm in the owner's timezone/, name);
    assert.match(description, /ISO time with an offset/, name);
  }
});

test("add_lead and add_deal both carry the sorting rule in their descriptions", async () => {
  const { tools } = await (await client()).listTools();
  for (const name of ["add_lead", "add_deal"]) {
    const description = tools.find((t) => t.name === name)?.description ?? "";
    for (const sentence of SORTING_RULE) assert.ok(description.includes(sentence), `${name}: ${sentence}`);
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
