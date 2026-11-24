# 0045: The "AI edits" setting (record tools propose)

Run 6, task A2, 2026-11-24. Builds on 0044 (proposals: `propose_changes`, `apply_changes`) and 0004 (the MCP
endpoint). Migration 0015.

## Context

Decision 0044 added proposals, but the record tools (`add_lead`, `add_deal`, `add_contact`, `qualify_lead`,
`return_to_lead`, `update_contact`, `update_deal`, `log_activity`, `add_task`, `complete_task`, `snooze_task`) still
wrote at once, so an AI app could change records without showing the owner anything. The brief asked for the record
tools to propose by default, with an owner setting that lets small, everyday changes through at once, and fixed the
setting's values, the instruction text and which actions are small. It left open what a record tool answers when it
proposes, how its refusals read, and what "on an existing person or deal" means for a tool call.

## Decision

- **The setting** is `settings.ai_edits` (migration 0015): `review` ("Review first", the default for every copy, new
  or existing) or `small` ("Apply small changes"), with a CHECK on the two values. The service type is `AiEdits`;
  owners and the AI app use the words `review_first` and `apply_small` (`update_settings` `aiEdits`, `get_settings`
  `aiEdits`). Its summary is "AI edits: Review first" or "AI edits: Apply small changes" ("Updated settings: AI edits:
  Apply small changes (change chg_...)"); like every setting it is one audited change that `undo_change` reverses.
  Server rule 5 already covers it: change it only when the owner asks.
- **Small** (`isSmallAction`, `src/mcp/record-write.ts`): `log_activity` with type `call` or `note` whose deal and
  contact are existing records (an id or a name, never `@n`), and `complete_task`; decision 0049 adds `start_timer` on
  existing records and `stop_timer` without a next-step date. Everything else is proposed under both settings,
  including an email or meeting log, a snooze, a new task and every edit to a person or a deal.
- **How a small change names its records.** Applied at once, a small action runs its service directly, so a name is
  found with the services' exact-name lookup (`findContact`, `findDeal` in `src/services/lookup.ts`: an id or an exact
  name, and several matches are refused with each one's id), not with `name-match.ts` and its outside-name protection,
  which only a proposal uses. This holds for `log_activity` and `complete_task`, and alike for `start_timer` and
  `stop_timer` (decision 0049): `start_timer`'s person, deal or task is found the same way (`resolveLinks`,
  `findSubject`), and `stop_timer` names no record, only a work type (`findWorkType`: an id or an exact name). An exact
  name that came from outside can be matched here, as it always could by the record tools before proposals, and the
  change is one audited, undoable row.
- **The switch** (`recordWrite(deps, action)`): every record tool's `run` is
  `recordWrite(deps, { action: "<tool>", ...args })`. Names, inputs and annotations stay; each description ends with
  "Unless the owner chose Apply small changes and this is a small change, this returns a proposal for the owner to
  approve; nothing changes until apply_changes." (the words "and this is a small change" added in the run 6 final
  review, since a non-small action is proposed under both settings) A small action under Apply small changes runs its service at once (actor `ai`, the tool's name)
  and answers the service's summary line and the ids the tool always answered. Anything else calls `proposeChanges`
  with the one action and answers through `proposeResult` (`src/mcp/tools-proposals.ts`), the very function
  `propose_changes` answers with, so the list, the questions ("Which Dana? ..."), the JSON and the expiry are exactly
  what `propose_changes` gives for the same action.
- **Refusals read as the service's.** A one-action proposal's refusal would start "Action 1: "; `recordWrite` answers
  the service's own message instead ("Task \"...\" is already done ..."), so a record tool's errors read as they did.
  A refusal that isn't one action's (a list rule, a record that moved during the trial) is kept as it is.
- **What stays direct:** settings, rules, stages, fields, person statuses, sub-statuses, views, the rulebook, imports
  (`import_rows`/`apply_import` already wait for a yes, 0039) and `undo_change` (the safety net) write at once.
- **Instructions:** rule 4 now says "Each write answers with that line" (a record tool's first answer is a list, and
  the change line comes from `apply_changes`); a new rule 7 says record edits need the owner's yes, to send every
  action in one `propose_changes`, to show the list as returned, the three replies (`Yes`, `Yes with changes: ...`,
  `No`), and to ask rather than guess when a name matches several records. Since the run 6 final review it says it per
  setting: under Review first every record edit goes through `propose_changes`; under Apply small changes a small
  change (a call or note on an existing person or deal, completing a task, starting a timer, stopping one without a
  next-step date) uses its record tool directly, and everything else goes through `propose_changes`.

## Why

- Review first by default means no copy starts writing the owner's records without a yes; Apply small changes covers
  the taps an owner makes all day (log a call, jot a note, tick a task), which are one row each, easy to undo, and
  never close a deal or move a person by hand.
- An email or meeting log is not small: it can carry a long summary drafted by the AI, and a meeting usually comes
  with other edits the owner should see together. A snooze, a new task or a field edit changes what the owner will be
  reminded of, so it is shown first.
- `@n` points at a record a list adds; a single tool call has no list, so such an action is never "existing".
- Reusing `proposeChanges` and `proposeResult` keeps one planner, one store and one answer shape: a record tool can
  never propose something `propose_changes` would plan differently, and an AI app reads both answers the same way.

## Consequences

- **There is no server-side check that the owner said yes.** `apply_changes` writes whatever proposal it is given;
  the yes is the AI app showing the list and waiting, as the instructions and the tool descriptions tell it to. That
  is deliberate: the brief requires plain tools that work in any AI app (no elicitation or UI prompts), and before this
  change the record tools wrote directly with no step at all, so the proposal step adds review, not new access. An AI
  app that ignores the instructions can still call `apply_changes` at once, exactly as it could call `add_deal` before.
  Every applied change is audited and undoable as before.
- A record tool's first answer is now several lines (the list) instead of one change line, and its change is recorded
  under `apply_changes`, not the tool's name; a small change applied at once keeps the tool's name.
- A record tool given a name now goes through `name-match.ts` like `propose_changes`: two matches are a question, not
  the service's "matches more than one contact" refusal (that refusal still answers a small change applied at once).
- Logging a call on a New lead under Apply small changes also makes them Contacted (the service's own move), at once.
- Each proposed record tool call adds an open proposal. An AI app that never applies can't block edits: at ten open
  lists the next one drops the oldest open list (replaced by the new one, in the same batch; decision 0044 as amended
  by this task's review), so the newest ten wait and an apply of the dropped one says which list replaced it. The cost:
  a list the owner hasn't answered yet can be pushed out by ten newer ones; the AI proposes it again.
- Tests that used a record tool to write now go through the yes (`approved` in `tests/helpers/mcp-client.ts`,
  `approve` in the acceptance test), and docs/ACCEPTANCE.md says which sentences are proposed.
- D6 adds its time tools to `RECORD_ACTIONS` and decides which of them are small (starting a timer, stopping one
  without a next-step date, per the plan).
