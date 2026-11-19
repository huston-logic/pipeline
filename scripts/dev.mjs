// `npm run dev` (port 4821) and `npm run preview` (port 4822, fresh state): build out/, apply migrations to the
// local D1 database, then run the Worker with `wrangler dev --local`. Local only: no login, no remote resources.
//   node scripts/dev.mjs --port <number> [--fresh]
// --fresh keeps this run's local database in a new .wrangler/preview-<timestamp> folder, so tests start clean.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "./build.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WRANGLER = join(ROOT, "node_modules", ".bin", "wrangler");

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

export function childEnv(env) {
  return { ...env, WRANGLER_SEND_METRICS: "false" };
}

function hasMigrations() {
  const dir = join(ROOT, "migrations");
  return existsSync(dir) && readdirSync(dir).some((name) => name.endsWith(".sql"));
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

  if (hasMigrations()) {
    const applied = spawnSync(WRANGLER, migrationArgs(options.stateDir), { cwd: ROOT, env, stdio: "inherit" });
    if (applied.status !== 0) {
      console.error("Applying the local migrations failed (see above), so the dev server did not start.");
      process.exit(applied.status ?? 1);
    }
  }

  const child = spawn(WRANGLER, wranglerDevArgs(options), { cwd: ROOT, env, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
