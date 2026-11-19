# What needs the Workers Paid plan

The engine is meant to run on Cloudflare's free plan. This file lists everything that needs the $5/month Workers Paid
plan, with the reason, and the free-plan limits to watch. Each task adds to it.

## Needed so far

Nothing. Every part built so far runs on the free plan.

Production sign-in (decision 0006) adds two things, both free: a KV namespace (`OAUTH_KV`, on the Workers free plan:
100,000 reads and 1,000 writes a day, far more than one owner's sign-ins and `/mcp` token checks use) and Cloudflare
Access (Zero Trust Free covers up to 50 users; a copy needs one or two).

## Limits to watch

| Limit (free plan) | Where we are | Risk |
|---|---|---|
| Worker size: 3 MB compressed | 1.35 MB raw, about 0.24 MB gzip (the `wrangler dev` bundle, measured 2026-11-18 after the MCP endpoint, task 4), plus about 0.27 MB raw / 0.07 MB gzip for `workers-oauth-provider` (task 10; the package's own file size, the bundle not re-measured) | Low. The MCP SDK, `agents` and `zod` are most of it. |
| KV (free plan): 100,000 reads, 1,000 writes, 1,000 deletes and 1,000 lists a day | Every `/mcp` request reads its token record (one read); a sign-in writes a few records; a token refresh (about hourly while an AI app is in use) writes a few | Low for one owner. Many connected AI apps refreshing all day could approach 1,000 writes; then Workers Paid lifts it. **Abuse risk:** `/register` and `/authorize` write to KV before anyone signs in, so a flood could use up the day's writes and block the owner's sign-ins until the next day. Fixed in task 11 with the `OAUTH_RATE_LIMIT` binding (20 per minute per IP on those two paths; Rate Limiting is free) and a `HEAD /authorize` that writes nothing (decision 0006). A flood from many IPs could still spend writes; if that happens, Workers Paid lifts the KV limit. |
| CPU time: 10 ms per request | Not measured in production yet | **Medium.** Every `/mcp` request builds a fresh MCP server (13 tools, zod schemas converted to JSON Schema for `tools/list`) and then runs the tool. Small requests should fit; a large `tools/list` or a tool that reads many rows (`pipeline_summary` on a big pipeline, `recent_changes` with 100 entries) may go over 10 ms. If requests fail with "exceeded CPU", that is the sign to move the copy to Workers Paid (30 s default CPU limit). |
| Cron Triggers | One hourly trigger (`0 * * * *`: the rules run, then the daily brief; tasks 6 and 7). Cron Triggers are included in the free plan (up to 5 per account) | Low for the trigger itself. |
| CPU time of the hourly run (10 ms per invocation on the free plan) | Not measured in production yet | **Medium as a pipeline grows.** Each run reads every open deal once, the fire keys of open deals and the active rules, then checks each deal against each stage rule: about open deals × stage rules comparisons, plus one D1 batch per new task. A one-person pipeline (tens to a few hundred open deals, a handful of rules) is small; thousands of open deals with many rules, or a run that has to create many tasks at once (for example right after a new rule is added), could go over 10 ms. Failed firings are retried on the next run, so going over is a delay, not lost work. A firing that cannot be written is counted, not thrown, so watch for `failed` above 0 in the `cron_rules_done` log line (several runs in a row), as well as for `cron_rules_failed` or "exceeded CPU"; those are the signs to move the copy to Workers Paid. |
| CPU time of the daily brief (part of the hourly invocation) | Not measured in production yet | Low. Once a day it reads the due tasks, the gone-quiet deals (every open deal, as the rules do) and the deals added since the last brief, and writes one row. If `cron_brief_failed` appears, or "exceeded CPU" on the hour of the brief, the same sign applies. Sending is off by default; turning it on needs a Resend account (its free tier covers one email a day), not Workers Paid. |
| D1: 5 million rows read and 100,000 rows written per day, 5 GB storage | A one-person pipeline is far below this | Low. |
| Requests: 100,000 per day | Far below | Low. |

Not used (so not needed): Durable Objects, WebSockets and sessions (the MCP handler is stateless, decision 0004).
