# 0010: The rules engine

## Context

The spec names three rule types (`stage_followup`, `on_stage_enter`, `gone_quiet`), says firing is idempotent (one
task per rule, per deal, per stage entry), that rules can be paused and resumed, and that `preview_rule` says which
deals a rule would have caught in the last 30 days without changing anything. It left open what "no logged activity"
means, when `on_stage_enter` starts counting, how tasks are dated, how firings interact with undo, and how the preview
rebuilds the past, since the database keeps only each deal's current stage.

## Decision

- **Shape.** `src/rules/engine.ts` is pure: `evaluateRules`, `quietDeals`, `isQuiet` and `previewRule` take plain data
  and return plain data. `src/services/rules.ts` loads the data, checks the parameters and writes the results. The
  hourly Cron Trigger (`"0 * * * *"`) calls `runScheduled` in `src/cron.ts`, which runs each job in `CRON_JOBS` in
  order (`rules`, then the daily brief of decision 0011) and logs only `{"event":"cron_<job>_done", ...counts}` or
  `{"event":"cron_<job>_failed"}`. The handler awaits the run instead of using `waitUntil`, so the invocation lasts
  exactly as long as the work and `wrangler dev --test-scheduled` returns after it.
- **Parameters.** Checked with zod per type (strict, so another type's field is refused by name) and stored
  normalized: the stage as its key. `stage` must be a stage that is not archived and is an *open* stage: rules only
  watch open deals, so a closed stage would never fire, and the refusal lists the open stages. `days` is a whole
  number from 1 to 365 (`stage_followup`, `gone_quiet`), `dueInDays` from 0 to 365. Titles may use `{deal}`,
  `{contact}` and `{stage}` and nothing else; the default `stage_followup` title is "Follow up with {contact} about
  {deal}". A description is generated from the parameters unless one is given; `update_rule` rewrites it when the
  parameters change and no new description is given. Rules are never deleted; `pause_rule` and `resume_rule` flip
  `active` and refuse a no-op.
- **When rules fire** (open, non-archived deals only):
  - `stage_followup`: once `stage_entered_at + days` has passed and there has been no contact since the deal entered
    the stage, meaning `last_activity_at` is null or not after `stage_entered_at`. Contact means a form, email, call,
    meeting or note, including one logged with only the contact (decision 0009, addendum 2). The task is due at
    `stage_entered_at + days`. It also catches deals that were already overdue when the rule was added.
  - `on_stage_enter`: for stage entries at or after the rule's `created_at` (so adding a rule doesn't flood old
    deals), due `stage_entered_at + dueInDays`.
  - `gone_quiet`: never creates tasks. `quietDeals` lists open deals whose last contact (or creation, with none) is at
    least N days ago, one entry per deal and rule; `list_deals`' `quiet` filter uses the same `isQuiet` test.
  - Days are 24-hour periods, not calendar days, so a due time can move by an hour across a clock change.
- **Cut-over (`since`).** Pausing and resuming, or pointing a rule at another stage, must not make a rule fire for
  history. The services keep a `since` time in the rule's stored parameters (UTC ISO; the owner and the AI cannot set it,
  and it is left out of `add_rule` / `update_rule` input): `resume_rule` sets it to now on a `stage_followup` or
  `on_stage_enter` rule, and `update_rule` sets it to now when it changes an `on_stage_enter` rule's stage. Undoing a
  `pause_rule` is a resume too, so the undo sets the same cut-over (`resumedParams`, final review); without it the
  undo brought back the old parameters and fired at once for every entry made while the rule was paused. A stage entry
  before `since` never fires, for either type. An `on_stage_enter` rule still ignores entries before its own `created_at`;
  `since` only moves that line later. Undoing the resume or the update restores the parameters, so the cut-over goes
  with it. `stage_followup` rules keep their catch-up for deals already overdue when the rule is added, but not after
  a resume. `gone_quiet` has no cut-over: it only lists. The preview ignores `since`, like `created_at`.
- **Idempotency.** The fire key is `${ruleId}:${dealId}:${stageEnteredAt}`, unique in `rule_firings`. Each firing is one
  `system` change (tool `rules`) that inserts the task (`source` = the rule id) with the `rule_firings` row in `extra`,
  so it is in the same batch but not in the snapshot. A second run skips keys already fired; a run racing another one
  hits the UNIQUE constraint, and that firing is counted as `alreadyFired` and skipped, not an error. Other write
  failures are counted as `failed` and retried on the next run. A later re-entry into the stage has a new
  `stage_entered_at`, so it fires again.
- **At most 25 firings per run** (`MAX_FIRINGS_PER_RUN`, final review). Each firing is one D1 batch, and a catch-up
  (a new `stage_followup` rule over many overdue deals) could otherwise run past the free plan's per-invocation limits
  and starve the daily brief, which runs in the same invocation. The rest are counted as `deferred` in the
  `cron_rules_done` log line and fire on the next hourly run; their fire keys are not written, so none is lost or
  doubled.
- **Outside text.** A rule task whose title pulled in outside text (`{contact}` when the contact's name is in its
  `untrusted_fields`, `{deal}` when the deal's title is) is stored with `untrusted_fields: ["title"]`. Change summaries
  name the task, the deal and the contact through the safe labels (`labels.ts`).
- **Undo.** Rule firings are kept outside undo. Undoing the change that created a rule's task deletes the task; the
  firing row stays (its `task_id` becomes null), so the rule does not fire again for that stage entry. Because a firing
  row points at its deal and its rule, undoing the `add_lead` that created a deal a rule has fired on is refused: "this
  lead has rule history ..., so it can't be removed. Close the deal instead: update_deal with status lost or not_now."
  Undoing an `add_rule` whose rule has fired is refused the same way, pointing at `pause_rule`.
- **Preview.** `preview_rule` takes a saved rule's id or a new rule's settings (checked like `add_rule`), reads
  everything and writes nothing. It rebuilds each non-archived deal's stage history from its `stage_change`
  activities (`data.from` / `data.to`): the first stay starts at the deal's creation in the earliest change's `from`
  stage (or the current stage when the deal never moved), and the current stay starts at `stage_entered_at`. It
  returns each hit as the deal and contact ids, a safe label (outside titles and names become id labels) and
  `wouldFireAt`, plus a headline count of deals and firings.
- **Preview lookback** (final review). The preview reads only activities from the last 30 + 365 days (the window plus
  the longest `days` a rule may have), not the whole history. This is exact, not an estimate: a hit in the window
  comes from a stage stay or a quiet spell that began at most 365 days before the window starts, and an older
  activity can only move a stay's or spell's start further back, before that line, where it cannot produce a hit. A
  bounded lookback was chosen over "since the earliest relevant stage entry" because it is one indexed condition and
  needs no extra query. Deals are still read in full (docs/PAID-PLAN.md).

## Why

Pure functions make every rule testable without a database, and one change per firing keeps the audit log honest
(each task says which rule made it) while the fire key, kept out of the snapshot, makes "undo the task" mean "I don't
want it", not "make it again". Refusing closed stages and unknown placeholders up front is kinder than a rule that
silently never fires or a task title with a literal `{name}` in it.

## Consequences

- **Preview approximations.** The preview is an estimate, and its answer says nothing was changed:
  - It reports exact thresholds; the real run is hourly, so a firing happens up to an hour after `wouldFireAt`.
  - It ignores `on_stage_enter`'s "only entries after the rule was created" and `since` (the point is what it would
    have caught)
    and whether a rule was paused at the time.
  - Contact is read from the activity history, while the live run reads `last_activity_at`; they agree unless rows
    were edited outside the services (seed data, SQL).
  - `gone_quiet` is previewed for deals that are open now, once per deal, at the first moment in the window it was
    quiet; a deal closed since is left out.
  - Stage moves made before the service layer recorded `stage_change` activities (seed data, imports) are not seen:
    such a deal looks as if it sat in its current stage since `stage_entered_at`.
  - An undone stage move removes its `stage_change` activity, so the history follows the undo.
- A rule keeps pointing at its stage key after the stage is renamed or archived (it then never fires;
  `archive_stage` already refuses while open deals sit in it). On a rename, `update_stage` rewrites the description
  of every rule watching the stage whose description is still the generated one for the old label (it equals
  `describeRule` of the old label), in the same change, so undoing the rename restores both; a description the owner
  or the AI wrote is kept (final review). Undoing an `add_stage` is refused while a rule watches the stage (decision
  0009, addendum 4).
- The hourly run reads every open deal and the fire keys of open deals once per hour; CPU time grows with open deals ×
  stage rules (docs/PAID-PLAN.md).
