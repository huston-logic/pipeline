// "This is my own list" can be turned on only by the board's check step (decision 0038). A structural guard: it reads
// every source file (tests aside) and fails if the option, its form field or the modules that build it are reached
// from anywhere else, under any name, so a later MCP tool or script can't pass it on.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|mts|mjs|js)$/.test(entry.name) && !/\.test\.|\.d\.ts$/.test(entry.name))
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)));
}

const FILES = [...sources("src"), ...sources("scripts")].map((path) => ({ path, text: readFileSync(join(ROOT, path), "utf8") }));

/** Each line of `text` that matches `pattern`, trimmed. */
const linesWith = (text: string, pattern: RegExp) =>
  text
    .split("\n")
    .filter((line) => pattern.test(line))
    .map((line) => line.trim());

/** Where the option may appear, and every line it may appear on there. */
const OWN_LIST_LINES: Record<string, RegExp> = {
  // Declared once, optional.
  "src/import/engine.ts": /^ownList\?: boolean;$/,
  // The modules only read it, to pick the confirmed columns.
  "src/import/modules/people.ts": /confirmedColumns\(options\.ownList, /,
  "src/import/modules/deals.ts": /confirmedColumns\(options\.ownList, /,
  // The check: its own parameter.
  "src/import/own-list.ts": /ownList/,
  // The board plan passes the check step's answer on, and holds it off by default.
  "src/board/import-plan.ts": /ownList: (boolean|false|confirmed\.ownList)\b/,
  // The one place that sets it: the apply post's box, never for a draft the AI app sent rows to (decision 0039).
  "src/board/import-actions.ts": /^ownList: draft\.module !== "tasks" && !draft\.fromMcp && ctx\.form\.get\(OWN_LIST_FIELD\) === "yes",$/,
};

test("own list is set only by the board's apply post, passed only by the board's plan and read only by the modules", () => {
  assert.ok(FILES.length > 100, "every source file was read");
  for (const { path, text } of FILES) {
    const lines = linesWith(text, /\bownList\b/);
    if (lines.length === 0) continue;
    const allowed = OWN_LIST_LINES[path];
    assert.ok(allowed, `${path} mentions ownList; only ${Object.keys(OWN_LIST_LINES).join(", ")} may`);
    for (const line of lines) assert.match(line, allowed, `${path}: ${line}`);
  }
  const ownListUsers = FILES.filter(({ text }) => /\bownList\b/.test(text)).map(({ path }) => path).sort();
  assert.deepEqual(ownListUsers, Object.keys(OWN_LIST_LINES).sort(), "each allowed file still uses it");
});

test("the box's form field, the confirming module and the board plan are reached only from the board import", () => {
  const users = (pattern: RegExp) => FILES.filter(({ text }) => pattern.test(text)).map(({ path }) => path).sort();
  assert.deepEqual(users(/\bown_list\b|\bOWN_LIST_FIELD\b/), ["src/board/import-actions.ts", "src/board/import-kit.ts", "src/board/pages/import-check.ts"]);
  assert.deepEqual(users(/from "[^"]*\/own-list\.ts"/), ["src/import/modules/deals.ts", "src/import/modules/people.ts"]);
  assert.deepEqual(users(/from "[^"]*\/import-plan\.ts"/), ["src/board/import-actions.ts", "src/board/pages/import-check.ts", "src/board/pages/import.ts"]);
  // Nothing in MCP or the scripts reaches the board's import code at all.
  const outside = FILES.filter(({ path }) => path.startsWith("src/mcp/") || path.startsWith("scripts/"));
  for (const { path, text } of outside) {
    assert.doesNotMatch(text, /from "[^"]*\/(import-plan|import-actions|import-kit|own-list)\.ts"/, path);
  }
});
