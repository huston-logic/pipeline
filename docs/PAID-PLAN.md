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
| CPU time: 10 ms per request | Measured locally on a 2,000-deal fake copy, not yet in production: in run 2 every request but the export fit, the largest at about 7 ms; with 2,000 leads added (run 4, a busier Mac) `list_deals`, deal `preview_rule`, the hour of the brief and Today are at or over 10 ms; `/companies` (7.7 ms) and `/leads` (2.1 ms) are inside it (see "CPU check" and "Run 4" below) | **Medium.** Every `/mcp` request builds a fresh MCP server and then runs the tool; JSON Schemas for `tools/list` are converted once per isolate (decision 0020). The tools that list every open deal (`pipeline_summary`, `list_deals`) grow with the pipeline and would reach 10 ms at about 2,000 open deals. If requests fail with "exceeded CPU", that is the sign to move the copy to Workers Paid (30 s default CPU limit). |
| Cron Triggers | One hourly trigger (`0 * * * *`: the rules run, then the daily brief; tasks 6 and 7). Cron Triggers are included in the free plan (up to 5 per account) | Low for the trigger itself. |
| CPU time of the hourly run (10 ms per invocation on the free plan) | Measured locally: about 2 ms with 50 firings due (25 written), about 7 ms on the hour that also composes the brief, on 1,200 open deals (see "CPU check" below) | **Medium as a pipeline grows.** Each run reads every open deal once, the fire keys of open deals and the active rules, then checks each deal against each stage rule: about open deals × stage rules comparisons, plus one D1 batch per new task. A one-person pipeline (tens to a few hundred open deals, a handful of rules) is small; thousands of open deals with many rules, or a run that has to create many tasks at once (for example right after a new rule is added), could go over 10 ms. Failed firings are retried on the next run, so going over is a delay, not lost work. A firing that cannot be written is counted, not thrown, so watch for `failed` above 0 in the `cron_rules_done` log line (several runs in a row), as well as for `cron_rules_failed` or "exceeded CPU"; those are the signs to move the copy to Workers Paid. |
| Subrequests and D1 queries per invocation (free plan: 50 of each) | One batch per firing in the hourly run, plus the reads and the brief: measured, 37 D1 calls holding 112 statements on the hour of the brief (see "CPU check" below); a 25-action `propose_changes` or `apply_changes` about 31 D1 calls, the most 40 (see "Run 6: proposals and D1 calls" below) | **Unknown until confirmed:** if Cloudflare counts each statement in a batch as a query, a run that writes 25 firings is over 50. Otherwise low since the final review: a run writes at most 25 firings (`MAX_FIRINGS_PER_RUN`, decision 0010), so a catch-up after a new rule cannot use up the invocation and starve the brief that runs after it. The rest fire next hour; `deferred` above 0 in `cron_rules_done` for many hours in a row means more tasks are due each hour than one run writes. |
| CPU time of `/api/export.json` (10 ms per request) | Reads and serializes every row of every table, `audit_log` included; streamed table by table since run 2 (decision 0020). Measured locally: about 63 ms for an 18 MB export of the 2,000-deal copy, about 3.5 ms per MB | **High on a big copy, growing without bound.** The export fits the free plan only up to about 2 to 3 MB (a few hundred deals with their history). For a large copy, export with `npm run copies:export -- --copy <name>` from the Mac instead (no Worker CPU limit), or move the copy to Workers Paid. |
| CPU time of `preview_rule` (10 ms per request) | Reads every non-archived deal and the activities of the last 30 days plus the rule's own days, through an index (decisions 0010 and 0020). Measured locally: about 7 ms for a 7-day rule on the 2,000-deal copy | **Medium on a big pipeline.** It grows with the number of deals and with a few weeks' activity (a long rule, 365 days, reads a year). If previews fail with "exceeded CPU", that is the sign for Workers Paid. |
| CPU time of the daily brief (part of the hourly invocation) | Measured locally: about 5 ms on 1,200 open deals | Low. Once a day it reads the due tasks, the gone-quiet deals (every open deal, as the rules do) and the deals added since the last brief, and writes one row. If `cron_brief_failed` appears, or "exceeded CPU" on the hour of the brief, the same sign applies. Sending is off by default; turning it on needs a Resend account (its free tier covers one email a day), not Workers Paid. |
| CPU time of `list_leads` and the lead rule (10 ms per request) | Measured locally on 2,000 leads added to the 2,000-deal copy: `list_leads` 2.2 to 2.5 ms, the hourly run's lead rule about 1 ms, `preview_rule` on it 2.2 ms (see "Run 4: 2,000 leads" below) | Low. |
| D1 rows read per `list_leads` call (free plan: 5 million rows a day) | The query reads every reach activity twice (once on the person, once through their deals) and every task, to find each lead's last contact and next task: about 50,000 rows on the 2,000-lead copy (estimated from the query shape, not counted) | **Medium on a big lead list.** About 100 calls a day would use the whole free allowance on that copy; a few hundred leads and a few thousand activities (a normal copy) read a tenth of that or less. If it matters, Workers Paid has a far larger allowance (check Cloudflare's current limits page; this repo holds no copy of it). |
| CPU time of a logged email (the `email` handler, 10 ms per invocation; decision 0031) | Measured locally (2026-11-20, Node on the owner's Mac, warm, median of 15) for `parseEmail` plus the clean-up and the dedupe key: a typical 5 KB email 0.2 ms; 1 MB of plain text 2.9 ms; 1 MB of HTML-only unclosed tags 1.9 ms (worst run 2.5 ms); 1 MB of unclosed `<script` 1.7 ms (worst 5.3 ms); a 0.9 MB base64 attachment 6.8 ms (worst 7.6 ms). The body is cleaned from its first 20,000 characters only, in linear passes. Then up to about 11 D1 calls (owner emails, the dedupe check, up to two address lookups, the timezone, one open-deals read per person, one batch) | **Low for typical mail; close to the limit for a near-1 MB message with a large attachment** (the parser still decodes attachments it then ignores). Messages over 1 MB are dropped before parsing. Not yet measured in workerd: if "exceeded CPU" shows on the Worker's `email` invocations, the email is lost silently; the sign is the owner's BCC'd emails with big attachments not showing up. Workers Paid lifts it. Email Routing itself is free. |
| CPU time of an import in the Worker (10 ms per request; the board import comes in run 5, task I3) | Measured locally on the 3,500-person copy (2026-11-22): reading the contacts, planning a 2,000-row file and writing it as one bulk change about 11 ms; undoing it about 8 ms (see "Run 5: import" below). The CLI import runs on the Mac, where the limit does not apply | **Medium to high for a full-size file on a big copy.** About half is the plan, which grows with the file and with the contacts on file. If a board import of a big file fails with "exceeded CPU", import it from the Mac (`npm run import:contacts`), split it into smaller files, or move the copy to Workers Paid. |
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

## Run 4: 2,000 leads (task L9, 2026-11-20)

The same check (`scripts/cpu-check.ts`, method (b) above) with 2,000 leads added to the 2,000-deal copy.
`scripts/seed-scale.ts` now also writes 2,000 people with a lead status and no deal: New 41%, Contacted 28%, Not now
16%, Not a fit 10%, Bad lead 5% (820, 570, 314, 197, 99); about 1,250 activities on the people themselves; about 660
tasks (470 open: check-backs, call tasks; 100 finished rule tasks); 100 leads the new `lead_followup` rule has already fired on and 40 it owes
(`DUE_FIRINGS.leads`); one `add_lead` change each. The copy is now 3,500 contacts (2,000 of them leads) with 2,300
distinct businesses. The deals, activities and rules of run 2 come out unchanged (the leads use their own random
sequence).

Numbers are medians of 20 runs on this Mac (Apple silicon, Node 24), Worker CPU = process CPU minus D1, in ms. This Mac
was busier than in run 2 (the unchanged requests read about 1.3 times higher), so "without leads" below is the same
code on the same afternoon with the leads switched off, and the comparison is between those two columns, not with the
run 2 table. Run-to-run noise is about 1 ms.

| Request | Without leads | With 2,000 leads | D1 statements |
|---|---|---|---|
| `list_leads`, default (New, Contacted, Not now: about 1,700 match, the first 200 shown) | | 2.5 | 3 |
| `list_leads`, Contacted + source referral + quiet 7 days, longest quiet first | | 2.2 | 3 |
| `list_leads`, New only | | 2.5 | 3 |
| `list_leads`, follow-up due within 7 days | | 2.3 | 3 |
| `search_contacts` with `leadStatus` | | 1.4 | 2 |
| `preview_rule` on the saved `lead_followup` rule | | 2.2 | 4 |
| Hourly run with only the lead rule active (40 due, 25 written) | | 1.1 | 104 (100 in 25 batches) |
| Hourly run, 50 deal firings due (25 written; the lead rule is evaluated, none of its firings fit the budget), no brief | 2.3 | 3.1 | 105 |
| Hourly run on the hour of the brief | 9.9 | 11.2 | 114 |
| Daily brief alone | 7.1 | 7.5 | 9 |
| `pipeline_summary` (now with the leads line) | 7.7 | 8.2 | 6 |
| `list_deals` (every open deal) | 9.5 | 10.0 | 2 |
| `preview_rule` on a deal rule (the 7-day Replied follow-up) | 9.9 | 11.0 | 4 |
| `/companies` | 7.3 | 15.0 | 4 |
| `/` (Today) | 12.5 | 13.7 | 10 |
| `/contacts` | 1.6 | 1.5 | 3 |
| `/api/export.json` | 85.5 | 102.0 | 13 |
| Import plan for a 2,000-row CSV as leads (1,600 new, 200 matching a lead's email, 200 repeating a lead's business), on the Mac | | 7.1 | 0 |
| The same plan plus the audited change, all 2,000 rows | | 9.0 | 0 |
| The same for a 150-row file, with the SQL | | 3.1 | 0 |

`list_leads` itself spends 20 to 85 ms inside local SQLite on this copy (every activity is scanned to find each person's
last contact), but that is D1's time, not the Worker's, and is not counted against the 10 ms. It does count as D1 rows
read (see the limits table).

### Verdict against the free plan's 10 ms

- **The lead reads and the lead rule are well inside it:** `list_leads` about 2.5 ms in every form, the lead rule about
  1 ms an hour, `preview_rule` on it 2.2 ms. Nothing to fix.
- **The import is not a Worker.** It runs on the Mac (`npm run import:contacts`), so the 10 ms does not apply: planning
  2,000 rows takes about 7 ms there. It can only be applied in files of about 190 rows (D1 allows 100 KB per statement,
  `src/import/sql.ts` says so in plain English); a 2,000-row list is split into about ten files. (Run 5 lifted this: a
  2,000-row file is one change; see "Run 5: import" below.)
- **Leads make three existing pages heavier, none of them a lead page:** `/companies` doubles (7.3 to 15.0 ms, 344 KB to
  857 KB) because every lead's business becomes a company on a page with no paging; Today adds about 1 ms; the export
  grows with the data (about 5 ms per MB here, 3.5 in run 2). `/companies` is the only one that crosses 10 ms because of the
  leads. It belongs to the board's lead views (PR #36), not to this task; reported, not changed.
- **Near the limit already, and tipped over by the 2,000 leads** (table above, same Mac, without then with leads): the
  hourly run on the hour of the brief 9.9 to 11.2 (11.5 in the closing re-measure), `preview_rule` on a deal rule 9.9 to 11.0, `list_deals` 9.5 to 10.0.
  These are the same requests as run 2's "still near or over the limit", about 1.3 times higher on a busier machine, and
  the leads add about 0.5 to 1.3 ms to each because they all read the contacts table (3,500 rows instead of 1,500).
  Only Today (12.5, 13.7 with leads) was over without them. What to do: nothing in this task. If a real copy has this
  many people and these requests fail with "exceeded CPU", Workers Paid is the fix; a later task could narrow the
  contact read in the brief and in the deal reads to the people the request needs. Treat all of them as
  first-real-copy checks, as before.
- **`/companies` and `/leads`, re-measured after PR #36** (Companies leaves out unqualified leads; the Leads page is
  on `main`), 2026-11-20, same method and copy, median of 20: see "Run 4 closing re-measure" below.

### Run 4 closing re-measure (task E2, 2026-11-20)

`scripts/cpu-check.ts` gained two cases (`/leads` and `/leads?status=closed`); everything else is unchanged.

| Request | Worker CPU ms | D1 statements | Body |
|---|---|---|---|
| `/companies` (was 15.0 ms, 857 KB with the leads' businesses) | 7.7 | 4 | 344 KB |
| `/leads` (default: open leads, first 200) | 2.1 | 4 | 99 KB |
| `/leads?status=closed` | 1.0 | 4 | 82 KB |

On this run the Mac was about as busy as in the L9 run (Today 13.8 ms, `list_deals` 10.3, the hour of the brief 11.5,
`preview_rule` on a deal rule 11.0, all as in the table above).

Verdict: `/companies` is back to its run 2 level (7.7 ms here, 7.3 without leads in the L9 run), because the page now
leaves out unqualified leads (PR #36), so their 2,000 businesses no longer count. `/leads` is
cheap (2.1 ms) because it shows at most 200 rows. Neither crosses 10 ms. Still over 10 ms on this Mac with 2,000 leads
and 2,000 deals, and flagged for the first real copy (see the STOP queue in docs/STATUS.md): Today (13.8), the hour of
the brief (11.5), `preview_rule` on a deal rule (11.0) and `list_deals` for every open deal (10.3). They fail only on a
copy with thousands of people and deals; Workers Paid is the fix if "exceeded CPU" shows up in the dashboard.

## Run 5: import (task I2, 2026-11-22)

A 2,000-row import is now one audited change in one D1 batch (decision 0035): set-based statements with one JSON
parameter each, the snapshot in `audit_parts`. `scripts/cpu-check.ts` gained two cases, and its 150-row SQL case now
renders the whole 2,000-row file. Same method (b) and copy as above (2,000 deals, 3,500 people of whom 2,000 leads), the
same 2,000-row leads file (1,600 new people, 200 matching a lead's email, all of them already complete, and 200
possible duplicates), medians of 20 runs after 5 warm-ups, this Mac (Apple silicon, Node 24). The Mac was quieter than
in run 4 (Today 8.3 ms, `list_deals` 6.3, the hour of the brief 7.3, all measured in the same run).

| Request | Worker CPU ms | D1 CPU ms | D1 statements |
|---|---|---|---|
| Import plan only (on the Mac) | 8.3 | 0 | 0 |
| Plan plus the audited change, no SQL (on the Mac) | 6.6 | 0 | 0 |
| Plan, change and SQL for the whole 2,000-row file, as `import:contacts --apply` (on the Mac; 1.5 MB of SQL) | 11.6 | 0 | 0 |
| **Import in the Worker:** read the contacts and fields, plan, one bulk change | 11.5 | 24.5 | 23 (2 reads, 21 in 1 batch) |
| **Undo of that import:** 1,600 people removed | 8.4 | 11.6 | 23 (7 reads, 16 in 1 batch) |

Repeated alone the same afternoon (`--only import`): 10.9 and 8.0 ms. Run-to-run noise is about 1 ms; the plan-only
line (6.5 to 8.3) shows it.

### Verdict against the free plan's 10 ms

- **The CLI import is not a Worker** and now applies a 2,000-row file in one go: 24 statements for 2,000 new people
  (10 inserts, the audit row, 12 parts, the guard clean-up), the largest about 91 KB, all under D1's 100 KB.
- **In the Worker, a full 2,000-row import is at the limit: about 11 ms.** Timed apart (a one-off script, medians of
  20): the plan about 4 ms, the import's change 1.5 ms, turning it into bulk statements about 3 ms (each row is
  written as JSON once), and decoding the 3,500 contacts it reads about 1.5 to 2.5 ms.
  The writes themselves (about 24 ms here) are D1's time, not the Worker's. A file of a few hundred rows, or a copy
  with fewer people, is well inside it. The board import (task I3) should expect "exceeded CPU" for full-size files on a
  big copy on the free plan; the ways out are the CLI, smaller files, or Workers Paid.
- **The undo is inside it: about 8 ms** for 1,600 people, reading set-based (7 reads whatever the size).
- **D1 statements per invocation:** the import is 23 statements (21 in one batch) and its undo 23 (16 in one batch).
  Whether D1 counts a batch as one query or one per statement toward the free plan's 50 is **still unknown** (see "What
  the owner confirms" above). Counted per statement, both fit under 50.


## Run 5: saved views (task P9, 2026-11-23)

`scripts/cpu-check.ts` on the scaled copy (2,000 deals, 3,500 people of whom 2,000 leads, 20,000 activities), with one
saved view of each module added; medians of 10 runs (decision 0042):

| request | est. Worker CPU ms | D1 CPU ms | D1 statements | body KB |
| --- | --- | --- | --- | --- |
| `/people?status=lead` (default view, 2,000 people, first 200 drawn) | 1.9 | 92.8 | 6 | 92 |
| `/people?view=…` (people by source, latest activity first) | 2.1 | 44.2 | 9 | 92 |
| `/pipeline?view=…` (open deals by value) | 1.2 | 4.1 | 8 | 93 |
| `/contacts` (for comparison) | 2.4 | 24.4 | 4 | 103 |

- **Worker CPU is about 2 ms** on every view page: drawing at most 200 cards keeps it flat whatever the copy's size.
- **The D1 side is the heavier part** of a people view: the last activity and next task for every person are worked
  out before the filter and the 200-row limit (the same CTEs as the Leads list). About 90 ms of D1 time for a view of
  2,000 people is D1's work, not the Worker's, and well under D1's own limits; if a copy gets much bigger, filtering the
  people before those two CTEs is the first thing to change.

## Run 6: proposals and D1 calls (final review, 2026-11-24)

The free plan allows 50 D1 queries per Worker invocation; Workers Paid allows 1,000. A ramble becomes one
`propose_changes` call and one `apply_changes` call, each planning every action through the ordinary services, so each
must fit. Counted on the fixture seed by `src/services/proposals-d1.test.ts` (each `first`/`all`/`run`/`raw` and each
`batch()` is one call; decision 0044, "D1 calls"):

| list | propose before | propose now | apply before | apply now |
| --- | --- | --- | --- | --- |
| 1 action (a call logged on a deal named by its person) | 16 | 6 | 11 | 5 |
| 10 actions of the ramble | 69 | 14 | 38 | 13 |
| 25 actions (`PROPOSAL_MAX_ACTIONS`): every record action kind, an `@n` task on a new lead, time tracking on | 158 | 31 | 88 | 30 |
| 25 actions on 25 different deals, by their person's name | 256 | 30 | 131 | 29 |

- The test holds a maximum-size list to at most 40 calls each way, leaving 10 for the request's own sign-in and
  settings reads; a 1-action list to at most 12. `PROPOSAL_MAX_ACTIONS` stays 25.
- What made the difference: one memo per request for the settings-like reads (one batch), all names matched in one
  batch, the list's named rows in one batch, a deal with its person in one batch, and a refused list explained with at
  most two more trials instead of being planned again for every prefix.
- Still unknown, as for the hourly run: whether Cloudflare counts each statement inside a batch as a query. If it does,
  the trial and the apply batch (about 45 statements for 25 actions) are each near or over 50 on their own, and only
  Workers Paid's 1,000 (or a smaller list) fits; the first real copy confirms it (see "What the owner confirms").
- On Workers Paid the 1,000 would allow a far larger list; the cap is also there for the owner, who reads and answers
  the whole list.
- Worker CPU is unchanged: on the scaled copy (the run 6 CPU method) a 10-action `propose_changes` by ids is 5.1 ms
  and its `apply_changes` 4.3 to 6.6 ms (a busy Mac), now 14 and 13 D1 calls (57 and 49 before, one per statement);
  D1's own time is back to about 11 ms each once refs shaped like ids skip the name scans.

### Today with 3,140 open tasks

Today read every open, awake task, sorted them in the Worker and drew 50 per list. It now asks the database for each
list already filtered, sorted and cut to 50, with one grouped count for "Showing 50 of N", in one D1 batch (decision
0047). Measured with the run 6 CPU method (`scripts/cpu-check.ts`'s method (b): the Worker's own `fetch` in Node over
the `node:sqlite` shim, est. Worker CPU = process CPU minus CPU inside D1 calls; medians of 20 runs after 5 warm-ups)
on the scaled copy plus 2,000 added open tasks (3,140 open in all, 1,000 standalone, 500 undated), before and after
on the same Mac at the same load (load average about 2.7 to 4.3):

| request | est. Worker CPU ms before | after | D1 calls before | after | body KB |
| --- | --- | --- | --- | --- | --- |
| `/` (Today) | 15.7 | 7.4 | 12 | 12 (14 statements, 3 in one batch) | 358 |
| `/?sort=subject` | 15.8 | 6.9 | 12 | 12 | 360 |
| `/?sort=newest&show=standalone` | 15.6 | 6.9 | 12 | 12 | 357 |

Today is back under the free plan's 10 ms on this copy (the seed alone measured 8.0 ms in the run 6 re-measure, on a
busier Mac). What is left is mostly drawing the 100 cards and the rest of the page; the sort itself is the database's.

### Run 6 re-measure: every new request (2026-11-23 and 24)

Method: `scripts/cpu-check.ts`'s method (b) on the scaled copy (2,000 deals, 3,500 people of whom 2,000 leads, 20,000
activities), plus 2,000 added open tasks (1,000 standalone, 500 undated, 3,140 open in all) and 2,000 time entries over 8
weeks across about 1,100 people and 1,000 deals, time tracking on; medians of 20 runs after 5 warm-ups, a busy Mac (load
average about 3 to 5). Est. Worker CPU is process CPU minus the CPU spent inside D1 calls. The Today, propose and apply
rows were measured before the final-review fix; the "after the fix" column is from the fix wave's own runs (Today at
the same load, back to back; propose and apply by their D1 calls and CPU on the 10-action list).

| Request | Worker CPU ms (re-measure) | After the fix | D1 calls before | D1 calls after | Over 10 ms |
| --- | --- | --- | --- | --- | --- |
| `/` (Today), 3,140 open tasks, 50 per list | 16.0 | 7.4 | 12 | 12 | before the fix only |
| `/?sort=subject` | | 6.9 (was 15.8) | 12 | 12 | no |
| `propose_changes`, 10 mixed actions by id | 5.1 | about 5 | 57 | 14 | no |
| `apply_changes` of that list | 4.0 | 4.3 to 6.6 (busy Mac) | 49 | 13 | no |
| `/time` (a week of 250 entries) | 2.9 | | 11 | 11 | no |
| `list_time` (this week) | 2.2 | | 8 | 8 | no |
| `list_time` (this month, about 1,070 entries in the totals, 200 listed) | 4.3 | | 8 | 8 | no |
| `list_tasks` (default limit 50) | 1.1 | | 2 | 2 | no |

- For the time pages, `list_time` and `list_tasks` the counts are the re-measure's statements, which the fix did not
  change.
- **D1 calls per invocation, free plan 50.** A maximum-size list (`PROPOSAL_MAX_ACTIONS` = 25) was 158 calls to propose
  and 88 to apply before the fix, and is now 31 and 30 (25 different deals: 256 and 131, now 30 and 29). A one-action
  list was 16 and 11, now 6 and 5. The cap stays 25. `src/services/proposals-d1.test.ts` fails if a maximum-size list
  needs more than 40 calls each way.
- **Open question: does a D1 batch count as one query or one per statement?** The repo holds no copy of Cloudflare's
  limits page and nothing here ran against real D1, so this is still unknown. Counted per call, a 25-action list is
  about 31 and fits. Counted per statement, the trial batch and the apply batch of a 25-action list hold about 44
  statements each, near the free plan's 50 on their own, so a big list would need Workers Paid (1,000) or a lower
  `PROPOSAL_MAX_ACTIONS`. The owner checks it on the first real copy (docs/STATUS.md, "Needs Grant").
- Today's CPU is now inside 10 ms on this copy because the sort, filter and cut to 50 moved into the database
  (decision 0047). The time pages and reads are all under 5 ms.

## Run 8: campaigns (2026-11-24)

The free plan allows 50 D1 queries per Worker invocation. Approving a campaign works the list out again and writes one
row per person, so it must fit with the biggest list a campaign may have (`MAX_AUDIENCE` = 2,000 people). Counted on the
fixture seed plus 2,000 people (some with no address, some suppressed) by `src/campaigns/freeze-d1.test.ts` (each
`first`/`all`/`run`/`raw` and each `batch()` is one call, as in Run 6):

| step | D1 calls | statements |
| --- | --- | --- |
| `resolveAudience` (the review page, the MCP preview): the people, then their suppressions | 2 | 2 |
| `approveCampaign` of a 2,000-person status audience, in all | 6 | 8 in its one batch |

- The 6 calls of an approve: the settings row, the campaign, its step, the people, the suppressions, and one batch. The
  batch holds the campaign's guard and update, 4 recipient inserts (the 2,000 frozen rows as JSON in chunks of at most
  `CHUNK_BYTES`, decision 0035), the audit row and the guard cleanup. The test holds approve to at most 12 calls and
  every bound JSON to at most 90,000 bytes as a SQL literal.
- Rough Node timing of `approveCampaign` for 2,000 people on the `node:sqlite` shim: about 35 ms, most of it the shim's
  own SQL work. It is not the method of `scripts/cpu-check.ts`; the Worker CPU is not measured yet.

The sender (`runCampaigns`, `src/campaigns/send.ts`) runs on its own Cron Trigger (`5,20,35,50 * * * *`), so it has its own
10 ms and 50 D1 calls and never shares them with the brief's hour. Counted by `src/campaigns/send.test.ts` with
`tests/helpers/counting-db.ts` on a fresh 100-person campaign (fetch mocked):

| run | D1 calls | statements |
| --- | --- | --- |
| idle (campaigns off, or nothing to send) | 1 | 7, all reads, in one batch |
| 100 emails: read, claim, resolve | 3 | 7 + 7 + 8 |
| a resend of a batch in flight, then a new batch of 100 | 5 | 7 + 1 (takes the batch over) + 8 + 7 + 8 (the test holds every run to 12) |

- The 3 calls of a 100-email run: one batch of 7 reads (settings, batches in flight and their rows, the campaigns that
  could send, their emails, the in-flight batches' campaigns, the day's room); the claim, one atomic batch of 7 (skip the archived and the suppressed,
  make the batch, claim up to 100 rows, close the campaign if nothing is left, read the batch and its rows back); and the
  resolve, one audited change of 8 (the batch guard, 100 activity inserts as one bulk statement, the rows `sent` with
  their Resend ids as one JSON parameter, the batch `done`, the campaign closed if nothing is left, the audit row). A
  scheduled campaign being started adds one call, a refused batch that pauses the campaign adds one change.
- Rough Node timing, fetch mocked, on the `node:sqlite` shim: about 25 ms for the whole 100-email run, and 1.4 to 3.7 ms
  for rendering and encoding the 100 emails (first run cold, then warm). Most of the 25 ms is the shim's own SQL work. The
  Worker's CPU for a send is not measured (`scripts/cpu-check.ts` does not cover it); the HTTPS request to Resend is
  network time, not CPU. Whoever deploys the first copy with campaigns on should read the invocation's CPU in the
  Cloudflare dashboard once.
