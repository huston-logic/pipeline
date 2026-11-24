# 0049: Time entries, the timer, work types and client rates

Run 6, task D6, 2026-11-24. Builds on 0044 (proposals), 0045 (the AI edits setting) and 0046 (standalone tasks).
Migration 0018. The board's timer and time pages are D7 and D8 (decisions 0050, 0051).

## Context

The owner wants to time their work (FR-03) and bill it by the hour, with a rate per kind of work and a different rate
for some clients (FR-04). Time is a record like a note or a task: the AI app should propose it for the owner's yes,
and every write must be one audited change with one undo. Money must not drift: an entry billed at last month's rate
stays at that rate when the rate goes up.

## Decision

- **Off by default.** `settings.time_tracking` (0 or 1, migration 0018); `update_settings timeTracking true` turns it
  on. While off, every time service and tool, reads included, refuses with "Time tracking is off. The owner can turn it
  on (update_settings timeTracking true)." (`TIME_TRACKING_OFF`, `requireTimeTracking` in `src/services/settings.ts`).
  `get_settings` shows `timeTracking`.
- **Three tables.** `work_types` (`wt_`: name, unique among live ones ignoring case; `hourly_rate`, null for none;
  `billable_default`; position; archived), `client_rates` (`cr_`: a person's own rate for one work type; one live row
  per pair; clearing archives it) and `time_entries` (`te_`: person, deal and task, each optional; `started_at`,
  `ended_at` and `minutes`; work type; `billable`; `rate`; `notes`; `activity_id`; archived; `untrusted_fields`). All
  three are change tables (`PRIMARY_KEYS`, `ROW_NOUNS`, `BULK_ORDER` after tasks and activities, which an entry points
  at), in the JSON and CSV export, and in undo's dependency checks: a person, deal, task, note or work type an entry
  points at (and a person or work type a client rate points at) can't be removed by an undo.
- **One running timer, as an entry with no end.** `ended_at` and `minutes` are both null exactly while it runs (a
  CHECK), and `CREATE UNIQUE INDEX time_entries_one_running ON time_entries ((1)) WHERE ended_at IS NULL AND archived =
  0` lets only one such row exist (SQLite accepts the constant expression; no fallback was needed). `start_timer`
  refuses a second: "A timer is already running for <label> since 9:10 AM. Stop it first." (the day too when it
  wasn't today). A start that loses a race on the index gets the same answer.
- **An entry: 1 to 960 minutes (16 hours).** A start and either an end or minutes; the other is worked out (minutes
  from an end round up to the whole minute). Both, neither, an end not after the start, more than 16 hours, or an end
  in the future are refused in plain English ("Edit the start or end."). Links are checked like a task's: a deal's
  person is the entry's person; a task's deal and person are used when neither is given, and a task given with a deal or
  person must be theirs. An edit that moves the start keeps the end; giving minutes keeps the start. Entries are
  archived (`update_time_entry archived true`), never deleted.
- **Stopping.** `stop_timer` ends the running entry at `ctx.now` (or the `startedAt`/`endedAt` given), minutes rounded
  up, at least 1, and in the same change logs its notes as a `note` activity on its person or deal (none with no
  subject; the notes stay on the entry either way, and `activity_id` links the note), and with `nextStepDate` adds the
  task "Next step" (or "Next step: <deal title>" when the title is the owner's) due then on the same subject. The note
  is logged at the moment of stopping, as `log_activity` logs one, not at the entry's end. A timer older than 16 hours
  can't be stopped without `startedAt` or `endedAt`: "The timer has been running since Wed Nov 18, 9:00 AM (25 h), and an
  entry can be at most 16 hours. Edit the start or end: stop it with startedAt or endedAt." A timer left running past
  midnight stores its real span; nothing is split by day. Undoing a stop puts the timer back running (refused while
  another one runs) and removes the note and the task.
- **Rates.** `rateFor(work type, person)`: the person's live client rate for the work type, else the work type's rate,
  else null. A billable entry stores that rate when it is saved (a timer when it stops); a non-billable one stores
  null. A later rate change never rewrites an entry. Editing an entry's work type, person or billable (any of them in
  the patch) works the rate out again from today's rates; editing only its times or notes keeps it. Billable defaults
  to the work type's `billable_default`, and to not billable with no work type. Rates are hourly only, 0 to 100,000,
  kept in cents. The amount is `rate x minutes / 60`, rounded to cents when read, never stored.
- **Money and length as the owner reads them** (`src/services/time-format.ts`): "$95.00" and "1 h 30 min". Deal values
  stay plain numbers (they have no currency); billed time has a dollar sign and cents. One line serves summaries and the
  proposal's Time group: "1 h 30 min, Design, billable at $95.00/h ($142.50), for Pat Example".
- **MCP tools.** Record actions, added to `RECORD_ACTIONS` and proposed under Review first: `start_timer`, `stop_timer`,
  `add_time_entry`, `update_time_entry`. Under Apply small changes, `start_timer` (on records that exist) and
  `stop_timer` without `nextStepDate` apply at once (`isSmallAction`). `start_timer` and `add_time_entry` may name an
  earlier action's person, deal or task with `@n`. Configuration, written at once, only when the owner asks (rule 5):
  `add_work_type`, `update_work_type` (rename, rate, billable default, archive or restore), `set_client_rate` (null
  clears). Reads: `list_time` (`period` this_week, last_week, this_month or last_month, or `from` and `to`, local dates,
  at most 366 days; `contact`, `deal`; totals and the running timer; at most 200 entries back) and `list_work_types`.
  The server instructions gain one line saying this.
- **Proposals.** The Time group lists each entry the plan writes as its line: "Time 1 h 30 min, Design, billable at
  $95.00/h ($142.50), for Pat Example"; a started timer "Timer started now, Design, for ..."; an edit "...: was
  <old line>"; an archive "...: archived". A stop proposed with no end is stored with `endedAt` = the time it was
  proposed (`withStopTimes`), so the owner's later yes stores the span they were shown and the apply's list matches the
  stored text. A start proposed now starts at the yes (the list says "now" either way). A timer started in a list
  can't be stopped in the same list ("Use add_time_entry with the start and end instead"), since the stop's note
  would be written after the entry that points at it.
- **Periods.** `periodOf` gives local dates in the owner's timezone; weeks start on Monday. `listTime` counts finished,
  unarchived entries that started in the period; `timeByClientMonth` gives one row per person for a month ("No
  person" last).

## Why

- A running timer as an entry with no end needs no second table and makes a stop an ordinary update; the index makes
  "one at a time" true for every writer, the board's and the AI app's alike.
- Fixing the rate on save is how an invoice works: what was billed stays billed. Recomputing on an edit of the work type,
  person or billable is what the owner means when they correct those; the board's edit (D8) relies on it.
- The 16-hour cap catches the forgotten timer before it bills a night's sleep, and the refusal names the way out.
- Off by default keeps the AI app from offering time to owners who never asked for it.

## Consequences

- A rate change shows only on new time. An owner who wants old entries at the new rate edits their billable or work
  type, entry by entry.
- A proposed start begins at the yes, not at the ask; under Apply small it begins at once.
- Time of no one's is allowed (admin, travel) and shows as "No person" in totals.
- Undo refuses to remove a work type with entries or client rates, and a person with entries; archive the work type
  instead.
- The board shows nothing of time yet; the export page lists the three tables.
