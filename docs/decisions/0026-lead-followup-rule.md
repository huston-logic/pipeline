# 0026: The lead_followup rule

Run 4, task L5, 2026-11-20. Builds on 0010 (rules engine), 0020 (CPU and statement counts on a big copy) and 0022
(leads on contacts), which set what the rule does. This record settles what 0022 left open.

## Context

0022 adds one rule type, `lead_followup`: when a lead has been New or Contacted for N days with no contact logged
strictly after it entered that status, add a task on the person, once per status entry. It did not say how "no
contact" is measured, how lead firings share the hourly run's limit with deal firings, or what `preview_rule` says for a
rule that looks at the present.

## Decision

- **"No contact after it entered the status."** The engine compares the person's latest reach with `lead_status_at`
  using a strict `>`. Reach is what `isReach` says (a form, email, call or meeting, or a note logged as a text), on the
  person or on any of their deals. So the email that moved a New lead to Contacted, logged at that same moment, does
  not stop a Contacted rule. A plain note never counts.
- **A lead whose `lead_status_at` is null never fires** and is not loaded. Every write that sets a status stamps it;
  a null can only come from data written outside the services.
- **One query.** The hourly run reads the people in the watched statuses with their latest reach in one SQL statement
  (two correlated `MAX` subqueries), and reads the fire keys of open deals and of those people in one more. The
  statement count does not grow with the number of leads (a test checks). The SQL reach test mirrors `isReach`; a
  test runs both over every activity type and data shape.
- **One budget, deals first.** Deal firings and lead firings share `MAX_FIRINGS_PER_RUN` (25). Deal firings take the
  budget first, then lead firings, sorted oldest due first (then by person and rule), so the leads that have waited
  longest go first. Deals are real opportunities, and an imported cold list with a new lead rule could otherwise hold
  every deal reminder back for hours. What is left over fires on the next runs, and nothing is lost or doubled,
  because a fire key is written only with its task. As for deal firings already, a firing that fails for any reason
  but its fire key is tried again on every run and uses a budget slot each time.
- **Preview of the present.** A lead's earlier statuses are not kept, so `preview_rule` for `lead_followup` lists the
  leads the rule would catch now (`scope: "now"`), not the last 30 days (`scope: "last_30_days"` for deal rules). It
  honours the rule's `since`. Previewing a saved rule by id reads that rule's fire keys (one query, by rule id) and
  leaves out leads it already fired on for their current status entry, so they are not counted; previewing new
  settings has no firings to check. A saved lead rule that is paused catches no one (`paused: true`, no hits), and the
  headline says it is paused and would catch no lead until resumed, and then only leads whose status changes after
  that (resuming sets `since` to that moment). The headline otherwise is "This rule would catch N leads now. It shows
  who it would catch now, not the last 30 days. Nothing was changed." Hits carry `kind` ("deal" or "lead"); a lead hit
  has `dealId: null`, and the preview counts `leadCount` beside `dealCount`.
- **The clock starts when the status is set.** A status moves when the write is made, so a reach logged later with
  an earlier `occurredAt` (backdated) starts the Contacted clock at the time it was logged, not at the backdated time.
  The backdated reach that moved the status is not after the status began, so it doesn't stop the rule. By design: the clock
  measures how long the person has had the status in this system.
- **Settings.** `status` takes `new` or `contacted` (a label such as "Contacted" is read as its key); titles may use
  `{contact}` only (default "Follow up with {contact}"). Pause, resume and the `since` cut-over work as for
  `stage_followup`; changing the status or the days keeps the cut-over. Like `stage_followup`, a new rule also catches
  leads that were already waiting longer than N days, within the run's budget.
- **Undo.** A person with lead rule history can't be removed by undoing the change that added them: the refusal says
  to mark them Bad lead or Not a fit with `update_contact`. A person whose firings all came from deal rules gets the
  deal's message (close the deal), as before.
- **A rule whose stored settings can't be read** is refused in plain English by `update_rule` and `preview_rule`
  (pause it and add a new one), instead of an internal error.

## Why

- A strict `>` on the status time is the simplest test that keeps the call which caused the status from cancelling the
  reminder about it.
- Reading leads in one statement keeps the hourly run inside D1's per-invocation statement limits on a big copy.
- Deals first keeps the reminders that matter most on time when a catch-up is bigger than one run.

## Consequences

- A lead's reach on a deal's activity counts even when that activity has no contact id.
- `preview_rule` output has three new fields (`scope`, `leadCount`, `paused`) and `hits[].kind`; `hits[].dealId` can
  be null.
- With more than 25 firings due at once, lead reminders can arrive an hour or more late while deal reminders catch up.
