# 0013: The board pages, its JSON API and the export

Replaced in part by 0014 (run 2): the board is now editable through the audited services, may load one first-party
script (`script-src 'self'` once it ships) and has more pages. The outside-text, API, export and CSV rules below
still stand.

## Context

The spec asks for a read-only board (deals by stage, due today, deal detail with timeline, rules, change log, latest
brief), JSON for it under `/api/*`, and an export download ("full JSON plus CSV per table"), accessible, working on a
phone and passing the a11y and Lighthouse checks with seed data. It left open the pages and their labels, how outside
text looks, the export format, how CSV is protected against formula injection, what the board does before production
sign-in exists, and how lists behave on a narrow screen. The style guide (`docs/STYLE-GUIDE.md`) is still a template
skeleton, so the palette tokens already in `public/board.css` (decision 0001) are the design brief.

## Decision

- **Pages** (server-rendered with the `html` template, no client JavaScript, GET and HEAD only):
  `/` (a summary line, a "Due today" panel with Overdue and Today groups for tasks and deals' next dates, deals by
  open stage with count and value, and the latest brief's first four lines), `/deals/<id>` (contact, deal, next step,
  open tasks, timeline newest first), `/brief` (the full latest brief by section, its date and whether it was emailed),
  `/rules`, `/changes` (the last 30 days, newest first, at most 200, undone ones flagged "Undone", undo entries say
  which change they undid) and `/export`. Every page has its own `<title>` and meta description. An unknown deal id,
  or a path that can't be an id, gets the 404 page. An empty database gives each page a plain "nothing yet" sentence.
- **Sign-in until task 10** (replaced by decision 0006: Cloudflare Access in production). The board pages and `/api/*` use the `/mcp` gate (`src/auth/dev.ts`): signed in by the
  dev mode locally, 401 everywhere else. Static files and the 404 page need no sign-in (they show no data). This
  replaces the line in decision 0004 that said the board was unaffected by the gate.
- **Outside text** (a value listed in `untrusted_fields`, an activity's `untrusted_text`, a brief item with
  `untrusted: true`) is escaped like everything else and shown after a visible text label, "From outside" (a rust
  outline pill; the words carry the meaning, not the color). It is never a link's text or target: a deal whose title
  came from a form is linked as "Deal dl_…" with the labelled title beside the link, and an email address is plain
  text. It never goes in `<title>` or the meta description, where a label can't be shown. A deal page with any outside
  text says once what the label means. An activity written by the system (not the owner or the AI) has its summary
  labelled too, because the read service lists it in `untrusted_fields`.
- **API.** `/api/pipeline`, `/api/due`, `/api/deals/<id>`, `/api/rules` (`{ rules }`), `/api/changes`
  (`{ since, changes, truncated }`), `/api/brief` (`{ brief }`, null before the first one) return the read services'
  shapes, so their outside-text labels come along. The brief comes as its subject plus labelled `items`; its stored
  text, which mixes outside text in without labels, is only in the export. JSON, `Cache-Control: no-store`, security headers, 404 JSON for
  anything unknown, 405 JSON with `Allow: GET, HEAD` for other methods, and a fixed message for a server failure (the
  log line is the event name only).
- **Export.** `/api/export.json` is `{ exportedAt, tables: { <table>: rows[] } }` for contacts, deals, activities,
  tasks, stages, field_defs, rules, rule_firings, rulebook, settings, audit_log and briefs (`write_guard` is empty
  scratch space and is left out), read in one D1 batch so the tables come from the same moment. Rows are as stored:
  JSON columns stay JSON text, times stay UTC ISO. `/api/export/<table>.csv` gives one table; other names are 404.
  Both are downloads (`Content-Disposition: attachment`) named `pipeline-export-<date>.json` and
  `pipeline-<table>-<date>.csv`, with the owner's local date. An empty table's CSV still has its header row (column
  names from D1's `raw({ columnNames: true })`, checked against real local D1 in `tests/e2e/intake.test.ts`).
- **CSV** (`src/http/csv.ts`): RFC 4180 with CRLF after every record (the last too), a header row, quotes doubled, a
  field quoted when it holds a comma, quote, CR or LF, and null as an empty field. **Formula guard:** a text cell
  starting with `=`, `+`, `-`, `@`, tab or CR gets a leading `'`, so a spreadsheet shows it as text. Numbers are
  written as numbers and never guarded (`-5` stays `-5`; a number can't be a formula). Objects are written as JSON. No
  byte order mark is added. `parseCsv` reads the same format back (and drops one BOM at the start of a file) for the
  round-trip tests and the CSV import in task 11.
- **Mobile.** No tables: every list is a plain list, one item per row, with a few labelled facts per item
  ("Contact: …", "Due: …") that wrap. Long values wrap anywhere (`overflow-wrap: anywhere` on `main`), so a
  10,000-character note never widens the page. Two columns only from 60rem up (home: stages and the brief; deal page:
  contact and deal beside next step, tasks and timeline), in reading order. Links are at least 44px tall, and a link
  inside a meta line keeps its tap height through vertical padding. The a11y check now also fails on horizontal scroll.
- **Seed.** `scripts/seed-dev.ts` adds yesterday's brief (composed with `composeBrief`, one outside line), so the
  board shows a brief in the checks and today's brief is still composed by the cron. The seed has no change-log rows:
  many tests count `audit_log` rows on the seeded database.

## "AI defaults" (human-touch-design), flagged for the owner

- **Rounded outline pill for "From outside"** (close to item 4, one radius everywhere): the label uses the shared
  12px radius. Alternatives: square corners with a rust left bar only; or plain bold rust text with no box.
- **Rules between list rows and a colored rule under each stage heading** (close to item 3, hairlines): used because
  rows of facts need separation without cards. Alternatives: more vertical space and no rules; or a tint band behind
  each stage heading.
- **Middle dot in page titles** ("Rules · Pipeline", item 5): kept from the 404 title task 1 wrote. Alternatives:
  "Rules | Pipeline"; or "Pipeline rules".
- Not used: cards for deals, eyebrow labels, all caps, monospace ids, arrows on links, gradients, shadows.

## Why

Server-rendered lists need no JavaScript, keep `script-src 'none'`, and stay readable at 375px without a horizontal
scrolling table. A text label next to escaped text is the board's version of the `untrusted_fields` rule: the owner
sees exactly what came in, and nothing from outside can become a link or a page title. The formula guard follows the
OWASP CSV-injection advice; it changes only text cells that a spreadsheet would execute, and the export page says so.
Reading the JSON export in one batch avoids a file in which, say, a deal points at a contact exported a moment before.

## Consequences

- The guard changes text that really starts with those characters (a note "-call back" exports as "'-call back").
  The JSON export is the faithful copy; the import (task 11) should strip one leading `'` it finds before those
  characters.
- Excel may show non-ASCII text in a CSV wrongly without a byte order mark; Google Sheets and Numbers read UTF-8.
  Revisit if the owner opens exports in Excel.
- The board is not reachable in production until task 10 adds Cloudflare Access verification (done: decision 0006).
- A change log longer than 200 entries in 30 days shows the newest 200 and says so; `recent_changes` over MCP still
  reaches older ones.
