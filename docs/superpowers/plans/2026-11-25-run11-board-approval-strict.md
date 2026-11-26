# Run 11: Board approval, strict

One branch (`feat/board-approval-strict`), one PR. Brief: Grant's two calls from run 10, "On the board only" must mean
what it says. Decision 0061 replaces the two owner calls recorded in 0060's Consequences.

1. With "On the board only", a small change never applies at once, even when "Apply small changes" was set earlier.
2. With "On the board only", the AI's rule tools (`add_rule`, `update_rule`, `pause_rule`, `resume_rule`) wait for
   approval on the board, shown on Pending changes in plain words.

"In chat" stays exactly as it is. Fallback in the brief: if point 2 needs a larger design than one PR, do point 1, write
point 2's options and costs in the decision, and stop.

## Tasks

### Task 1: small changes wait on the board (point 1)
- `smallChangesApplyAtOnce(db)` in `src/services/settings.ts`: "AI edits" is small AND approval is chat; one settings read.
- `recordWrite` (`src/mcp/record-write.ts`) uses it instead of `getAiEdits`.
- Tests first (`src/mcp/approval.test.ts`): under board a small log_activity proposes and writes nothing; under chat it
  still applies at once.
- Wording: rule 7's last sentence, the `aiEdits` input description, the Pending page's hint for "On the board only".
- Review: one Sonnet reviewer.

### Task 2: rule changes wait on the board (point 2)
Design: rule actions join the proposal system (decision 0044) as four more actions, so one list can mix record and rule
changes and the Pending page, trial batch, reads guard, expiry and audit shape are reused.
- `add_rule`, `update_rule`, `pause_rule`, `resume_rule` inputs move to `src/services/record-inputs.ts` (shared by the
  tools and the actions); `RULE_ACTIONS` is a second list in `proposal-actions.ts`, not part of `RECORD_ACTIONS`
  (`RECORD_ACTIONS` tools always propose).
- `src/services/rules.ts` reads a rule through `ruleById` (`lookup.ts`, planned-read aware) and stages through the memo
  readers, so a list sees a rule an earlier action planned.
- `proposal-text.ts`: one item per rule action in plain words (the rule's own description sentence, then what changes);
  every column the change writes is shown or listed in `NOT_SHOWN`.
- Rule tools: under chat they write at once as today; under board they propose a one-action list and answer as
  `propose_changes` does. `propose_changes` itself takes rule actions only under board (chat refuses with a sentence
  that says to use the rule tool), so chat behaves exactly as before.
- Tests: proposal coverage, proposals-d1 (a rule list stays under 40 D1 calls), tool-list tests, e2e acceptance.

### Task 3: wording, docs, decision, status
- Instructions rule 5 (rules wait on the board), settings hint, SPEC.md, ACCEPTANCE.md, UPDATING.md, decision 0061
  and its index line, AGENTS.md architecture bullet "Board approval".
- STATUS.md: remove item 6b's two lines (keep the Lighthouse line), changelog, run 11 timing table.
- Full `npm run check`, then PR; `review-security` (touches /mcp) and `review-a11y` (Pending page copy only, no markup).

## Stop conditions
Anything that reaches a real client copy, a new dependency, a migration. None expected: no schema change.
