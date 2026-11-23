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
import type { ContactRow, FieldDefRow } from "../src/db/db.ts";
import { IMPORT_ACTOR, importChange, renderImport } from "../src/import/change.ts";
import { planImport } from "../src/import/plan.ts";
import { commitChange } from "../src/services/change.ts";
import { runRules } from "../src/services/rules.ts";
import { undoChange } from "../src/services/undo.ts";
import { buildScaleSeed, lastBriefHour, SCALE } from "./seed-scale.ts";

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

/** `run` answers the response body's size in bytes. */
type Case = { name: string; run: (db: TimedD1, env: Env) => Promise<number>; reset?: (db: TimedD1) => void | Promise<void> };

const fetchCase = (name: string, request: () => Request): Case => ({
  name,
  run: async (_db, env) => {
    const res = await worker.fetch(request(), env, ctx);
    // Read as bytes: decoding the text would be the client's work, not the Worker's.
    const body = await res.arrayBuffer();
    if (res.status !== 200) throw new Error(`${name} answered ${res.status}: ${new TextDecoder().decode(body).slice(0, 300)}`);
    return body.byteLength;
  },
});

/** Removes what one hourly run wrote, so every timed run finds the same 50 firings due and composes the brief. */
function resetRun(db: TimedD1): void {
  db.exec(`DELETE FROM rule_firings WHERE id NOT LIKE 'rf_scale%';
    DELETE FROM audit_parts WHERE change_id NOT LIKE 'chg_scale%';
    DELETE FROM tasks WHERE id NOT LIKE 'tk_scale%';
    DELETE FROM audit_log WHERE id NOT LIKE 'chg_scale%';
    DELETE FROM briefs WHERE id NOT LIKE 'br_scale%';
    UPDATE settings SET last_brief_at = NULL;`);
}

/**
 * A 2,000-row CSV for `import:contacts --as leads`: 1,600 new businesses, 200 rows for leads already on file (their
 * email, so they merge or match) and 200 that repeat an existing lead's business with no email (possible duplicates).
 */
function leadsCsv(existing: ContactRow[]): string {
  const known = existing.filter((c) => c.id.startsWith("ct_leadscale"));
  const lines = ["name,email,phone,business,source,notes"];
  for (let i = 0; i < 1_600; i++) {
    lines.push(`Import Person ${i},import.person.${i}@example.com,555-03${String(i % 100).padStart(2, "0")},Imported Trading ${i},trade list,Added from a list`);
  }
  for (let i = 0; i < 200; i++) {
    const c = known[i * 7] as ContactRow;
    lines.push(`${c.name},${c.email ?? ""},555-0400,${c.business ?? ""},trade list,`);
  }
  for (let i = 0; i < 200; i++) {
    const c = known[i * 7 + 3] as ContactRow;
    lines.push(`Other Person ${i},,,${c.business ?? ""},trade list,`);
  }
  return `${lines.join("\n")}\n`;
}

let importInput: { existing: ContactRow[]; csv: string; fieldDefs: FieldDefRow[] } | undefined;

/** The import the bulk-change case applied last and nothing has undone yet. */
let appliedImport: string | undefined;

/**
 * What the board's import will do in the Worker (run 5): read the contacts and fields, plan the 2,000-row file and
 * write it as one bulk change. Answers the change id.
 */
async function applyLeadsImport(db: TimedD1, at: Date): Promise<string> {
  if (!importInput) throw new Error("Run the plan case first.");
  const existing = (await db.prepare("SELECT * FROM contacts ORDER BY rowid").all<ContactRow>()).results;
  const fieldDefs = (await db.prepare("SELECT * FROM field_defs ORDER BY rowid").all<FieldDefRow>()).results;
  const plan = planImport(importInput.csv, existing, { asLeads: true, allowDuplicates: false, fieldDefs });
  const input = importChange(plan, existing, at);
  if (input === null || plan.create.length !== 1_600) throw new Error("The import should create 1,600 people.");
  const { changeId } = await commitChange({ db, now: at, ...IMPORT_ACTOR }, input);
  appliedImport = changeId;
  return changeId;
}

/** Undoes the import the last case left applied, so every run starts from the same people. */
async function undoAppliedImport(db: TimedD1, at: Date): Promise<void> {
  if (appliedImport === undefined) return;
  await undoChange({ db, now: at, actor: "owner", tool: "undo_change" }, appliedImport);
  appliedImport = undefined;
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
      return 0;
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
    fetchCase("/pipeline?view=list&stage=replied", () => new Request(`${ORIGIN}/pipeline?view=list&stage=replied`)),
    fetchCase("/contacts", () => new Request(`${ORIGIN}/contacts`)),
    fetchCase("/companies", () => new Request(`${ORIGIN}/companies`)),
    fetchCase("/ (Today)", () => new Request(`${ORIGIN}/`)),
    fetchCase("/deals/dl_scale00001", () => new Request(`${ORIGIN}/deals/dl_scale00001`)),
    fetchCase("/contacts/ct_scale00001", () => new Request(`${ORIGIN}/contacts/ct_scale00001`)),
    fetchCase("/changes", () => new Request(`${ORIGIN}/changes`)),
    // Run 4, task L9: 2,000 leads.
    fetchCase("mcp list_leads (default)", tool("list_leads", {})),
    fetchCase(
      "mcp list_leads (Contacted, referral, quiet 7 days, longest quiet first)",
      tool("list_leads", { statuses: ["contacted"], source: "referral", quietDays: 7, sort: "last_contact" }),
    ),
    fetchCase("mcp list_leads (New)", tool("list_leads", { statuses: ["new"] })),
    fetchCase("mcp list_leads (follow-up due within 7 days)", tool("list_leads", { dueWithinDays: 7 })),
    fetchCase("/leads", () => new Request(`${ORIGIN}/leads`)),
    fetchCase("/leads?status=closed", () => new Request(`${ORIGIN}/leads?status=closed`)),
    fetchCase("mcp search_contacts (leadStatus new)", tool("search_contacts", { query: "ab", leadStatus: ["new"] })),
    fetchCase("mcp preview_rule (the saved lead_followup)", tool("preview_rule", { rule: "ru_scale06" })),
    {
      name: "import plan, 2,000-row CSV as leads (plan only)",
      run: async (db) => {
        if (!importInput) {
          const existing = (await db.prepare("SELECT * FROM contacts ORDER BY rowid").all<ContactRow>()).results;
          const fieldDefs = (await db.prepare("SELECT * FROM field_defs ORDER BY rowid").all<FieldDefRow>()).results;
          importInput = { existing, csv: leadsCsv(existing), fieldDefs };
        }
        const plan = planImport(importInput.csv, importInput.existing, { asLeads: true, allowDuplicates: false, fieldDefs: importInput.fieldDefs });
        if (plan.create.length !== 1_600) throw new Error(`The plan creates ${plan.create.length} people, not 1,600.`);
        return importInput.csv.length;
      },
    },
    {
      name: "import plan + the audited change for all 2,000 rows (no SQL)",
      run: async () => {
        if (!importInput) throw new Error("Run the plan case first.");
        const plan = planImport(importInput.csv, importInput.existing, { asLeads: true, allowDuplicates: false, fieldDefs: importInput.fieldDefs });
        const input = importChange(plan, importInput.existing, briefAt);
        if (input === null) throw new Error("The import has nothing to write.");
        return 0;
      },
    },
    {
      // A bulk change (decision 0035): the whole file renders as statements under D1's 100 KB each.
      name: "import plan + change + SQL for the 2,000-row file (as import:contacts --apply)",
      run: async () => {
        if (!importInput) throw new Error("Run the plan case first.");
        const plan = planImport(importInput.csv, importInput.existing, { asLeads: true, allowDuplicates: false, fieldDefs: importInput.fieldDefs });
        const input = importChange(plan, importInput.existing, briefAt);
        if (input === null) throw new Error("The import has nothing to write.");
        return renderImport(input, briefAt).sql.length;
      },
    },
    {
      // Run 5, task I2: the import in the Worker. Each run first undoes the one before (not timed).
      name: "import plan + bulk change, 2,000 rows (read contacts, plan, one batch)",
      reset: (db) => undoAppliedImport(db, briefAt),
      run: async (db) => {
        await applyLeadsImport(db, briefAt);
        return 0;
      },
    },
    {
      name: "undo of that import (1,600 people removed, one batch)",
      reset: async (db) => {
        await undoAppliedImport(db, briefAt);
        await applyLeadsImport(db, briefAt);
      },
      run: async (db) => {
        if (appliedImport === undefined) throw new Error("No import to undo.");
        const { summary } = await undoChange({ db, now: briefAt, actor: "owner", tool: "undo_change" }, appliedImport);
        if (!/: Removed 1,600 contacts /.test(summary)) {
          throw new Error(`The undo said: ${summary}`);
        }
        appliedImport = undefined;
        return 0;
      },
    },
    {
      name: `runRules, only the lead_followup active (40 due, 25 written) on ${SCALE.leads} leads`,
      reset: (db) => {
        resetRun(db);
        db.exec("UPDATE rules SET active = 0 WHERE id <> 'ru_scale06'");
      },
      run: async (db) => {
        const counts = await runRules(db, briefAt);
        if (counts.fired !== 25) throw new Error(`runRules fired ${counts.fired}, not 25.`);
        return 0;
      },
    },
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
      await c.reset?.(db);
      db.reset();
      console.log = () => {};
      const started = performance.now();
      const cpuStart = process.cpuUsage();
      let bytes: number;
      try {
        bytes = await c.run(db, env);
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
      size = bytes / 1024;
    }
    const f = (n: number) => n.toFixed(1);
    console.log(`${c.name} | ${f(median(wall))} | ${f(median(cpu))} | ${f(median(d1))} | ${f(median(est))} | ${calls} | ${f(size)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
