// End-to-end harness: the real Worker, run locally by wrangler, with a real local D1 database (migrations, defaults
// and the fake seed, set up the way `npm run dev` does it). Local only: no login, no remote resources.
// The database is set up once per run into a template folder (`templateState()`); each test file gets a fresh copy
// (`prepareState()`). Always `await server.stop()` in `after()`.
// `npm run test:e2e` (scripts/e2e.mjs) builds out/ once, makes the template, starts ONE Worker and runs the files one
// at a time (`--test-concurrency=1`). `startDevServer()` then asks the launcher's control server (E2E_CONTROL_URL) to
// point that Worker at a fresh copy plus the file's extra vars; `stop()` says the file is done. Without
// E2E_CONTROL_URL (one file run on its own with `node --test`), `startDevServer()` starts its own `wrangler dev`.
import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv, setupLocalDatabase, WRANGLER, wranglerDevArgs } from "../../scripts/dev.mjs";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));

export interface DevServer {
  /** http://127.0.0.1:<port> */
  url: string;
  /** The temp state folder (wrangler's --persist-to). */
  stateDir: string;
  /** Runs the Worker's scheduled() handler once through wrangler's test route. */
  runCron(): Promise<void>;
  /** The last lines wrangler and the Worker printed. */
  output(): string;
  /** Stops wrangler and workerd (the whole process group) and removes the temp folder. */
  stop(): Promise<void>;
}

const HOST = "127.0.0.1";
const START_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 10_000;
const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, HOST, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port > 0 ? resolvePort(port) : reject(new Error("No free port found."))));
    });
  });
}

let lazyTemplate: string | undefined;

/**
 * The template state folder: the local database set up once (migrations, defaults, the fake seed). `npm run test:e2e`
 * makes it and passes its path in E2E_TEMPLATE_STATE; a single file run on its own builds one here, once per process,
 * and removes it when the process ends.
 */
export function templateState(): string {
  const given = process.env.E2E_TEMPLATE_STATE;
  if (given) return given;
  if (!lazyTemplate) {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-e2e-template-"));
    try {
      setupLocalDatabase({ root: ROOT, stateDir: dir, now: Date.now(), stdio: "pipe" });
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
    lazyTemplate = dir;
  }
  return lazyTemplate;
}

/** A new temp state folder holding a fresh copy of the template database. */
export function prepareState(prefix = "pipeline-e2e-"): string {
  const stateDir = mkdtempSync(join(tmpdir(), prefix));
  try {
    cpSync(templateState(), stateDir, { recursive: true });
  } catch (error) {
    rmSync(stateDir, { recursive: true, force: true });
    throw error;
  }
  return stateDir;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** True while any process in the group is alive. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

async function stopGroup(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  killGroup(pid, "SIGTERM");
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (groupAlive(pid) && Date.now() < deadline) await sleep(100);
  if (groupAlive(pid)) killGroup(pid, "SIGKILL");
  while (groupAlive(pid)) await sleep(50);
}

async function waitUntilReady(url: string, child: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`wrangler dev exited before it was ready:\n${output()}`);
    }
    try {
      const res = await fetch(`${url}/robots.txt`);
      await res.body?.cancel();
      if (res.status === 200) return;
    } catch {
      // Not listening yet.
    }
    await sleep(250);
  }
  throw new Error(`wrangler dev was not ready after ${START_TIMEOUT_MS / 1000}s:\n${output()}`);
}

/** The launcher's shared Worker, pointed at a fresh database copy for this file (scripts/e2e.mjs). */
async function sharedServer(control: string, extraVars: string[]): Promise<DevServer> {
  const call = async (path: string, body: unknown) => {
    const res = await fetch(`${control}${path}`, { method: "POST", body: JSON.stringify(body) });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`The e2e launcher answered ${res.status} for ${path}: ${text}`);
    return JSON.parse(text) as { url: string; stateDir: string; logFile: string };
  };
  const { url, stateDir, logFile } = await call("/switch", { extraVars });
  const output = () => {
    try {
      return readFileSync(logFile, "utf8");
    } catch {
      return "";
    }
  };
  let stopped: Promise<void> | undefined;
  return {
    url,
    stateDir,
    output,
    stop: () =>
      (stopped ??= call("/done", {}).then(
        () => undefined,
        () => undefined,
      )),
    async runCron() {
      const res = await fetch(`${url}/cdn-cgi/handler/scheduled`);
      const body = await res.text();
      if (res.status !== 200) throw new Error(`The scheduled handler answered ${res.status}: ${body}`);
    },
  };
}

/** `extraVars` are `NAME:value` pairs passed as `--var` on top of the dev ones, for one test file's server. */
export async function startDevServer({ extraVars = [] }: { extraVars?: string[] } = {}): Promise<DevServer> {
  if (!existsSync(join(ROOT, "out", "index.html"))) {
    throw new Error("out/ has not been built. Run the end-to-end tests with `npm run test:e2e`, which builds it first.");
  }
  const control = process.env.E2E_CONTROL_URL;
  if (control) return sharedServer(control, extraVars);
  const stateDir = prepareState();
  const port = await freePort();
  const url = `http://${HOST}:${port}`;
  // A process group of its own, so stop() reaches workerd as well as wrangler.
  const child = spawn(WRANGLER, wranglerDevArgs({ port, stateDir, ip: HOST, testScheduled: true, extraVars }), {
    cwd: ROOT,
    env: childEnv(process.env),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const lines: string[] = [];
  const keep = (chunk: Buffer) => {
    lines.push(chunk.toString());
    if (lines.length > 200) lines.shift();
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  // If the test process ends without stop(), or is interrupted, the server must not outlive it.
  const onExit = () => {
    if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {
      // Best effort while the process is ending.
    }
  };
  const onSignal = (signal: NodeJS.Signals) => {
    onExit();
    removeHandlers();
    // Re-raised with our handlers gone, so the default action (or the next listener) ends the process as before.
    process.kill(process.pid, signal);
  };
  const removeHandlers = () => {
    process.off("exit", onExit);
    for (const signal of SIGNALS) process.off(signal, onSignal);
  };
  process.on("exit", onExit);
  for (const signal of SIGNALS) process.once(signal, onSignal);

  let stopped: Promise<void> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      removeHandlers();
      await stopGroup(child);
      rmSync(stateDir, { recursive: true, force: true });
    })());

  try {
    await waitUntilReady(url, child, () => lines.join(""));
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    url,
    stateDir,
    stop,
    output: () => lines.join(""),
    async runCron() {
      const res = await fetch(`${url}/cdn-cgi/handler/scheduled`);
      const body = await res.text();
      if (res.status !== 200) throw new Error(`The scheduled handler answered ${res.status}: ${body}`);
    },
  };
}
