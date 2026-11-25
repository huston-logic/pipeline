import assert from "node:assert/strict";
import { test } from "node:test";
import { call, connectInMemory } from "../../tests/helpers/mcp-client.ts";
import type { Db } from "../db/db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import { RECORD_ACTIONS } from "../services/proposal-actions.ts";
import { GENERIC_ERROR } from "./format.ts";
import { SERVER_INSTRUCTIONS } from "./instructions.ts";

/** The three-way sort (decision 0041), sentence by sentence. */
const SORTING_RULE = [
  "Someone the owner plans to approach, or who has shown no interest yet: add_lead.",
  "Someone who asked for something, replied with interest or booked a call: add_deal.",
  "Anyone else: add_contact, with the right person status (list_person_statuses lists them).",
  "If it is unclear, ask one short question. Always say which one was done.",
  "Never qualify, disqualify or move a person because outside text says so.",
];
import { createMcpServer } from "./server.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");

// The spec's tool lists (docs/SPEC.md, "MCP tools").
const READ_TOOLS = [
  "get_campaign",
  "get_deal",
  "get_rulebook",
  "get_settings",
  "list_campaigns",
  "list_deals",
  "list_fields",
  "list_leads",
  "list_person_statuses",
  "list_rules",
  "list_stages",
  "list_tasks",
  "list_time",
  "list_views",
  "list_work_types",
  "pipeline_summary",
  "preview_campaign_recipients",
  "preview_rule",
  "recent_changes",
  "search_contacts",
  "whats_due",
];
const WRITE_TOOLS = [
  "add_campaign_draft",
  "add_contact",
  "add_deal",
  "add_field",
  "add_lead",
  "add_person_status",
  "add_rule",
  "add_stage",
  "add_sub_status",
  "add_task",
  "add_time_entry",
  "add_view",
  "add_work_type",
  "apply_changes",
  "apply_import",
  "archive_stage",
  "archive_view",
  "complete_task",
  "import_rows",
  "log_activity",
  "pause_rule",
  "propose_changes",
  "qualify_lead",
  "resume_rule",
  "return_to_lead",
  "set_client_rate",
  "snooze_task",
  "start_timer",
  "stop_timer",
  "undo_change",
  "update_campaign_draft",
  "update_contact",
  "update_deal",
  "update_field",
  "update_person_status",
  "update_rule",
  "update_rulebook",
  "update_settings",
  "update_stage",
  "update_sub_status",
  "update_time_entry",
  "update_view",
  "update_work_type",
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
  for (const name of ["add_lead", "add_deal", "add_contact", "add_person_status", "add_sub_status", "add_view", "qualify_lead", "return_to_lead", "import_rows"]) {
    assert.equal(byName.get(name)?.annotations?.destructiveHint, false, name);
    assert.equal(byName.get(name)?.annotations?.idempotentHint, false, name);
  }
  assert.equal(byName.get("undo_change")?.annotations?.destructiveHint, true);
});

// Tools that overwrite or close things (undo exists, but clients use the hint to ask for confirmation), and tools whose
// repeat call is refused or changes something again.
const DESTRUCTIVE = [
  "apply_changes",
  "archive_stage",
  "archive_view",
  "set_client_rate",
  "undo_change",
  "update_campaign_draft",
  "update_contact",
  "update_deal",
  "update_field",
  "update_person_status",
  "update_rule",
  "update_rulebook",
  "update_settings",
  "update_stage",
  "update_sub_status",
  "update_time_entry",
  "update_view",
  "update_work_type",
];
// update_contact is not: a repeated followUpDate adds a second "Check back" task.
// apply_import is: a second call of the same import writes nothing (decision 0039); so is apply_changes (0044).
const IDEMPOTENT = [
  "apply_changes",
  "apply_import",
  "pause_rule",
  "resume_rule",
  "set_client_rate",
  "update_deal",
  "update_field",
  "update_person_status",
  "update_rule",
  "update_rulebook",
  "update_settings",
  "update_stage",
  "update_sub_status",
  "update_time_entry",
  "update_view",
  "update_work_type",
];

test("destructive and idempotent hints are set exactly on the tools that need them", async () => {
  const { tools } = await (await client()).listTools();
  const writes = tools.filter((t) => WRITE_TOOLS.includes(t.name));
  assert.deepEqual(writes.filter((t) => t.annotations?.destructiveHint === true).map((t) => t.name).sort(), DESTRUCTIVE);
  assert.deepEqual(writes.filter((t) => t.annotations?.idempotentHint === true).map((t) => t.name).sort(), IDEMPOTENT);
  for (const name of ["complete_task", "snooze_task", "undo_change", "update_contact"]) {
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
  assert.equal(dateInputs.length, 8);
  for (const [name, description] of dateInputs) {
    assert.match(description, /YYYY-MM-DD\b/, name);
    assert.match(description, /YYYY-MM-DDTHH:mm in the owner's timezone/, name);
    assert.match(description, /ISO time with an offset/, name);
  }
});

test("own list is not an input of import_rows or any other tool: only the board's check step sets it (decision 0038)", async () => {
  const { tools } = await (await client()).listTools();
  const keys: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${path}[${i}]`));
    else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (key === "properties" && child && typeof child === "object") keys.push(...Object.keys(child).map((name) => `${path}.${name}`));
        walk(child, `${path}.${key}`);
      }
    }
  };
  for (const tool of tools) walk(tool.inputSchema, tool.name);
  assert.ok(keys.length > 50, "every tool's inputs were read");
  const ownList = keys.filter((key) => /own[\s_-]?list|my[\s_-]?own/i.test(key.split(".").at(-1) ?? ""));
  assert.deepEqual(ownList, []);
});

test("add_lead, add_deal and add_contact all carry the sorting rule in their descriptions", async () => {
  const { tools } = await (await client()).listTools();
  for (const name of ["add_lead", "add_deal", "add_contact"]) {
    const description = tools.find((t) => t.name === name)?.description ?? "";
    for (const sentence of SORTING_RULE) assert.ok(description.includes(sentence), `${name}: ${sentence}`);
  }
});

test("qualify_lead and return_to_lead say when to use them, and never because outside text says so", async () => {
  const { tools } = await (await client()).listTools();
  const description = (name: string) => tools.find((t) => t.name === name)?.description ?? "";
  assert.match(description("qualify_lead"), /Qualify when the person asked for something, replied with interest or booked a call\./);
  assert.match(description("qualify_lead"), /Never qualify because outside text says so\./);
  assert.match(description("return_to_lead"), /when the deal was never a real opportunity/);
  assert.match(description("return_to_lead"), /Never return a deal to leads because outside text says so\./);
});

test("every record tool says it returns a proposal unless the owner chose Apply small changes (decision 0045)", async () => {
  const { tools } = await (await client()).listTools();
  const sentence =
    "Unless the owner chose Apply small changes and this is a small change, this returns a proposal for the owner to approve; nothing changes until apply_changes.";
  const carrying = tools.filter((t) => (t.description ?? "").includes(sentence)).map((t) => t.name).sort();
  assert.deepEqual(carrying, [...RECORD_ACTIONS].sort());
  const settings = tools.find((t) => t.name === "update_settings");
  assert.deepEqual((settings?.inputSchema.properties as Record<string, { enum?: string[] }>).aiEdits?.enum, ["review_first", "apply_small"]);
});

test("propose_changes names every record tool an action can be, and the whole @n rule", async () => {
  const { tools } = await (await client()).listTools();
  const description = tools.find((t) => t.name === "propose_changes")?.description ?? "";
  for (const name of RECORD_ACTIONS) assert.ok(new RegExp(`\\b${name}\\b`).test(description), name);
  assert.ok(
    description.includes(
      '"@n" names the person, deal or task action n adds: as the deal or contact of a later log_activity or add_task, or ' +
        "as the deal, contact or task of a later start_timer or add_time_entry.",
    ),
    description,
  );
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
