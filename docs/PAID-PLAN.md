# What needs the Workers Paid plan

The engine is meant to run on Cloudflare's free plan. This file lists everything that needs the $5/month Workers Paid
plan, with the reason, and the free-plan limits to watch. Each task adds to it.

## Needed so far

Nothing. Every part built so far runs on the free plan. One exception on a big copy: past a few hundred deals with
their history, the board's "Download everything (JSON)" goes over the free plan's CPU limit (see "CPU check" below);
such a copy exports from the Mac with `npm run copies:export` instead, or moves to Workers Paid.

Production sign-in (decision 0006) adds two things, both free: a KV namespace (`OAUTH_KV`, on the Workers free plan:
100,000 reads and 1,000 writes a day, far more than one owner's sign-ins and `/mcp` token checks use) and Cloudflare
Access (Zero Trust Free covers up to 50 users; a copy needs one or two).

## Limits to watch

| Limit (free plan) | Where we are | Risk |
|---|---|---|
| Worker size: 3 MB compressed | 1.35 MB raw, about 0.24 MB gzip (the `wrangler dev` bundle, measured 2026-11-18 after the MCP endpoint, task 4), plus about 0.27 MB raw / 0.07 MB gzip for `workers-oauth-provider` (task 10; the package's own file size, the bundle not re-measured) | Low. The MCP SDK, `agents` and `zod` are most of it. |
| KV (free plan): 100,000 reads, 1,000 writes, 1,000 deletes and 1,000 lists a day | Every `/mcp` request reads its token record (one read); a sign-in writes a few records; a token refresh (about hourly while an AI app is in use) writes a few | Low for one owner. Many connected AI apps refreshing all day could approach 1,000 writes; then Workers Paid lifts it. **Abuse risk:** `/register` and `/authorize` write to KV before anyone signs in, so a flood could use up the day's writes and block the owner's sign-ins until the next day. Fixed in task 11 with the `OAUTH_RATE_LIMIT` binding (20 per minute per IP on those two paths; Rate Limiting is free) and a `HEAD /authorize` that writes nothing (decision 0006). A flood from many IPs could still spend writes; if that happens, Workers Paid lifts the KV limit. |
| CPU time: 10 ms per request | Measured locally on a 2,000-deal fake copy, not yet in production: every request but the export fits, the largest at about 7 ms (see "CPU check" below) | **Medium.** Every `/mcp` request builds a fresh MCP server and then runs the tool; JSON Schemas for `tools/list` are converted once per isolate (decision 0020). The tools that list every open deal (`pipeline_summary`, `list_deals`) grow with the pipeline and would reach 10 ms at about 2,000 open deals. If requests fail with "exceeded CPU", that is the sign to move the copy to Workers Paid (30 s default CPU limit). |
| Cron Triggers | One hourly trigger (`0 * * * *`: the rules run, then the daily brief; tasks 6 and 7). Cron Triggers are included in the free plan (up to 5 per account) | Low for the trigger itself. |
| CPU time of the hourly run (10 ms per invocation on the free plan) | Measured locally: about 2 ms with 50 firings due (25 written), about 7 ms on the hour that also composes the brief, on 1,200 open deals (see "CPU check" below) | **Medium as a pipeline grows.** Each run reads every open deal once, the fire keys of open deals and the active rules, then checks each deal against each stage rule: about open deals × stage rules comparisons, plus one D1 batch per new task. A one-person pipeline (tens to a few hundred open deals, a handful of rules) is small; thousands of open deals with many rules, or a run that has to create many tasks at once (for example right after a new rule is added), could go over 10 ms. Failed firings are retried on the next run, so going over is a delay, not lost work. A firing that cannot be written is counted, not thrown, so watch for `failed` above 0 in the `cron_rules_done` log line (several runs in a row), as well as for `cron_rules_failed` or "exceeded CPU"; those are the signs to move the copy to Workers Paid. |
| Subrequests and D1 queries per invocation (free plan: 50 of each) | One batch per firing in the hourly run, plus the reads and the brief: measured, 37 D1 calls holding 112 statements on the hour of the brief (see "CPU check" below) | **Unknown until confirmed:** if Cloudflare counts each statement in a batch as a query, a run that writes 25 firings is over 50. Otherwise low since the final review: a run writes at most 25 firings (`MAX_FIRINGS_PER_RUN`, decision 0010), so a catch-up after a new rule cannot use up the invocation and starve the brief that runs after it. The rest fire next hour; `deferred` above 0 in `cron_rules_done` for many hours in a row means more tasks are due each hour than one run writes. |
| CPU time of `/api/export.json` (10 ms per request) | Reads and serializes every row of every table, `audit_log` included; streamed table by table since run 2 (decision 0020). Measured locally: about 63 ms for an 18 MB export of the 2,000-deal copy, about 3.5 ms per MB | **High on a big copy, growing without bound.** The export fits the free plan only up to about 2 to 3 MB (a few hundred deals with their history). For a large copy, export with `npm run copies:export -- --copy <name>` from the Mac instead (no Worker CPU limit), or move the copy to Workers Paid. |
| CPU time of `preview_rule` (10 ms per request) | Reads every non-archived deal and the activities of the last 30 days plus the rule's own days, through an index (decisions 0010 and 0020). Measured locally: about 7 ms for a 7-day rule on the 2,000-deal copy | **Medium on a big pipeline.** It grows with the number of deals and with a few weeks' activity (a long rule, 365 days, reads a year). If previews fail with "exceeded CPU", that is the sign for Workers Paid. |
| CPU time of the daily brief (part of the hourly invocation) | Measured locally: about 5 ms on 1,200 open deals | Low. Once a day it reads the due tasks, the gone-quiet deals (every open deal, as the rules do) and the deals added since the last brief, and writes one row. If `cron_brief_failed` appears, or "exceeded CPU" on the hour of the brief, the same sign applies. Sending is off by default; turning it on needs a Resend account (its free tier covers one email a day), not Workers Paid. |
| D1: 5 million rows read and 100,000 rows written per day, 5 GB storage | A one-person pipeline is far below this | Low. |
| Requests: 100,000 per day | Far below | Low. |

Not used (so not needed): Durable Objects, WebSockets and sessions (the MCP handler is stateless, decision 0004).

## CPU check (run 2, 2026-11-19)

How close the engine gets to the free plan's 10 ms of CPU per invocation on a large copy, measured on this Mac (Apple
silicon, Node 24, wrangler 4.160.1) before and after the fixes in decision 0020. Not measured on Cloudflare yet.

### Method

- **The copy.** `scripts/seed-scale.ts` writes a deterministic fake copy: 2,000 deals (1,200 open, 240 in each open
  stage; 400 won, 250 lost, 150 not now), 1,500 contacts at 300 companies (one in ten from the website form, so outside
  text is labelled as on a real copy), 20,000 activities, 3,000 tasks, five rules (a gone_quiet, a Replied follow-up
  with 30 deals overdue, a Proposal sent entry rule with 20 new entries, a paused one, and a New inquiry follow-up whose
  matches have already fired), about 6,000 change-log rows with full row snapshots, and 60 briefs. The next hourly run
  has 50 firings due, twice `MAX_FIRINGS_PER_RUN`. `scripts/seed-scale.test.ts` checks its shape.
- **(a) Real runtime, wall time.** `node scripts/cpu-wall.ts` loads the copy into a new temp state folder (migrations,
  defaults, seed, all `--local`), runs `wrangler dev --local`, and times each request end to end: the median of 20
  after 3 warm-ups. Each hourly run is timed once (it writes): 50 due with the brief, then 25 due, then none. Local D1
  runs in the same process, so this counts the queries too and over-counts the Worker's CPU. Other work on the Mac at
  the time moves these by a few ms.
- **(b) CPU attribution.** `node --import ./tests/helpers/workers-runtime.mjs scripts/cpu-check.ts` calls the Worker's
  own `fetch` and `scheduled` handlers in Node on the same copy over the D1 shim (`src/db/sqlite-d1.ts`), and measures
  `process.cpuUsage()` per call minus the CPU spent inside D1 calls (the shim's statement and batch execution, and
  serializing the result rows, which on Cloudflare happen in D1). Parsing the rows back is kept in, because the Worker
  does that part. The median of 20 after 5 warm-ups; run-to-run noise is about 1 ms. This is the column to judge by.
  Each hourly run starts from the same state (what the previous one wrote is removed first).
- **(c) CPU time from wrangler.** Not available: `wrangler dev` logs each request's wall time only, has no option to
  report CPU time, and `limits.cpu_ms` in the config applies to deployed Workers only. A CPU profile through
  `--inspector-port` and Chrome DevTools is possible by hand; it was not used.
- Bodies are read as bytes, so decoding them (the client's work) is not counted.

### Results

Wall ms is (a); CPU ms is (b), the estimated Worker CPU without D1. Before is `main` at `d17d3a2`, after is this
branch. D1 calls are the after numbers: statements, and how many of them went in batches.

| Request | Wall ms before | Wall ms after | CPU ms before | CPU ms after | D1 statements | Body after |
|---|---|---|---|---|---|---|
| MCP `initialize` | | | 1.7 | 1.7 | 0 | 2.5 KB |
| MCP `tools/list` | 5.1 | 3.4 | 2.6 | 1.4 | 0 | 30 KB |
| MCP `pipeline_summary` | 14.3 | 14.0 | 4.9 | 5.7 | 4 | 786 KB |
| MCP `preview_rule` (the 7-day Replied follow-up) | 38.6 | 23.5 | 15.4 | 7.3 | 4 | 22 KB |
| MCP `list_deals` (every open deal) | | | 6.7 | 6.8 | 2 | 1.1 MB |
| MCP `recent_changes` | | | 1.1 | 1.1 | 2 | 44 KB |
| Hourly run, 50 due (25 written), with the daily brief | 87.0 | 48.9 | 7.4 | 6.8 | 112 (101 in 26 batches) | |
| Hourly run, 50 due (25 written), no brief | 23.9 (25 due) | 20.1 (25 due) | 1.7 | 1.6 | 104 (100 in 25 batches) | |
| Daily brief alone | | | 4.9 | 4.6 | 8 (1 in 1 batch) | |
| `/api/export.json` | 206.9 | 188.9 | 64.4 | 62.8 | 13 (12 in 1 batch) | 18 MB (was 22 MB) |
| `/pipeline` (board) | 27.3 | 15.7 | 10.5 | 3.7 | 7 | 384 KB (was 1.8 MB) |
| `/pipeline?view=list` | 27.3 | 15.2 | 9.0 | 3.8 | 7 | 380 KB (was 1.8 MB) |
| `/pipeline?view=list&stage=replied` (new) | | 16.8 | | 3.3 | 7 | 302 KB |
| `/contacts` | 21.0 | 21.0 | 1.2 | 1.1 | 3 | 100 KB |
| `/companies` | 23.3 | 19.4 | 9.6 | 5.1 | 4 | 343 KB |
| `/` (Today) | 19.0 | 17.4 | 5.5 | 5.5 | 8 | 257 KB |
| A deal page | 5.7 | 4.6 | 0.1 | 0.1 | 10 | 9 KB |
| A contact page | | | 0.2 | 0.2 | 7 | 13 KB |
| `/changes` | | | 1.2 | 1.2 | 3 | 139 KB |

Blank cells were not measured that way. The hourly run with nothing due took 9.6 ms wall, before and after.

### Fixed (decision 0020)

- **The pipeline board and list** drew all 1,200 open deals: about 10 ms. Each stage now shows its 50 longest-waiting
  deals and links to its own list (up to 200): about 4 ms.
- **`preview_rule`** read a year of activities with a full table scan: about 15 ms. It now reads 30 days plus the
  rule's own days through a new index (migration 0005): about 7 ms.
- **The Companies page** spent about 4 ms building a new collator for every name comparison in its sort: about 10 ms
  before, 5 ms after.
- **`tools/list`** converted every tool's zod schema to JSON Schema on each request; now once per isolate: 2.6 to
  1.4 ms.
- **`/api/export.json`** is streamed table by table. Its CPU is about the same (decoding 18 MB of rows and encoding the
  file is the work, whatever the shape), but its peak memory on this copy fell from about 130 MB, over the Worker's
  128 MB, to about 70 MB.

### Still near or over the limit

- **`/api/export.json`: over, about 6 times on this copy.** About 3.5 ms per MB of export, so it fits only up to about
  2 to 3 MB, a few hundred deals with their history (the change log is about half of the file). Use
  `npm run copies:export -- --copy <name>` from the Mac for a big copy, or Workers Paid.
- **Within about 3 ms of the limit:** `preview_rule` (7.3, grows with deals and a few weeks' activity), `list_deals` and
  `pipeline_summary` with every open deal (6.8 and about 5 to 6, about 0.5 ms per 100 open deals, so about 10 ms at
  2,000 open deals), the hourly run on the hour of the brief (6.8), Today (5.5) and Companies (5.1).
- Cloudflare's servers are not this Mac; a request can take more CPU there. Treat anything over about 5 ms here as one
  to check on the first real copy.
- **Not measured:** the first `/mcp` request in a new isolate also loads the MCP SDK (a dynamic `import()`), which
  these warm numbers leave out.

### What the owner confirms on the first real copy

1. Cloudflare dashboard, Workers & Pages, the copy's Worker, **Metrics**: **CPU time** (median and 99th percentile)
   over a few days of real use, and any **exceeded CPU** errors. Look at `/mcp` (`tools/list`, `preview_rule`), the
   pipeline board, `/api/export.json` and the hourly Cron Trigger (on the hour of the brief).
2. The same page's **Errors** or the logs, for "exceeded CPU" or `cron_rules_failed` / `cron_brief_failed`.
3. **D1 queries per invocation** (docs/STATUS.md, "What's left" 2): whether a D1 batch counts as one query or as one per
   statement toward the free plan's limit of 50. The repo holds no copy of Cloudflare's limits page and this task did
   not browse the web, so this is **still unknown**. What the engine does, measured above: the hourly run on the hour
   of the brief makes 37 D1 calls holding 112 statements (each of its 25 firings is one batch of 4 statements); the
   rules job alone makes 29 calls holding 104 (on other hours the brief's check adds a few reads). Counted per call, that is under 50; counted per statement, it is over, and
   `MAX_FIRINGS_PER_RUN` would have to drop to about 8 (8 batches of 4 plus the reads and the brief) or the copy move
   to Workers Paid (1,000).
