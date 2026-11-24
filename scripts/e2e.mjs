// `npm run test:e2e` (after the build): runs tests/e2e/*.test.ts against ONE local Worker instead of one per file.
//   1. Sets up the local database once (migrations, defaults, fake seed) into a template folder.
//   2. Starts a control server on 127.0.0.1 (random port) and runs the test files one at a time, with its address in
//      E2E_CONTROL_URL and the template in E2E_TEMPLATE_STATE (tests/e2e/harness.ts is the client).
//   3. POST /switch: copies the template, starts the Worker on the copy (first call) or points the running Worker at it
//      with wrangler's `unstable_startWorker().setConfig` (later calls), with the dev vars plus the file's own vars.
//      POST /done: the file has finished.
// Local only. Everything it made (Worker, workerd, temp folders) is removed on exit, failure and SIGINT/SIGTERM.
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";
import { setupLocalDatabase, wranglerDevArgs } from "./dev.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOST = "127.0.0.1";
const TEST_GLOB = "tests/e2e/*.test.ts";

const work = mkdtempSync(join(tmpdir(), "pipeline-e2e-run-"));
const template = join(work, "template");
let worker;
let workerPort = 0;
let current; // { stateDir, logFile } of the file being served
let counter = 0;
let httpServer;
let child;
let cleaned = false;

/** The dev vars `npm run dev` passes (`--var NAME:value`), read from wranglerDevArgs so the two never drift. */
function varsFrom(extraVars) {
  const args = wranglerDevArgs({ port: 0, stateDir: "x", extraVars });
  const vars = {};
  args.forEach((arg, i) => {
    if (args[i - 1] !== "--var") return;
    const at = arg.indexOf(":");
    vars[arg.slice(0, at)] = arg.slice(at + 1);
  });
  return vars;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on("error", reject);
    probe.listen(0, HOST, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function workerInput(persist, extraVars) {
  return {
    config: join(ROOT, "wrangler.jsonc"),
    dev: {
      persist,
      server: { hostname: HOST, port: workerPort },
      inspector: false,
      logLevel: "error",
      testScheduled: true,
      watch: false,
      liveReload: false,
      // What the Worker prints goes to the current file's log, which harness output() reads.
      structuredLogsHandler: (log) => {
        if (current) appendFileSync(current.logFile, `${log.message}\n`);
      },
    },
    bindings: Object.fromEntries(Object.entries(varsFrom(extraVars)).map(([name, value]) => [name, { type: "plain_text", value }])),
  };
}

const WORKER_TIMEOUT_MS = 60_000;

function within(promise, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), WORKER_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function switchTo(extraVars, file) {
  const previous = current;
  const n = ++counter;
  const stateDir = join(work, `state-${n}`);
  cpSync(template, stateDir, { recursive: true });
  const logFile = join(work, `output-${n}.log`);
  writeFileSync(logFile, "");
  const next = { stateDir, logFile };
  if (!worker) {
    workerPort = await freePort();
    current = next;
    worker = await unstable_startWorker(workerInput(stateDir, extraVars));
    await within(worker.ready, "The test Worker did not start within 60 seconds.");
  } else {
    const reloaded = new Promise((resolve) => worker.raw.once("reloadComplete", resolve));
    current = next;
    await worker.setConfig(workerInput(stateDir, extraVars));
    await within(reloaded, `The test Worker did not restart for ${file || "this file"} within 60 seconds.`);
  }
  if (previous) rmSync(previous.stateDir, { recursive: true, force: true });
  return { url: `http://${HOST}:${workerPort}`, ...next };
}

function startControl() {
  httpServer = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const input = body ? JSON.parse(body) : {};
        if (req.method === "POST" && req.url === "/switch") {
          const extraVars = Array.isArray(input.extraVars) ? input.extraVars.map(String) : [];
          const result = await switchTo(extraVars, typeof input.file === "string" ? input.file : "");
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
        } else if (req.method === "POST" && req.url === "/done") {
          res.writeHead(200).end("ok");
        } else {
          res.writeHead(404).end("not found");
        }
      } catch (error) {
        res.writeHead(500).end(String(error?.stack ?? error));
      }
    });
  });
  return new Promise((resolve) => httpServer.listen(0, HOST, () => resolve(httpServer.address().port)));
}

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  httpServer?.close();
  try {
    await worker?.dispose();
  } catch {
    // Already gone.
  }
  rmSync(work, { recursive: true, force: true });
}

let code = 1;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    child?.kill(signal);
    cleanup().finally(() => process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 })[signal]));
  });
}
process.on("exit", () => rmSync(work, { recursive: true, force: true }));
for (const [event, what] of [
  ["uncaughtException", "An unexpected error stopped the e2e launcher."],
  ["unhandledRejection", "An unexpected failure stopped the e2e launcher."],
]) {
  process.on(event, (error) => {
    console.error(`${what} Cleaning up the test Worker and temp folders.`);
    console.error(error?.stack ?? error);
    child?.kill("SIGTERM");
    cleanup().finally(() => process.exit(1));
  });
}

try {
  mkdirSync(template);
  setupLocalDatabase({ root: ROOT, stateDir: template, now: Date.now(), stdio: "pipe" });
  const controlPort = await startControl();
  code = await new Promise((resolve) => {
    child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--test", "--test-concurrency=1", TEST_GLOB], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, E2E_CONTROL_URL: `http://${HOST}:${controlPort}`, E2E_TEMPLATE_STATE: template },
    });
    child.on("exit", (status, signal) => resolve(status ?? (signal ? 1 : 0)));
    child.on("error", () => resolve(1));
  });
} catch (error) {
  console.error(error?.stack ?? error);
  code = 1;
} finally {
  await cleanup();
}
process.exit(code);
