# 0051: Time pages, hand entry and the time CSV

Run 6, task D8, 2026-11-24. Builds on 0049 (time entries, rates, `listTime`), 0050 (the timer on the board), 0043
(table layout) and 0013 (CSV and the formula guard).

## Context

0049 and 0050 let the owner record time (timer, MCP) but not look at it or fix it on the board. The owner needs to see
a week, add time worked without the timer, correct or archive an entry, and hand a month to a bookkeeper as a CSV.

## Decision

- **`/time`** shows one week, Monday to Sunday in the owner's timezone, with Previous week, This week (when not on it)
  and Next week links. `?week=<date>` picks the week that date is in; a date in the middle of a week shows that week,
  and anything that is not a real `YYYY-MM-DD` date shows this week. Entries are drawn by day, one table per day with
  time, duration, who it is for (the deal's link, else the person's, else "No one"), work type, billable, amount and an
  Edit link. Then a Totals card (total, billable, not billable, billable amount) and tables by person and by deal. A
  week with no entries says so. Amounts are the entry's stored rate times its minutes, never worked out again.
- **`/time/new`** (Add time) and **`/time/<id>/edit`** are record forms built from specs (`time-form.ts`, 0018): Person
  and Deal selects (the first 300 people and open deals, plus what the entry already points to), Work type, Start,
  End, Minutes, Billable, Notes. The new form's Billable has a "Follow the work type" first option, so an explicit Not
  billable beats a billable work type; the edit shows the stored value. Edit sends only changed fields (fingerprints,
  0018), so a notes edit never reprices an entry; changing the work type, person or billable does, from today's rates,
  as 0049 says. Edit has an Archive button in its own form (`POST /time/<id>/archive`).
- The posts are in `TIME_ROUTES`: `POST /time/new` is `add_time_entry`, `POST /time/<id>/edit` and `.../archive` are
  `update_time_entry`, each as the owner, one audited change, undoable. Each answers 303 to `/time?week=<Monday of the
  entry>&change=chg_...`, so the Undo banner shows above the week the entry is in. A refusal is a 422 with the form
  again and the values kept. An end together with minutes is refused in the board's words; a start or end given without
  a time is "Give the time too."; saving an edit that changes nothing says so.
- **`GET /time/export.csv?month=YYYY-MM`** (`src/http/time-csv.ts`, answered in `src/index.ts` before the static-file
  branch because it ends in `.csv`) downloads `time-<YYYY-MM>.csv`, `attachment`, never cached. One row per client (the
  entry's person) and work type, columns `client, work type, hours, billable hours, rate, amount`: hours with two
  decimals; the rate is shown only when every billable entry in the row was saved at the same rate (blank otherwise);
  the amount is the sum of the stored amounts. Names are written as they are (the owner's own export, like `/export`),
  every cell through the formula guard in `csv.ts`. Time with no person is "No person", with no work type "No work
  type". A missing or empty `month` is this month; a month that is not `YYYY-MM` is a plain 400 that does not repeat
  it. The page offers "Download CSV for this month" and a month picker (a GET form) with a hint, "A month like 2026-11."
- With time tracking off, `/time`, `/time/new`, `/time/<id>/edit`, `/time/export.csv` and the posts are 404, and
  Time is not in More. When on, Time sits in More after "What it caught" (`moreItemsFor`, read by the layout and `/more`
  through `PageFrame.timeTracking`); `moreItems` is the fixed list without it. The export page lists the three time CSVs
  (`time_entries`, `work_types`, `client_rates`) only while time tracking is on; the full JSON export always holds them.
- Board pages: `/time`, `/time?week=2026-11-16`, `/time/new` and `/time/te_seed01/edit` are in `boardRoutes`. Lighthouse:
  `/time` takes the slot of `/companies`, a list of cards whose kind `/contacts` and `/leads` already cover; the form
  pages are `boardRoutes` only.
- The demo seed reuses 0050's Design ($95 an hour) and Admin (no rate, not billable) work types, adds a client rate
  (Elena Novak's Design at $110 an hour, `cr_seed01`) and eight finished entries anchored to this week's Monday
  (three on that Monday, five in the previous week; `te_seed02`..`te_seed09`) for three people and two deals, one of them Admin so not billable. `dl_seed01` is untouched. One more, `te_seed10`, sits on a fixed date (Tuesday 2026-11-17, 10:00 local), so the fixed route `/time?week=2026-11-16` stays a populated past week for the accessibility and screenshot runs (run 6 final review).

## Why

- Editing through the same services gives one audit row and one undo per tap; the board adds only doors.
- A week is the natural unit for "what did I do" and keeps the page short; the month is the unit for billing, so the
  CSV is monthly and separate from the page.
- Redirecting to the entry's own week (not where the owner came from) means the change banner and the new row are on the
  same page, whichever week the entry was added for.
- A select for billing on the new form is the only way, without JavaScript, to say "not billable" for a work type that
  is billable by default (a checkbox cannot tell "left alone" from "unticked": 0050 had to fix this once already).
- Not putting a rate in a row that mixes rates avoids printing a figure that times the hours does not give.

## Consequences

- A Monday morning with nothing logged yet shows an empty This week; Previous week is one link away.
- The Person select lists the first 300 people by name (and the Deal select the first 300 open deals); an entry for
  someone further down cannot be added from the form until the lists search. Hand entry through the AI app has no such
  limit.
- The selects name a person or deal from outside by id ("contact ct_...", "deal dl_..."), so they are hard to tell
  apart; the owner can use the person's page's Start timer instead.
- The CSV groups by person, not by deal, and a deal's time is in its person's row. A copy with several deals for one
  person gets one row per work type.
- `/companies` is no longer scored by Lighthouse; the accessibility test still visits it.
