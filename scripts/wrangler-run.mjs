// The one way the copy scripts (copies.mjs, import-csv.ts) run an outside command. Commands are arrays whose first
// item is "wrangler" or "npm"; "wrangler" means the repo's own wrangler, or the executable PIPELINE_WRANGLER points
// at (the tests' stub, tests/helpers/wrangler-stub.mjs). Tests pass their own `run` that records instead.
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The program and leading arguments that stand for "wrangler". A .mjs or .js stub runs under this Node. */
export function wranglerCommand(env = process.env) {
  const custom = env.PIPELINE_WRANGLER;
  if (!custom) return [join(ROOT, "node_modules", ".bin", "wrangler")];
  const path = resolve(custom);
  return /\.(mjs|js)$/.test(path) ? [process.execPath, path] : [path];
}

/**
 * @typedef {{ env?: Record<string, string>, capture?: boolean }} RunOptions
 * @typedef {{ status: number, stdout: string, stderr: string }} RunResult
 */

/**
 * Runs `cmd` in the repo root. `capture` collects stdout and stderr (for --json output); otherwise the command shares
 * this terminal, so the owner sees wrangler's progress and can answer its prompts.
 * @param {string[]} cmd
 * @param {RunOptions} [options]
 * @returns {RunResult}
 */
export function run(cmd, { env = {}, capture = false } = {}) {
  const [first, ...rest] = cmd;
  const [program = "", ...args] = first === "wrangler" ? [...wranglerCommand(), ...rest] : cmd;
  const result = spawnSync(program, args, {
    cwd: ROOT,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", ...env },
    stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) return { status: 1, stdout: "", stderr: `${program} could not start: ${result.error.message}` };
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** wrangler's --json output. Anything printed before the JSON (a banner, a warning) is skipped. */
export function parseJsonOutput(text, what = "wrangler") {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/);
    const start = lines.findIndex((line) => /^\s*[[{]/.test(line));
    if (start !== -1) {
      try {
        return JSON.parse(lines.slice(start).join("\n"));
      } catch {
        // fall through to the error below
      }
    }
    throw new Error(`${what} didn't print the JSON expected. Run it yourself to see what it says.`);
  }
}

const SAFE = /^[A-Za-z0-9_./:=@%+,-]+$/;

/** A command as one line a person could paste into a shell. */
export function formatCommand(cmd) {
  return cmd.map((arg) => (SAFE.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`)).join(" ");
}
