# 0023: Adding leads and deals: the calls 0022 leaves open

Run 4, task L2, 2026-11-20. Builds on 0022 (leads on contacts), 0009 (changes and undo) and 0012 (intake).

## Context

Task L2 splits the old `add_lead` into `add_lead` (a person with status New, no deal) and `add_deal` (what `add_lead`
did before), adds lead status to `update_contact`, the New to Contacted move on logging, and qualifying on `add_deal`,
`/intake` and a reopened deal. 0022 fixes the model and the rules; it leaves the exact words and a few edge cases open.

## Decision

- **Summaries.** `add_lead`: `Added lead <name> (New)`, plus `, from <source>`. `add_deal` for a new person: `Added
  contact <name> with deal "<title>" in <stage>` (it said "Added lead" before, which now means something else); for
  someone on file it is unchanged. When `add_deal`, `update_deal` or `log_activity` moves a status, the summary ends with
  `; <contact label> is now Qualified` (or `Contacted`), named through `labels.ts`. `/intake` says `new deal for an
  existing lead, now Qualified` and keeps `new lead` for a new person (0022: unchanged for new people).
- **Errors.** `add_deal` with no person: "A new deal needs a person: give their name, or an existing contact." The
  email and business refusals of `add_lead` name the person with `contactRef` (name, id and email when trusted; else
  "Contact ct_…").
- **The same status again.** `update_contact` with the status a person already has changes nothing and leaves
  `lead_status_at` alone (on its own it is "Nothing to change"), so the status time keeps meaning "entered this status".
  With Not now already set, a `followUpDate` alone adds the "Check back" task.
- **Follow-up dates.** Read with `parseWhen` (a date is midnight in the owner's timezone, a time is kept). The summary
  shows the date alone when no time was given. A date in the past is allowed (the task is simply overdue). The task's
  source is `owner` and its title is outside text when the contact's name is.
- **Open deals.** The refusal names the count: one deal points to `return_to_lead`; two or more say to close them, or
  all but one and use `return_to_lead` on that one (`return_to_lead` refuses a person with another open deal).
- **Auto-advance.** Any logged reach moves New to Contacted, even one dated before the lead was added: the person has
  been reached. `via` is checked in the service (only `"text"`, only on a note) and accepted by the board's log route only
  when the posted value is exactly `text`; any other value is ignored, so the note is a plain note.
- **Stale writes.** A change whose target is new (a log, a deal) but which also updates a row it read (the lead) names
  that row when a guard fails: "Contact ct_… changed since you read it." (or "A record this change touches" when it
  read several). `/intake` retries once on a stale write as it does on a duplicate email, so a lead edited at the same
  moment still gets its deal.
- **Business duplicates.** The check compares `businessKey` in code over the people not archived, because SQLite's
  `lower()` folds ASCII only. An empty business never matches; with an email the check is skipped (the email decides).
  `businessKey` lives in `lead-change.ts` and `read.ts` groups companies with it.

## Why

- Summaries and errors are the owner's record of what happened; "lead" has to mean one thing in them.
- Keeping `lead_status_at` on a repeat keeps the lead follow-up rule (task L5), which keys on it, from firing twice.
- Naming the row that really changed tells the owner what to re-read.

## Consequences

- The demo seed's old change log still says "Added lead … with deal" and `add_lead` for its deals; that is history and
  task L8 (import, export and the demo seed) can refresh it.
- Task L7 replaces the board's New lead page (it still posts a person and a deal, now through `add_deal`).
