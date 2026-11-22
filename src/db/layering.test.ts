import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

// The database layer sits under the services: it never imports from them (the other way round is the rule).
test("src/db imports nothing from src/services", () => {
  const dir = new URL("./", import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  assert.ok(files.includes("db.ts"));
  for (const name of files) {
    const source = readFileSync(new URL(name, dir), "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*\/services\//, `${name} imports from services/`);
  }
});
