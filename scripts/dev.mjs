// `npm run dev` (port 4821) and `npm run preview` (port 4822, fresh state): build out/, set up the local D1 database
// (migrations, then seed/defaults.sql, then fake seed data on a new state folder), then run the Worker with
// `wrangler dev --local`. Local only: no login, no remote resources.
//   node scripts/dev.mjs --port <number> [--fresh]
// --fresh keeps this run's local database in a new .wrangler/preview-<timestamp> folder, so tests start clean.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_TZ } from "../src/time.ts";
import { build } from "./build.mjs";
import { buildDevSeed } from "./seed-dev.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WRANGLER = join(ROOT, "node_modules", ".bin", "wrangler");
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

export function wranglerDevArgs({ port, stateDir }) {
  return [
    "dev",
    "--local",
    "--port",
    String(port),
    "--persist-to",
    stateDir,
    "--var",
    "ENVIRONMENT:development",
    "--var",
    "AUTH_MODE:dev",
    // No keyboard shortcuts panel, which would wait for a TTY in CI.
    "--show-interactive-dev-session=false",
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
  const dir = join(root, stateDir);
  const marker = join(dir, SEED_MARKER);
  if (existsSync(marker)) return { file: null, markLoaded() {} };
  mkdirSync(dir, { recursive: true });
  const file = join(stateDir, SEED_FILE);
  writeFileSync(join(root, file), buildDevSeed(new Date(now), DEFAULT_TZ));
  return { file, markLoaded: () => writeFileSync(marker, `${new Date(now).toISOString()}\n`) };
}

export function childEnv(env) {
  return { ...env, WRANGLER_SEND_METRICS: "false" };
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

  const seed = prepareDevSeed(ROOT, options.stateDir, Date.now());
  for (const args of setupCommands(options.stateDir, seed.file)) {
    const result = spawnSync(WRANGLER, args, { cwd: ROOT, env, stdio: "inherit" });
    if (result.status !== 0) {
      console.error("Setting up the local database failed (see above), so the dev server did not start.");
      process.exit(result.status ?? 1);
    }
  }
  seed.markLoaded();

  const child = spawn(WRANGLER, wranglerDevArgs(options), { cwd: ROOT, env, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
