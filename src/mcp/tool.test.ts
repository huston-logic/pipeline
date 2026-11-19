import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { connectInMemory } from "../../tests/helpers/mcp-client.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import { createMcpServer } from "./server.ts";
import { advertised } from "./tool.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");

test("a tool's JSON Schema is worked out once per tool name, not once per request", () => {
  let conversions = 0;
  const schema = (description: string) => {
    const made = z.strictObject({ name: z.string().describe(description) });
    const standard = made["~standard"];
    const counted = {
      input: (options: Parameters<typeof standard.jsonSchema.input>[0]) => {
        conversions += 1;
        return standard.jsonSchema.input(options);
      },
      output: standard.jsonSchema.output,
    };
    Object.defineProperty(made, "~standard", { value: { ...standard, jsonSchema: counted } });
    return made;
  };
  const target = { target: "draft-2020-12" } as const;
  // Each request builds its tools again, so each one brings a new zod object with the same shape.
  const first = advertised("cache_test_tool", schema("The name."))["~standard"].jsonSchema.input(target);
  const second = advertised("cache_test_tool", schema("The name."))["~standard"].jsonSchema.input(target);
  assert.equal(conversions, 1);
  assert.deepEqual(second, first);
  assert.equal((first.properties as Record<string, { description: string }>).name?.description, "The name.");
});

test("tools/list answers the same from a second server, so the reused schemas are the right ones", async () => {
  const db = await openTestDb();
  const deps = { db, now: () => NOW };
  const list = async () => (await (await connectInMemory(createMcpServer(deps))).listTools()).tools;
  const first = await list();
  const second = await list();
  assert.deepEqual(second, first);
  assert.ok(first.length > 20);
  for (const tool of first) assert.equal(tool.inputSchema.type, "object", tool.name);
});
