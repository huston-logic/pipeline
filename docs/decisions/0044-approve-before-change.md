# 0044: Approve before change (proposals)

Run 6, task A1, 2026-11-24. Builds on 0009 (change records and undo), 0035 (one change at any size), 0036 and 0039
(import drafts and the MCP import's preview-then-apply), 0022 and 0040 (leads, person status, invariant 1).

## Context

The owner wants the AI app to propose record changes and write them only after a yes, as one change with one undo
(FR-02): "Log my call with Dana and move her deal to Call booked" is two tool calls today, two changes, and nothing
is shown before it happens. The brief fixed the tools (`propose_changes`, `apply_changes`), the owner's three answers
(`Yes`, `Yes with changes: ...`, `No`), the caps (25 actions, 10 open lists, 2 hours) and that a list comes from the
rows the change would write. It left open how a list is planned without writing, how apply knows nothing moved, how a
later action names a record an earlier one adds, how names are matched, and how the list reads.

## Decision

- **A proposal is scratch space** (migration 0014): `proposals (id 'pr_…', actions JSON array, reads JSON object,
  status open|applied|dropped, replaced_by, change_id, created_at, expires_at) STRICT`. Like `import_drafts`: not a
  change table, not audited, not exported, never logged. `isProposalId` in `src/ids.ts`.
- **Collect mode** (`src/services/plan.ts`). With `ctx.plan` set, `commitChange` hands the service's `ChangeInput` to
  `PlanCollector.record` and returns `{ changeId: plan.changeId, summary }` without touching the database. The
  collector keeps each row once, in the order first touched: the first `before` (read from the database) and the
  latest `after`, with `version` = that `before.version + 1` (an added row keeps version 1). `extra` and `leading`
  statements are kept in order; a bulk input or an undo is refused. `build(target, summary)` gives the one merged
  `ChangeInput`; `reads()` gives `"<table>:<id>": version read` (null for a row it adds) for every row it writes.
- **Planned reads** (`src/services/lookup.ts`). Every read a record service makes by id (contact, deal, task) and its
  list reads of related rows (a person's open deals, the open-deal count, a deal's open tasks, the email and business
  duplicate checks, the "Check back" duplicate) take a `Source` (a database, or a ctx) and see the plan first
  (`contactById`, `dealById`, `taskById`, `openDealsOf`, `contactByEmail`, `withPlanned`). So the second action on a
  row reads what the first one planned, and the merged change is exactly what running them one by one would write.
  `record` refuses (an internal error) a write whose `before` is not the planned row, so a read that still goes to the
  database fails loudly instead of losing an earlier action's edit. The test "apply equals running the actions one by
  one" proves the reads are complete for the record actions.
- **Guards in `extra` check the final state.** In the merged batch, a service's guard (such as `noOpenDeal` for a new
  lead status) runs after every row write, as it did in its own batch. So two actions can each be fine alone and fail
  together; the trial below refuses such a list at propose time.
- **The trial.** A proposal is never stored if its apply would fail on the database as it is now. After planning,
  propose runs apply's exact batch (`changeBatch` in `change.ts`, which `commitChange` also uses, so the statements
  are built once): the proposal's own row, the leading "still open" guard, the row guards and writes, the extras with
  the "mark applied" statement, and the audit rows, followed by a sentinel that always fails with a message nothing
  else can give (`NOT NULL constraint failed: proposals.created_at`), so D1 always rolls the batch back. The sentinel's
  error means the list would apply, and it is stored. Any other error stores nothing and is refused in plain English:
  a guard failure is traced by trying the first m actions for m = 1, 2, …; the first prefix that fails, and the guard
  from an earlier action j that fails on it, give "Action m and action j can't be in one list: <reason>. Send them as
  two lists." (the reason is the guard's, `withGuardReason`; `noOpenDeal`'s is "a lead can't have an open deal").
  When the rows alone fail, a record moved between the plan and the trial ("A record in this list changed while the
  list was being made, so nothing was proposed. Send the list again."). A duplicate email and a foreign-key failure
  have their own sentences. The collector keeps which action each extra came from (`startAction`, `extraSources`).
  After a trial that passed, a guard failure at apply really is a change since.
- **Actions** (`src/services/proposal-actions.ts`). Each is a record tool's input (`src/services/record-inputs.ts`,
  which the tools in `src/mcp/tools-write.ts` also use; its schema pieces are in `src/services/input-schemas.ts` and
  the plain-English schema errors in `src/services/input-errors.ts`, both re-exported by `src/mcp`) plus `action`, the
  tool's name: `add_lead`, `add_deal`, `add_contact`, `update_contact`,
  `update_deal`, `qualify_lead`, `return_to_lead`, `log_activity`, `add_task`, `complete_task`, `snooze_task`.
  `runAction` runs one through its service. Task D6 adds the time actions.
- **`@n`** names the person or deal action n adds (`add_lead`, `add_contact`, `add_deal`, `qualify_lead`), only as the
  `deal` or `contact` of a later `log_activity` or `add_task`. Anything else is refused: "Action 3 changes the person
  action 1 adds. Put those details in action 1 instead." A later action number, an action that adds no record of the
  kind named ("Action 2 names @1, but action 1 adds no task."), and a person given as a deal are refused in plain
  English too. The stored actions keep `@n`; it is bound to the id the earlier action added each time the list is
  planned ("Action 2: Action 1 adds no deal, so @1 can't be used as the deal here." when it added none).
- **Name matching** (`src/services/name-match.ts`). A ref is an id; else an exact name or title, ignoring case and
  extra spaces; else the non-archived records whose name has the ref as a whole word or the start of a word ("Dana"
  finds "Dana Example") or whose business is the ref. A deal is also its person's one open deal; a task is matched
  among open tasks. One match is used. Several, or none, are a question naming each candidate by `contactRef`,
  `dealLabel` or `taskTitle` with its id ("Which Dana? Dana Example (ct_…, …) or Dana Sample (ct_…). Send the list
  again with the id."). A match on a name, business or title that came from outside (`untrusted_fields`) never wins
  and never stands in alone: when any candidate matched only on outside text, every candidate is listed as a question
  (an intake contact named "Pat" doesn't beat, or replace, the owner's Pat Example). More than 10 candidates is one
  answer, without reading their deals (so no read binds more than 100 parameters): "\"D\" matches more than 10
  people. Use more of the name, or the id." With any question nothing is stored and every question is answered at
  once. Refs are matched against the database only, before anything is planned.
- **Propose.** Check the actions (schema, 1 to 25, `@n`), resolve every ref to an id, plan them with a fresh
  collector (a service's refusal comes back as "Action N: <message>", nothing stored), render the list, and insert the
  proposal (resolved actions, `reads`, the rendered `text`, `expires_at` = 2 hours on) in one batch whose guard keeps
  at most ten open lists. Each of the three is one bound parameter, so a list whose actions, reads or text would be
  over `CHUNK_BYTES` (as `bulk.ts` measures) is refused first: "This list is too long to keep. Send it as two lists."
  At the cap an 11th list is not refused (amended by task A2's review, see 0045): the same batch first drops the
  oldest open, unexpired list (status `dropped`, `replaced_by` the new id), so the guard still holds exactly ten, and
  applying the dropped one answers "pr_x was replaced by pr_y. Apply pr_y if the owner said yes to it." Expired lists
  don't count and are never dropped. (The earlier refusal, "Ten proposals are waiting. ...", is retired.) With
  `replaces`, the old list must still be open; it is marked `dropped` with `replaced_by` in the same batch and does not
  count towards the ten, so a revised list at the cap drops only the one it replaces. A "No" writes nothing: the list
  just expires.
- **Apply.** Unknown is "No proposal pr_x. Propose the changes again."; applied answers its change's line and writes
  nothing; dropped is "pr_x was replaced by pr_y. Apply pr_y if the owner said yes to it."; expired is "pr_x expired at
  3:40 PM. Propose …". Otherwise the actions are planned again with `ctx.now` the apply time. The fresh `reads()` must
  match the stored ones in order: every row it updates the same row at the same version, every row it adds in the same
  place and table. Any difference is "<Record> changed since this list was made. Propose the changes again and show the
  owner the new list." (the record by its label now, `labels.ts`). Labels, field definitions and the timezone aren't
  rows the plan writes, so the fresh plan's list is rendered too (with the shown ids and the stored expiry) and must be
  the stored `text` exactly; otherwise "pr_x's list would come out different now (a stage, status, field or setting
  changed). Propose the changes again and show the owner the new list." Then one `commitChange` (tool
  `apply_changes`, `changeId = plan.changeId`, the caller's actor: the tool's is `ai`) with a leading guard that the
  proposal is still open and unexpired and an extra statement marking it applied with the change id. It is a bulk
  change when it has more than 50 rows or its before or after snapshot would be over `CHUNK_BYTES` (both are one
  bound parameter of the audit row otherwise). A lost race answers as the winner left it: applied gives the first
  change's line, replaced gives "pr_x was replaced by pr_y…". Summary: "Applied pr_x: <each action's summary, joined
  with "; ">", cut to 500 characters with "…".
- **The ids the owner saw are the ids written.** Planning again makes new ids for added rows; apply swaps each one for
  the id stored at the same place in `reads`, in every row and in the summary, so the list's ids are the records'.
  Statements in `leading` and `extra` are already bound and can't be swapped, so none may be bound to a swapped id:
  a service that adds such a statement declares the ids it binds (`withGuardReason(statement, reason, ids)`), and a
  statement that declares none may not come from an action that adds rows. `PlanCollector.checkShownIds` enforces
  this at apply with a plain internal error (a programming error, not the owner's). An action that takes `@n` must
  likewise never put a statement bound to the `@n` record in `extra` or `leading`.
- **The list** (`src/services/proposal-text.ts`) comes from the merged change's rows, never from the action text.
  Added contacts and deals are "Add" (each field set), changed ones "Update" (each changed column `old -> new`), tasks
  "Tasks", added activities "Notes" (a stage move's own activity is left out: the deal's Update line shows the stage),
  D6's time entries "Time"; empty groups are left out. Bookkeeping columns (`version`, `created_at`, `updated_at`,
  `untrusted_fields`, `last_activity_at`, `stage_entered_at`, `lead_status_at`, and `lead_status`, which moves with the
  person status the list shows) are not shown, and a row with nothing else changed is left out. Keys become the
  owner's labels (stage, person status and sub-status, custom field label, the record a task or note is for), dates
  are in the owner's timezone (a midnight date as the date alone), and a time the change stamps at the moment it is
  written (a task's done time) reads "now", so the list doesn't depend on when it is rendered. A value shows at most
  300 characters (with "…"); the record keeps the whole text. A record named from outside is named by id; an old value
  that was outside text reads "(text from outside)". The text ends with the three answers.
- **Tools** (`src/mcp/tools-proposals.ts`). `propose_changes { actions: 1..25, replaces? }` (write, not destructive:
  it writes only scratch space) answers the list, a blank line and the JSON `{ proposal, expiresAt, list }`, or the
  questions and `{ questions }`. Its text is several lines, so it answers through `toolText` (`src/mcp/format.ts`),
  which keeps the lines; every other tool keeps `toolResult`'s one-line headline. `apply_changes { proposal }` (write,
  destructive, idempotent) answers the change line and `{ changeId, proposal, applied }`. Both act as `ai`. The
  instructions name both tools and the three answers (A2 rewrites the record rules around them).
- **Cleanup.** The hourly run deletes open proposals past `expires_at`, and applied or dropped ones a day after they
  were made, so a second yes, or the old id of a revised list, still gets its answer for a day.

## Why

- Planning through the ordinary services keeps one source of truth for every rule (invariant 1, the lead moves, the
  Client move, the "Check back" task): a proposal can never write something the tool itself would refuse or do
  differently. A second planner would drift.
- Planning again at apply, rather than replaying the stored rows, makes the dates and times the apply's, re-checks
  every rule against the records as they are, and makes "changed since" exact: any version that moved, any row that
  appears (a new open deal now gets a last-contact time) or vanishes refuses, so the owner never approves one thing and
  gets another.
- Rendering from rows shows the side effects (a New lead becoming Contacted, a deal's stage move) and can't show
  something the change won't do.
- Two hours, ten lists and 25 actions are the import drafts' window and cap: long enough to answer, small enough that
  a forgotten list can't be applied a day later.
- Matching names but asking when unsure lets the AI write "Dana" while never guessing between two Danas.

## Consequences

- A guard a service puts in `extra` checks the merged batch's final state, so setting a lead status and then adding a
  deal for the same person can't be one list (each alone is fine): the trial refuses it at propose time, naming both
  actions. Every propose runs one extra rolled-back batch (and, only when it fails, a few more to name the cause).
- A new guard statement in a record service should carry a reason (`withGuardReason`), or the refusal falls back to
  "action m changes what action j checks".
- Names in actions are matched before planning, against the database, so an action can't name a record by a name an
  earlier action gives it; it uses `@n` (as a subject) or the id.
- Name matching uses SQLite's `LIKE` to find candidates, which ignores case for ASCII only: a name that differs only in
  the case of an accented letter may not be found, and becomes a "no one matches" question.
- A tool's input and an action share one schema (`src/services/record-inputs.ts`), so they never drift. `src/mcp`
  imports services, never the reverse (`src/services/layering.test.ts`).
- The stored text catches a renamed stage, status or field and a changed timezone (the expiry time moves with it). Two
  timezones with the same offset at that moment, and a change that shows nowhere in the list, are not caught; the
  versions of every row written still are.
- The trial relies on `proposals.created_at` being NOT NULL (migration 0014 says so beside the column; a test pins the
  sentinel's message).
- Task A2 makes the record tools propose (the "AI edits" setting); D6 adds time actions, time-entry planned reads and
  the "Time" group.
