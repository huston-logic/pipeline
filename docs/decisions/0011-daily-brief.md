# 0011: The daily brief

## Context

The spec says that at the owner's brief hour the hourly cron composes a daily brief (overdue and due-today tasks, deals
flagged by `gone_quiet` rules, new leads since the last brief, one line per item), that sending goes through Resend and
stays off unless a flag and secrets are set, and that without them the brief is "only composed, stored and shown on
the board". It left open what "stored" means for a table that is not owner data, how the brief interacts with
`settings.brief_enabled`, what "since the last brief" is measured from, and how the brief hour behaves on the days the
clocks change.

## Decision

- **Compose always, send only when everything is on.** The brief is composed and stored once per owner-local day, at or
  after `settings.brief_hour`, whatever `brief_enabled` says (so the board always has a latest brief). It is *emailed*
  only when all of these hold: `settings.brief_enabled = 1`, `env.BRIEF_SENDING === "on"`, `env.RESEND_API_KEY`,
  `env.BRIEF_FROM` and `settings.brief_email`. Otherwise `briefs.send_status` records the first missing one, for example
  `off: brief_enabled is off`. `BRIEF_SENDING` and `BRIEF_FROM` are plain vars and `RESEND_API_KEY` is a secret, all
  optional in `Env` and documented in docs/SECRETS.md. Unset means off.
- **An append-only system log, not owner data.** `briefs(id, local_date UNIQUE, composed_at, text, items, sent_at,
  send_status)` (migration 0003). A brief is written with a plain D1 batch: no `audit_log` row, not undoable, no MCP
  tool. `UNIQUE(local_date)` is the guard against two overlapping runs: the insert is `ON CONFLICT (local_date) DO
  NOTHING`, and a run whose insert changed no row is skipped silently (it also does not send, so there is one email per
  day). Only the send result is updated afterwards (`sent_at`, `send_status`), with a plain update.
- **"New leads since the last brief" comes from the table.** It is the non-archived deals created after the previous
  brief's `composed_at`, up to now; with no previous brief, the last 24 hours. `settings.last_brief_at` is not written
  (it stays null; it is a leftover column from migration 0001), so there is one source of truth and nothing for undo or a
  stale write to disturb.
- **Once per local day, across clock changes.** `shouldRunBrief` is true when the owner's local hour is at or after the
  brief hour and no brief exists for that local date (or a later one). On 2026-11-01 the 1 a.m. hour happens twice: the
  first 1 a.m. runs it and the repeated one finds today's brief. On 2027-03-14 there is no 2 a.m.: the 3 a.m. run
  (hour 3 is at or after 2) composes it. A cron outage that spans the brief hour is caught up on the next run the same
  local day. Tests drive the hourly cron through both days (`src/brief/brief-schedule.test.ts`).
- **Lines.** Plain text, one line per item, sections in this order, empty ones omitted: Overdue, Due today, Gone quiet,
  New leads; "Nothing due today." when all are empty; the first line, also the email subject, is "Pipeline brief for
  Thursday Nov 19". Overdue and due-today are the owner's open, awake tasks (the same as `whats_due`). Deals' own next
  dates are not in the brief in v1. A deal flagged by two `gone_quiet` rules appears once, with the longer quiet spell.
  Text is flattened to one line. The brief is for the owner, so lines use real names and titles; an item whose text
  includes outside text (a task title, deal title or contact name listed in `untrusted_fields`) has `untrusted: true` in
  the stored `items` JSON, which the board (task 9) uses to label it. Message bodies (`untrusted_text`) are never read.
- **Sending.** `POST https://api.resend.com/emails` with JSON `{from, to: [brief_email], subject, text}` and an
  `Authorization: Bearer` header. Plain text only, no HTML. A failure is recorded as `failed: <HTTP status>` (or
  `failed: network error`), never the response body, the key or the address. A failed send is not retried the same day
  (the brief for the day exists); the status is visible on the board. The row is inserted with `send_status` "pending"
  before sending, so a Worker that dies mid-send never emails twice.
- **Cron.** `CRON_JOBS` is `rules` then `brief`, so tasks the rules just created are in the brief. Each job's log line is
  a fixed event name and counts (`cron_brief_done` with `composed`, `sent`, `failed`) or `cron_brief_failed`.

## Why

Composing every day costs one row and keeps the board's "latest brief" honest even before the owner turns email on;
having to opt in only for *sending* matches the rule that nothing leaves the system by default. Deriving the window from
the `briefs` table and relying on a unique date make the job idempotent without locks or a second source of truth.
Comparing local hours with `>=` and local dates with `UNIQUE` makes the clock-change days work without special cases.

## Consequences

- A brief that fails to send stays failed; the owner reads it on the board, or turns sending on and gets the next day's.
- The first brief after a long outage lists leads from the whole gap, because the window starts at the previous
  brief; the very first one only looks back 24 hours.
- Changing the brief hour or timezone to an earlier time after the brief ran does not compose a second one that day.
- `settings.last_brief_at` is unused; remove it in a later migration if it stays unused. `get_settings` reports
  `lastBriefAt` (the latest brief's `composed_at`) and `lastBriefSentAt` (the latest `sent_at`) from `briefs` instead
  (final review).
- The emailed text has no way to label outside text, so each line whose item is `untrusted` starts with
  "- [from outside] " there. The stored `items` (and so the board, which labels them itself) are unchanged (final
  review).
- The export (task 9) includes `briefs`.
