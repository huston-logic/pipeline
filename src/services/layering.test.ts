import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

// The services sit under the MCP layer: src/mcp imports services, never the reverse.
test("nothing under src/services imports from src/mcp", () => {
  const dir = new URL("./", import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
  assert.ok(files.includes("proposal-actions.ts"));
  for (const name of files) {
    const source = readFileSync(new URL(name, dir), "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*\/mcp\//, `${name} imports from mcp/`);
  }
});
