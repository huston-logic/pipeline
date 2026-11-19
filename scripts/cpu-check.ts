// The CPU check (run 2, task R7; docs/PAID-PLAN.md): calls the Worker's own fetch and scheduled handlers in Node on
// the scaled fake copy (scripts/seed-scale.ts) over the node:sqlite D1 shim, and estimates the Worker CPU of each
// request as process CPU minus the CPU spent inside D1 calls (on Cloudflare the query runs in D1, not in the Worker).
// The JSON decode of each D1 result is kept in, since the Worker does that part. Local only; no network.
//   node --disable-warning=ExperimentalWarning --import ./tests/helpers/workers-runtime.mjs scripts/cpu-check.ts [--runs 20] [--only <name>]
// Prints one line per request: median wall ms, median process CPU ms, median D1 CPU ms, median estimated Worker CPU ms,
// and the D1 calls it made (statements, and how many of them went in batches).
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Env } from "../src/env.ts";
import { CRON_JOBS, runScheduled } from "../src/cron.ts";
import worker from "../src/index.ts";
import { applyMigrations, applySqlFile, SqliteD1, type SqliteStatement } from "../src/db/sqlite-d1.ts";
import { buildScaleSeed, lastBriefHour } from "./seed-scale.ts";

/** A D1 shim that adds up the CPU time spent inside D1 calls, and counts them. */
export class TimedD1 extends SqliteD1 {
  d1CpuUs = 0;
  statements = 0;
  batches = 0;
  batched = 0;
  #inBatch = false;

  reset(): void {
    this.d1CpuUs = 0;
    this.statements = 0;
    this.batches = 0;
    this.batched = 0;
  }

  /** The row copy D1 hands back is serialized here (D1's side) and parsed again (the Worker's side, kept in). */
  #decode(rows: Record<string, unknown>[], started: NodeJS.CpuUsage): Record<string, unknown>[] {
    const text = JSON.stringify(rows);
    const used = process.cpuUsage(started);
    this.d1CpuUs += used.user + used.system;
    return JSON.parse(text) as Record<string, unknown>[];
  }

  override execute(statement: SqliteStatement): ReturnType<SqliteD1["execute"]> {
    if (this.#inBatch) return super.execute(statement);
    this.statements += 1;
    const started = process.cpuUsage();
    const result = super.execute(statement);
    return { ...result, rows: this.#decode(result.rows, started) };
  }

  override async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.batches += 1;
    this.batched += statements.length;
    this.statements += statements.length;
    const started = process.cpuUsage();
    this.#inBatch = true;
    let results: D1Result<T>[];
    try {
      results = await super.batch<T>(statements);
    } finally {
      this.#inBatch = false;
    }
    const text = JSON.stringify(results.map((r) => r.results));
    const used = process.cpuUsage(started);
    this.d1CpuUs += used.user + used.system;
    const decoded = JSON.parse(text) as T[][];
    return results.map((r, i) => ({ ...r, results: decoded[i] ?? [] }));
  }
}

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const ORIGIN = "http://localhost:4821";

function envFor(db: TimedD1): Env {
  return {
    ENVIRONMENT: "development",
    AUTH_MODE: "dev",
    DB: db,
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  } as unknown as Env;
}

/** Node's Request drops the Host header, which the MCP handler checks; workerd always sets it. */
function withHost(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.set("Host", new URL(request.url).host);
  Object.defineProperty(request, "headers", { value: headers });
  return request;
}

const mcpRequest = (body: object) =>
  withHost(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
    }),
  );

const tool = (name: string, args: object = {}) => () => mcpRequest({ method: "tools/call", params: { name, arguments: args } });

type Case = { name: string; run: (db: TimedD1, env: Env) => Promise<string>; reset?: (db: TimedD1) => void };

const fetchCase = (name: string, request: () => Request): Case => ({
  name,
  run: async (_db, env) => {
    const res = await worker.fetch(request(), env, ctx);
    const body = await res.text();
    if (res.status !== 200) throw new Error(`${name} answered ${res.status}: ${body.slice(0, 300)}`);
    return body;
  },
});

/** Removes what one hourly run wrote, so every timed run finds the same 50 firings due and composes the brief. */
function resetRun(db: TimedD1): void {
  db.exec(`DELETE FROM rule_firings WHERE id NOT LIKE 'rf_scale%';
    DELETE FROM tasks WHERE id NOT LIKE 'tk_scale%';
    DELETE FROM audit_log WHERE id NOT LIKE 'chg_scale%';
    DELETE FROM briefs WHERE id NOT LIKE 'br_scale%';
    UPDATE settings SET last_brief_at = NULL;`);
}

function cases(briefAt: Date): Case[] {
  const scheduled = (name: string, at: Date, jobs = CRON_JOBS): Case => ({
    name,
    reset: resetRun,
    run: async (_db, env) => {
      if (jobs === CRON_JOBS) {
        await worker.scheduled({ scheduledTime: at.getTime(), cron: "0 * * * *", noRetry() {} } as ScheduledController, env, ctx);
      } else {
        await runScheduled(env, at, jobs);
      }
      return "";
    },
  });
  const rulesOnly = CRON_JOBS.filter(([name]) => name === "rules");
  const briefOnly = CRON_JOBS.filter(([name]) => name === "brief");
  return [
    fetchCase("mcp initialize", () =>
      mcpRequest({ method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cpu-check", version: "1" } } }),
    ),
    fetchCase("mcp tools/list", () => mcpRequest({ method: "tools/list", params: {} })),
    fetchCase("mcp pipeline_summary", tool("pipeline_summary")),
    fetchCase("mcp preview_rule (stage_followup)", tool("preview_rule", { rule: "ru_scale02" })),
    fetchCase("mcp list_deals (open)", tool("list_deals", {})),
    fetchCase("mcp recent_changes", tool("recent_changes", {})),
    scheduled("hourly run, 50 due, with the brief", briefAt),
    scheduled("hourly run, 50 due, no brief", new Date(briefAt.getTime() + 3_600_000), rulesOnly),
    scheduled("daily brief alone", briefAt, briefOnly),
    fetchCase("/api/export.json", () => new Request(`${ORIGIN}/api/export.json`)),
    fetchCase("/pipeline", () => new Request(`${ORIGIN}/pipeline`)),
    fetchCase("/pipeline?view=list", () => new Request(`${ORIGIN}/pipeline?view=list`)),
    fetchCase("/contacts", () => new Request(`${ORIGIN}/contacts`)),
    fetchCase("/companies", () => new Request(`${ORIGIN}/companies`)),
    fetchCase("/ (Today)", () => new Request(`${ORIGIN}/`)),
    fetchCase("/deals/dl_scale00001", () => new Request(`${ORIGIN}/deals/dl_scale00001`)),
    fetchCase("/contacts/ct_scale00001", () => new Request(`${ORIGIN}/contacts/ct_scale00001`)),
    fetchCase("/changes", () => new Request(`${ORIGIN}/changes`)),
  ];
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runs = Number(args[args.indexOf("--runs") + 1] ?? 20) || 20;
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
  const seedNow = lastBriefHour(new Date());

  const db = new TimedD1();
  await applyMigrations(db);
  applySqlFile(db, "seed/defaults.sql");
  db.exec(buildScaleSeed(seedNow));
  const env = envFor(db);
  const quiet = console.log;

  console.log(`Scaled copy seeded at ${seedNow.toISOString()}; ${runs} timed runs after 5 warm-ups; medians.`);
  console.log("request | wall ms | process CPU ms | D1 CPU ms | est. Worker CPU ms | D1 statements (in batches) | body KB");
  for (const c of cases(seedNow)) {
    if (only !== undefined && !c.name.includes(only)) continue;
    const wall: number[] = [];
    const cpu: number[] = [];
    const d1: number[] = [];
    const est: number[] = [];
    let calls = "";
    let size = 0;
    for (let i = 0; i < 5 + runs; i++) {
      c.reset?.(db);
      db.reset();
      console.log = () => {};
      const started = performance.now();
      const cpuStart = process.cpuUsage();
      let body: string;
      try {
        body = await c.run(db, env);
      } finally {
        console.log = quiet;
      }
      const used = process.cpuUsage(cpuStart);
      const ms = performance.now() - started;
      if (i < 5) continue;
      const total = (used.user + used.system) / 1000;
      wall.push(ms);
      cpu.push(total);
      d1.push(db.d1CpuUs / 1000);
      est.push(total - db.d1CpuUs / 1000);
      calls = `${db.statements} (${db.batched} in ${db.batches} batches)`;
      size = Buffer.byteLength(body) / 1024;
    }
    const f = (n: number) => n.toFixed(1);
    console.log(`${c.name} | ${f(median(wall))} | ${f(median(cpu))} | ${f(median(d1))} | ${f(median(est))} | ${calls} | ${f(size)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
