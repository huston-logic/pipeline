import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { boardChanged } from "./board-changed.mjs";

const pr = (files, labels = []) => boardChanged({ event: "pull_request", labels, files });

test("anything but a pull request runs the board checks", () => {
  assert.equal(boardChanged({ event: "push", labels: [], files: ["docs/x.md"] }).board, true);
  assert.equal(boardChanged({ event: "workflow_dispatch", labels: [], files: [] }).board, true);
});

test("the full-audit label runs them", () => {
  assert.equal(pr(["docs/x.md"], ["full-audit"]).board, true);
});

test("unknown files never skip", () => {
  assert.equal(pr(null).board, true);
});

test("each board path runs them", () => {
  for (const p of [
    "src/board/pages/today.ts",
    "src/index.ts",
    "public/board.css",
    "public/icons/icon-192.png",
    "scripts/build.mjs",
    "scripts/dev.mjs",
    "scripts/seed-dev.ts",
    "scripts/lighthouse.mjs",
    "scripts/lighthouse-summary.mjs",
    "lighthouserc.cjs",
    "playwright.config.ts",
    "playwright.screenshots.config.ts",
    "tests/a11y/board.spec.ts",
    "migrations/0019_x.sql",
    "seed/defaults.sql",
    "wrangler.jsonc",
    "package.json",
    "package-lock.json",
    ".github/workflows/ci.yml",
  ]) {
    assert.equal(pr(["docs/a.md", p]).board, true, p);
  }
});

test("docs, .claude, unit and e2e tests and other scripts do not", () => {
  const files = ["docs/a.md", ".claude/hooks/x.mjs", "src/board/x.test.ts", "tests/e2e/mcp.test.ts", "scripts/copies.mjs", "scripts/check-fast.mjs"];
  const r = pr(files);
  assert.equal(r.board, false);
  assert.equal(r.reason, "no board file changed (6 files)");
});

test("src/mcp alone does not, src/**/*.test.ts alone does not", () => {
  assert.equal(pr(["src/mcp/tools-read.ts", "src/mcp/server.test.ts"]).board, false);
  assert.equal(pr(["src/services/deals.test.ts", "src/board/pages/today.test.ts"]).board, false);
  assert.equal(pr(["src/mcp/tools-read.ts", "src/services/deals.ts"]).board, true);
});

test("a file moved out of a board folder still counts: the old path is in the list", () => {
  // With --no-renames git lists both the deleted old path and the new one.
  assert.equal(pr(["public/board.css", "docs/board.css"]).board, true);
  assert.equal(pr(["docs/board.css"]).board, false);
});

test("an empty change list does not", () => {
  assert.equal(pr([]).board, false);
});

const script = fileURLToPath(new URL("./board-changed.mjs", import.meta.url));
function run(env) {
  return spawnSync(process.execPath, [script], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
}

test("the command line prints board=true when BASE_SHA is missing", () => {
  const r = run({ EVENT_NAME: "pull_request", BASE_SHA: "", LABELS: "" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "board=true");
  assert.ok(r.stderr.length > 0);
});

test("the command line prints board=true when git cannot diff, and for a push", () => {
  assert.equal(run({ EVENT_NAME: "pull_request", BASE_SHA: "0000000000000000000000000000000000000000", LABELS: "" }).stdout.trim(), "board=true");
  assert.equal(run({ EVENT_NAME: "push" }).stdout.trim(), "board=true");
});

test("the command line reads comma-separated labels", () => {
  assert.equal(run({ EVENT_NAME: "pull_request", BASE_SHA: "", LABELS: "a,full-audit" }).stdout.trim(), "board=true");
});
