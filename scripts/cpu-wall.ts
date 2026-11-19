// The CPU check's real-runtime half (run 2, task R7; docs/PAID-PLAN.md): the Worker under `wrangler dev --local` on a
// new state folder loaded with the scaled fake copy (scripts/seed-scale.ts), and the end-to-end wall time of each
// request. Local D1 runs in the same process as the Worker, so wall time includes the queries and over-counts CPU.
// Local only: no login, no remote resources. Run `npm run build` first.
//   node scripts/cpu-wall.ts [--runs 20]
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { childEnv, executeFileArgs, migrationArgs, WRANGLER, wranglerDevArgs } from "./dev.mjs";
import { buildScaleSeed, lastBriefHour } from "./seed-scale.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOST = "127.0.0.1";
const PORT = 4823;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const mcp = (body: object): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
});
const tool = (name: string, args: object = {}) => mcp({ method: "tools/call", params: { name, arguments: args } });

const READS: [name: string, path: string, init?: RequestInit][] = [
  ["mcp tools/list", "/mcp", mcp({ method: "tools/list", params: {} })],
  ["mcp pipeline_summary", "/mcp", tool("pipeline_summary")],
  ["mcp preview_rule (stage_followup)", "/mcp", tool("preview_rule", { rule: "ru_scale02" })],
  ["/api/export.json", "/api/export.json"],
  ["/pipeline", "/pipeline"],
  ["/pipeline?view=list", "/pipeline?view=list"],
  ["/pipeline?view=list&stage=replied", "/pipeline?view=list&stage=replied"],
  ["/contacts", "/contacts"],
  ["/companies", "/companies"],
  ["/ (Today)", "/"],
  ["/deals/dl_scale00001", "/deals/dl_scale00001"],
];

async function timed(url: string, init?: RequestInit): Promise<number> {
  const started = performance.now();
  const res = await fetch(url, init);
  await res.arrayBuffer();
  const ms = performance.now() - started;
  if (res.status !== 200) throw new Error(`${url} answered ${res.status}`);
  return ms;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runs = Number(args[args.indexOf("--runs") + 1] ?? 20) || 20;
  // A new temp folder, as tests/e2e/harness.ts does; removed at the end.
  const stateDir = mkdtempSync(join(tmpdir(), "pipeline-scale-"));
  const seedFile = join(stateDir, "scale-seed.sql");
  const seedNow = lastBriefHour(new Date());
  writeFileSync(seedFile, buildScaleSeed(seedNow));
  const env = childEnv(process.env);
  for (const command of [migrationArgs(stateDir), executeFileArgs(stateDir, "seed/defaults.sql"), executeFileArgs(stateDir, seedFile)]) {
    const result = spawnSync(WRANGLER, command, { cwd: ROOT, env, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
    if (result.status !== 0) throw new Error(`wrangler ${command.slice(0, 3).join(" ")} failed:\n${result.stderr}`);
  }
  const child = spawn(WRANGLER, wranglerDevArgs({ port: PORT, stateDir, ip: HOST, testScheduled: true }), {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const base = `http://${HOST}:${PORT}`;
  try {
    for (let i = 0; i < 360; i++) {
      try {
        const res = await fetch(`${base}/robots.txt`);
        await res.arrayBuffer();
        if (res.status === 200) break;
      } catch {
        // Not listening yet.
      }
      await sleep(250);
    }
    console.log(`wrangler dev --local on ${stateDir}; ${runs} timed runs after 3 warm-ups; median wall ms.`);
    for (const [name, path, init] of READS) {
      const times: number[] = [];
      for (let i = 0; i < 3 + runs; i++) {
        const ms = await timed(`${base}${path}`, init);
        if (i >= 3) times.push(ms);
      }
      console.log(`${name} | ${median(times).toFixed(1)}`);
    }
    // The hourly run writes, so it is timed once per state: 50 due with the brief, then 25 left, then none.
    const runs3: [string, number][] = [
      ["hourly run, 50 due, with the brief (once)", seedNow.getTime()],
      ["hourly run, 25 due, no brief (once)", seedNow.getTime() + 3_600_000],
      ["hourly run, nothing due (once)", seedNow.getTime() + 7_200_000],
    ];
    for (const [label, time] of runs3) {
      console.log(`${label} | ${(await timed(`${base}/cdn-cgi/handler/scheduled?time=${time}`)).toFixed(1)}`);
    }
  } finally {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
    await sleep(1500);
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
