import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  childEnv,
  executeFileArgs,
  migrationArgs,
  parseDevArgs,
  prepareDevSeed,
  setupCommands,
  wranglerDevArgs,
} from "./dev.mjs";

test("parses --port and uses the shared dev state folder by default", () => {
  assert.deepEqual(parseDevArgs(["--port", "4821"], 0), { port: 4821, stateDir: ".wrangler/state" });
});

test("--fresh uses a new timestamped state folder", () => {
  assert.deepEqual(parseDevArgs(["--port", "4822", "--fresh"], 1763500000000), {
    port: 4822,
    stateDir: ".wrangler/preview-1763500000000",
  });
});

test("rejects a missing or bad port and unknown flags", () => {
  assert.throws(() => parseDevArgs([], 0), /--port/);
  assert.throws(() => parseDevArgs(["--port", "abc"], 0), /--port/);
  assert.throws(() => parseDevArgs(["--port", "4821", "--remote"], 0), /--remote/);
});

test("wrangler dev runs local only, in development mode, without prompts", () => {
  const args = wranglerDevArgs({ port: 4822, stateDir: ".wrangler/preview-1" });
  assert.equal(args[0], "dev");
  for (const flag of ["--local", "--show-interactive-dev-session=false"]) assert.ok(args.includes(flag), flag);
  assert.deepEqual(args.slice(args.indexOf("--port"), args.indexOf("--port") + 2), ["--port", "4822"]);
  assert.deepEqual(args.slice(args.indexOf("--persist-to"), args.indexOf("--persist-to") + 2), [
    "--persist-to",
    ".wrangler/preview-1",
  ]);
  const vars = args.flatMap((arg, i) => (args[i - 1] === "--var" ? [arg] : []));
  assert.deepEqual(vars, ["ENVIRONMENT:development", "AUTH_MODE:dev"]);
  assert.ok(!args.some((arg) => /remote|deploy/.test(arg)));
});

test("migrations apply to the local database in the same state folder", () => {
  assert.deepEqual(migrationArgs(".wrangler/state"), [
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--persist-to",
    ".wrangler/state",
  ]);
});

test("the child environment turns wrangler metrics off and keeps the rest", () => {
  const env = childEnv({ PATH: "/usr/bin", HOME: "/home/fake" });
  assert.equal(env.WRANGLER_SEND_METRICS, "false");
  assert.equal(env.PATH, "/usr/bin");
});

test("SQL files run against the same local database, without prompts", () => {
  assert.deepEqual(executeFileArgs(".wrangler/state", "seed/defaults.sql"), [
    "d1",
    "execute",
    "DB",
    "--local",
    "--persist-to",
    ".wrangler/state",
    "--file",
    "seed/defaults.sql",
    "--yes",
  ]);
});

test("setup applies migrations, then the defaults, then the fake seed when there is one", () => {
  const dir = ".wrangler/preview-1";
  assert.deepEqual(setupCommands(dir, ".wrangler/preview-1/dev-seed.sql"), [
    migrationArgs(dir),
    executeFileArgs(dir, "seed/defaults.sql"),
    executeFileArgs(dir, ".wrangler/preview-1/dev-seed.sql"),
  ]);
  assert.deepEqual(setupCommands(dir, null), [migrationArgs(dir), executeFileArgs(dir, "seed/defaults.sql")]);
  for (const args of setupCommands(dir, "x.sql")) {
    assert.ok(args.includes("--local"));
    assert.ok(!args.some((arg) => /remote|deploy/.test(arg)));
  }
});

test("the fake seed is written for a new state folder only, so restarts do not reload it", () => {
  const root = mkdtempSync(join(tmpdir(), "dev-seed-"));
  try {
    const now = Date.parse("2026-11-19T18:00:00.000Z");
    const seed = prepareDevSeed(root, "state", now);
    assert.equal(seed.file, join("state", "dev-seed.sql"));
    assert.match(readFileSync(join(root, seed.file), "utf8"), /INSERT OR IGNORE INTO contacts/);

    // Not loaded yet (for example the run failed): written again.
    assert.ok(prepareDevSeed(root, "state", now).file);

    seed.markLoaded();
    assert.equal(prepareDevSeed(root, "state", now).file, null);
    assert.ok(prepareDevSeed(root, "other", now).file, "another state folder gets its own seed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
