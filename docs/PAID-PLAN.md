# What needs the Workers Paid plan

The engine is meant to run on Cloudflare's free plan. This file lists everything that needs the $5/month Workers Paid
plan, with the reason, and the free-plan limits to watch. Each task adds to it.

## Needed so far

Nothing. Every part built so far runs on the free plan.

## Limits to watch

| Limit (free plan) | Where we are | Risk |
|---|---|---|
| Worker size: 3 MB compressed | 1.35 MB raw, about 0.24 MB gzip (the `wrangler dev` bundle, measured 2026-11-18 after the MCP endpoint, task 4) | Low. The MCP SDK, `agents` and `zod` are most of it. |
| CPU time: 10 ms per request | Not measured in production yet | **Medium.** Every `/mcp` request builds a fresh MCP server (13 tools, zod schemas converted to JSON Schema for `tools/list`) and then runs the tool. Small requests should fit; a large `tools/list` or a tool that reads many rows (`pipeline_summary` on a big pipeline, `recent_changes` with 100 entries) may go over 10 ms. If requests fail with "exceeded CPU", that is the sign to move the copy to Workers Paid (30 s default CPU limit). |
| D1: 5 million rows read and 100,000 rows written per day, 5 GB storage | A one-person pipeline is far below this | Low. |
| Requests: 100,000 per day | Far below | Low. |

Not used (so not needed): Durable Objects, WebSockets and sessions (the MCP handler is stateless, decision 0004).
