# 0032: What it caught, a monthly report

Run 4, task B1, 2026-11-20. Builds on 0011 (daily brief), 0016 (grouping), 0022 (leads) and 0026 (lead rule). The
owner's brief (Part B) asked for one board page and one brief section: rules fired, tasks made, how many were acted
on, deals and value touched after a nudge, and leads added, contacted and qualified by source. No other reports.

## Context

The brief fixed the headline words but not the exact meaning of each count, which month a report is for, or how
outside text and archived records are treated. A count that means something slightly different on the page and in the
brief, or from one month to the next, would be worse than none.

## Decision

- **Months are the owner's calendar months.** A month runs from the owner's midnight on the 1st to the owner's
  midnight on the next 1st (`monthBounds`, from the timezone setting). A call logged at 11 PM on the 31st belongs to
  that month. Times stay stored as UTC.
- **Which months.** `/report?month=YYYY-MM`. The default is last month. Only finished months are offered, back 12
  months from last month; this month (still running), the future, and anything that is not exactly `YYYY-MM` fall back
  to last month. The value is never echoed. Previous and Next month links carry only a month string.
- **Rules fired** = rule firings whose `fired_at` is in the month. **Tasks made** = those firings whose task still
  exists (a firing with no task counts as fired, not as a task made).
- **Acted on** (of the tasks made, one per firing): the task has `done_at` set, whenever it was completed (a task
  finished six weeks later was still acted on), or a reach was logged on that deal or that person from the moment the
  task was made up to and including 7 days later. 6 days 23 hours counts; 7 days 1 hour does not; exactly 7 days
  counts. A reach before the task was made is not a response to it. "Reach" is `isReach` (0022): a form, email,
  call or meeting, or a note logged as a text; a plain note is not. "That person" is the firing's `contact_id`, so a
  lead nudge matches reaches on the person and a deal nudge also matches reaches on its person when the firing
  carries one; a reach on a different deal of the same person does not match a deal nudge that has no person.
- **Deals touched after a nudge** = distinct deals with at least one acted-on firing. **Value touched** = the sum of
  those deals' values (no value counts as 0; no currency, as elsewhere). A deal is read by id, so one archived, won
  or lost later still counts: it was nudged and acted on in that month. Lead nudges touch no deal.
- **Leads** are people with a lead status (now or once; `qualified` stays as history). In the month:
  - **added**: `contacts.created_at` in the month;
  - **contacted**: the person's first reach ever on their own record (`activities.contact_id`) falls in the month.
    Chosen over "first reach in the month for someone who held a lead status then", because earlier statuses are not
    kept (0026) and this is one fact that can be read in one query. A reach on a deal only (no contact id) is not
    counted for the person;
  - **qualified**: `lead_status = 'qualified'` with `lead_status_at` in the month.
  One person can be all three in the same month.
- **By source.** Sources are grouped as company names are in 0016 (`businessKey`: trimmed, inner spaces collapsed, case
  ignored). The label is the earliest spelling (by date added) that the owner or the AI gave; a group with only outside
  spellings shows the earliest of those and is marked "From outside" on the board. No or blank source is "No source",
  listed last. Rows are ordered by their total, then name.
- **Where it shows.** The board page under More, "What it caught" at `/report`. In the brief, on the owner's local 1st
  of the month, a "Last month" section after Leads with the four count lines and one line per source ("Leads from
  Referral: 2 added, 1 contacted, 0 qualified"). Only a source from outside makes its line untrusted. A month with
  nothing in it adds no section to the brief (the page still says "Nothing to report for October 2026."). Other days'
  briefs are unchanged. If reading the report fails, the brief goes without the section.
- **Code.** `composeCaught` (`src/report/caught.ts`) is pure and takes the month and timezone, so it applies the month
  boundaries itself. `src/report/load.ts` reads five statements however much data there is (firings, their tasks,
  reaches for those deals and people in the month and the 7 days after, those deals, and the lead rows with their first
  reach), with bound values only.

## Why

- Counting completed tasks whenever they were completed, and reaches only inside 7 days, keeps "acted on" generous to
  the owner's real work without letting an old, unrelated call count.
- Finished months only, so a number never changes under the owner's eyes except for late completions.
- One query for "first reach ever" keeps the report inside D1's statement limits on a big copy (0020).

## Consequences

- A task completed after the month ends can raise that month's "acted on" later; the report is a live reading, not a
  stored snapshot. The brief's lines are stored when the brief is composed and do not change.
- A lead whose first email was logged on a deal rather than the person is not counted as contacted.
- Nothing is stored for this report: no new table, no migration.
