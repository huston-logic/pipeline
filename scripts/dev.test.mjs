import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vapidHeaders, vapidKeys } from "../src/push/vapid.ts";
import {
  childEnv,
  devPushVars,
  executeFileArgs,
  migrationArgs,
  parseDevArgs,
  prepareDevSeed,
  setupCommands,
  setupLocalDatabase,
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
  assert.deepEqual(vars, [
    "ENVIRONMENT:development",
    "AUTH_MODE:dev",
    "INTAKE_SECRET:dev-intake-secret",
    "EMAIL_LOG_ADDRESS:log-dev@log.example.test",
  ]);
  assert.ok(!args.some((arg) => /remote|deploy/.test(arg)));
});

test("extra vars (the e2e tests' own values) come after the fixed ones, each as its own --var", () => {
  const args = wranglerDevArgs({ port: 4822, stateDir: ".wrangler/preview-1", extraVars: ["OWNER_EMAILS:owner@example.test"] });
  const vars = args.flatMap((arg, i) => (args[i - 1] === "--var" ? [arg] : []));
  assert.equal(vars.at(-1), "OWNER_EMAILS:owner@example.test");
});

test("dev and preview get a throwaway push key pair, made in memory per start, that the Worker accepts (decision 0030)", async () => {
  const first = devPushVars();
  const second = devPushVars();
  const names = first.map((v) => v.slice(0, v.indexOf(":")));
  assert.deepEqual(names, ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]);
  assert.notDeepEqual(first, second, "a new pair each start");
  const env = Object.fromEntries(first.map((v) => [v.slice(0, v.indexOf(":")), v.slice(v.indexOf(":") + 1)]));
  assert.equal(env.VAPID_SUBJECT, "mailto:dev@example.com");
  const keys = vapidKeys(env);
  assert.ok(keys, "well formed");
  assert.match((await vapidHeaders("https://push.example.net/x", keys, new Date())).Authorization, /^vapid t=/, "the pair signs");

  const args = wranglerDevArgs({ port: 4822, stateDir: ".wrangler/preview-1", extraVars: first });
  const vars = args.flatMap((arg, i) => (args[i - 1] === "--var" ? [arg] : []));
  assert.deepEqual(vars.slice(4), first);
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

test("the e2e options bind to 127.0.0.1 and turn on the test cron route", () => {
  const args = wranglerDevArgs({ port: 4900, stateDir: "/tmp/e2e-state", ip: "127.0.0.1", testScheduled: true });
  assert.deepEqual(args.slice(args.indexOf("--ip"), args.indexOf("--ip") + 2), ["--ip", "127.0.0.1"]);
  assert.ok(args.includes("--test-scheduled"));
  assert.ok(args.includes("--local"));
  const plain = wranglerDevArgs({ port: 4821, stateDir: ".wrangler/state" });
  assert.ok(!plain.includes("--ip") && !plain.includes("--test-scheduled"));
});

test("an absolute state folder (the e2e temp folder) is used as is", () => {
  const root = mkdtempSync(join(tmpdir(), "dev-root-"));
  const state = mkdtempSync(join(tmpdir(), "dev-state-"));
  try {
    const seed = prepareDevSeed(root, state, Date.parse("2026-11-19T18:00:00.000Z"));
    assert.equal(seed.file, join(state, "dev-seed.sql"));
    assert.match(readFileSync(seed.file, "utf8"), /INSERT OR IGNORE INTO contacts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test("setupLocalDatabase runs each setup command in order and stops at the first failure", () => {
  const state = mkdtempSync(join(tmpdir(), "dev-state-"));
  try {
    const ran = [];
    const run = (args) => {
      ran.push(args);
      return { status: 0 };
    };
    setupLocalDatabase({ root: state, stateDir: state, now: Date.parse("2026-11-19T18:00:00.000Z"), run });
    assert.equal(ran.length, 3);
    assert.deepEqual(ran[0], migrationArgs(state));
    assert.equal(prepareDevSeed(state, state, 0).file, null, "the seed is marked loaded");

    const other = join(state, "other");
    const failing = [];
    assert.throws(
      () =>
        setupLocalDatabase({
          root: state,
          stateDir: other,
          now: 0,
          run: (args) => {
            failing.push(args);
            return { status: 1 };
          },
        }),
      /Setting up the local database failed/,
    );
    assert.equal(failing.length, 1);
    assert.ok(prepareDevSeed(state, other, 0).file, "a failed setup leaves the seed unmarked");
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
