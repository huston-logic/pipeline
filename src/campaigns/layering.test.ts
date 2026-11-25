import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

// No MCP tool approves, schedules, sends or clears a suppression (decision 0053): the code that does is out of its reach.
const OWNER_ONLY = /from\s+["'][^"']*campaigns\/(freeze|send|resend|suppressions)(\.ts)?["']/;

test("nothing under src/mcp imports the owner-only campaign code", () => {
  const dir = new URL("../mcp/", import.meta.url);
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  assert.ok(files.includes("tools-campaigns.ts"));
  for (const name of files) {
    assert.doesNotMatch(readFileSync(new URL(name, dir), "utf8"), OWNER_ONLY, `${name} imports owner-only campaign code`);
  }
});

test("the check catches such an import", () => {
  for (const name of ["freeze", "send", "resend", "suppressions"]) {
    assert.match(`import { x } from "../campaigns/${name}.ts";`, OWNER_ONLY);
  }
  assert.doesNotMatch(`import { x } from "../campaigns/audience.ts";`, OWNER_ONLY);
});
