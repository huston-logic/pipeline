# 0061: "On the board only" means what it says

Run 11, 2026-11-25. Replaces ruling 16 and owner call 2 of 0060 (their other rulings stand). No migration.

## Context

Run 10 built "Where AI changes are approved" (0060) with two gaps the owner then ruled on: under "On the board only" a
small change still applied at once if "Apply small changes" had been turned on earlier (ruling 16), and the AI's rule
tools (`add_rule`, `update_rule`, `resume_rule`, and `pause_rule`) still wrote at once because rules are configuration
(rule 5). Both let the AI change the pipeline without the owner's board yes, so the setting did not mean what it said.

## Decision

- Under `board`, nothing the AI app does applies at once. `recordWrite` uses `smallChangesApplyAtOnce` ("Apply small
  changes" is on AND approval is in chat), so a small change becomes a one-action proposal waiting on Pending changes,
  whatever "AI edits" says. The `aiEdits` value is kept, so it works again if the owner goes back to chat.
- The four rule tools propose too. They are four more proposal actions (`RULE_ACTIONS`, `proposal-actions.ts`), so a
  list can mix them with record changes, and Pending changes, the trial batch, the reads guard, expiry and the audit shape
  are reused. A rule tool calls `ruleWrite`: in chat it writes at once as before; under board it proposes and answers as
  `propose_changes` does.
- The list shows a rule in plain words, built from its settings (`ruleItem`): "Rule: <what it will do>" for a new rule,
  "Rule ru_...: now <was> -> <is>" for a change, "Rule ru_...: paused: <what it does>" or "resumed". The AI's own
  `description` shows beside that ("described as ...") only when it differs, so a description can't stand in for the
  settings (found in review: the first version drew only the description).
- "In chat" is unchanged: the rule tools write at once, and `propose_changes` refuses rule actions there (so nothing about
  chat behaviour moved). A list holds at most 10 rule actions (each reads its rule on its own; a test keeps a list under 40 D1 calls).
- Rule reads go through `ruleById` and the memo's stage rows, so an action sees the rows earlier actions planned.
- Wording: server rules 5 and 7, the tool descriptions, the Pending page hint, SPEC.md, UPDATING.md, ACCEPTANCE 49 and 50.

## Why

- A setting called "On the board only" that leaves two doors open is a false promise; the owner chose to close both.
- Reusing the proposal system means one approval path, one audit shape and one place that shows the owner what a yes does.

## Alternatives considered for the rule tools

- A separate "pending rule changes" table with its own board section: no mixing with record lists, a migration, a new
  page section, its own expiry and stale-row guard. About the same work as this and a second approval path to keep right.
- Leaving rules as configuration but showing them on the board after the fact (Changes already does): rejected by the
  owner's call, because the AI would still write first.

## Consequences

- With approval on the board, a quick "pause that rule" from the AI app now needs a board tap.
- A list proposed under board that holds a rule action can still be applied by the AI in chat if the owner switches the
  setting back to chat first; that is the owner's own yes in chat, as for any list.
- Still written at once under board, because they are configuration (rule 5) and the owner's calls cover only small
  changes and rules: stages, fields, person and project statuses, views, the rulebook, work types, client rates, campaign
  drafts and the settings the AI may change. The Pending page hint says "proposes", which is accurate, but the owner may
  want these gated too; a later call.
- A call in flight when the owner switches to board can still write once, audited and undoable (the setting is read before
  the write, with no guard in the batch). Accepted.
- A rule the AI proposes and the owner approves is stored as created by the owner, like every record the owner approves.
- The owner's calls in STATUS Needs Grant 6b (small changes, rule tools) are closed. Lighthouse's 22 pages stay approved.
