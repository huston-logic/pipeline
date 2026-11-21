// `npm run dev` (port 4821) and `npm run preview` (port 4822, fresh state): build out/, set up the local D1 database
// (migrations, then seed/defaults.sql, then fake seed data on a new state folder), then run the Worker with
// `wrangler dev --local`. Local only: no login, no remote resources.
//   node scripts/dev.mjs --port <number> [--fresh]
// --fresh keeps this run's local database in a new .wrangler/preview-<timestamp> folder, so tests start clean.
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_TZ } from "../src/time.ts";
import { build } from "./build.mjs";
import { buildDevSeed } from "./seed-dev.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const WRANGLER = join(ROOT, "node_modules", ".bin", "wrangler");
const DEFAULTS_SQL = "seed/defaults.sql";
const SEED_FILE = "dev-seed.sql";
// Written once the fake seed is in a state folder, so `npm run dev` restarts keep the data as it is.
const SEED_MARKER = ".dev-seed-loaded";

export function parseDevArgs(argv, now) {
  let port;
  let fresh = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") port = Number(argv[++i]);
    else if (arg === "--fresh") fresh = true;
    else throw new Error(`Unknown option "${arg}". dev.mjs takes --port <number> and --fresh.`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Pass the port as --port <number>, for example --port 4821.");
  }
  return { port, stateDir: fresh ? `.wrangler/preview-${now}` : ".wrangler/state" };
}

/**
 * `ip` binds to one address (the e2e tests use 127.0.0.1); `testScheduled` adds wrangler's test route for the cron
 * handler (`/cdn-cgi/handler/scheduled`); `extraVars` adds `NAME:value` pairs, each as its own `--var`.
 * @param {{ port: number | string, stateDir: string, ip?: string, testScheduled?: boolean, extraVars?: string[] }} options
 */
export function wranglerDevArgs({ port, stateDir, ip, testScheduled = false, extraVars = [] }) {
  return [
    "dev",
    "--local",
    "--port",
    String(port),
    ...(ip ? ["--ip", ip] : []),
    ...(testScheduled ? ["--test-scheduled"] : []),
    "--persist-to",
    stateDir,
    "--var",
    "ENVIRONMENT:development",
    "--var",
    "AUTH_MODE:dev",
    // A fake value so /intake can be tried locally; real secrets are set with `wrangler secret put` (docs/SECRETS.md).
    "--var",
    "INTAKE_SECRET:dev-intake-secret",
    // A fake log address, so the Email logging page shows its set-up state locally (decision 0031).
    "--var",
    "EMAIL_LOG_ADDRESS:log-dev@log.example.test",
    ...extraVars.flatMap((value) => ["--var", value]),
    // No keyboard shortcuts panel, which would wait for a TTY in CI.
    "--show-interactive-dev-session=false",
  ];
}

/**
 * A throwaway web push key pair for `npm run dev` and `npm run preview` (decision 0030), made in memory on each start
 * and passed only as `--var`, never written to a file: the Notifications page then shows its keyed state locally, for
 * the accessibility, Lighthouse and screenshot runs. A real copy's keys come from scripts/make-vapid-keys.mjs.
 */
export function devPushVars() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pub = publicKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, "base64url"), Buffer.from(pub.y, "base64url")]);
  return [
    `VAPID_PUBLIC_KEY:${point.toString("base64url")}`,
    `VAPID_PRIVATE_KEY:${privateKey.export({ format: "jwk" }).d}`,
    "VAPID_SUBJECT:mailto:dev@example.com",
  ];
}

export function migrationArgs(stateDir) {
  return ["d1", "migrations", "apply", "DB", "--local", "--persist-to", stateDir];
}

export function executeFileArgs(stateDir, file) {
  return ["d1", "execute", "DB", "--local", "--persist-to", stateDir, "--file", file, "--yes"];
}

/** The wrangler commands that set up the local database, in order. `seedFile` is null when the seed is loaded. */
export function setupCommands(stateDir, seedFile) {
  const commands = [migrationArgs(stateDir), executeFileArgs(stateDir, DEFAULTS_SQL)];
  if (seedFile) commands.push(executeFileArgs(stateDir, seedFile));
  return commands;
}

/**
 * Writes the fake seed into the state folder unless it was already loaded there. Returns its path relative to
 * `root` (null when there is nothing to load) and `markLoaded()`, to call once wrangler has loaded it.
 */
export function prepareDevSeed(root, stateDir, now) {
  const dir = resolve(root, stateDir);
  const marker = join(dir, SEED_MARKER);
  if (existsSync(marker)) return { file: null, markLoaded() {} };
  mkdirSync(dir, { recursive: true });
  const file = join(stateDir, SEED_FILE);
  writeFileSync(resolve(root, file), buildDevSeed(new Date(now), DEFAULT_TZ));
  return { file, markLoaded: () => writeFileSync(marker, `${new Date(now).toISOString()}\n`) };
}

export function childEnv(env) {
  return { ...env, WRANGLER_SEND_METRICS: "false" };
}

/**
 * Migrations, defaults and (on a new state folder) the fake seed, each as its own wrangler command run by `run`
 * (spawnSync by default). Throws on the first failure. Used by `npm run dev`, `npm run preview` and tests/e2e.
 */
export function setupLocalDatabase({
  root = ROOT,
  stateDir,
  now,
  env = childEnv(process.env),
  stdio = "inherit",
  run = (args) => spawnSync(WRANGLER, args, { cwd: root, env, stdio, encoding: "utf8" }),
}) {
  const seed = prepareDevSeed(root, stateDir, now);
  for (const args of setupCommands(stateDir, seed.file)) {
    const result = run(args);
    if (result.status !== 0) {
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      throw new Error(`Setting up the local database failed (wrangler ${args.slice(0, 3).join(" ")}).${output ? `\n${output}` : ""}`);
    }
  }
  seed.markLoaded();
}

function main() {
  let options;
  try {
    options = parseDevArgs(process.argv.slice(2), Date.now());
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  build();
  const env = childEnv(process.env);

  try {
    setupLocalDatabase({ stateDir: options.stateDir, now: Date.now(), env });
  } catch (error) {
    console.error(`${error.message}\nSee the output above; the dev server did not start.`);
    process.exit(1);
  }

  const child = spawn(WRANGLER, wranglerDevArgs({ ...options, extraVars: devPushVars() }), { cwd: ROOT, env, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
