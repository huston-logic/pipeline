# 0048: Capture through the AI app

Run 6, task C5, 2026-11-24. Builds on 0044 (proposals), 0045 (the AI edits setting) and 0046 (standalone tasks).
Migration 0017.

## Context

The owner rambles to their AI app (a voice note, a list of things to do) and expects it all to land in the pipeline:
tasks on the right person, a note on a deal, a stage move. The pieces already exist: `propose_changes` takes up to 25
actions in one call, matches names in code and turns an unclear name into a question, and a task may belong to a
person, a deal or nothing. What was missing was telling the AI app to use them that way for a ramble, and giving the
owner a place to adjust how it does so.

## Decision

- **No new tool, no AI call in the product.** Capture is the existing `propose_changes` and `apply_changes`, steered by
  words.
- **Server instructions (`src/mcp/instructions.ts`)** gain one line under "Also": turn all of a ramble into one
  `propose_changes` call (tasks on a person, a deal or nothing; notes on the right person or deal; dates in the owner's
  timezone; stage moves); leave out anything unsure and ask after showing the list; with the example "Call Dana Friday,
  send Matt the deck, buy printer ink" as three `add_task` actions. A test checks the line word for word.
- **A `capture` rulebook document** (migration 0017 for existing copies, `seed/defaults.sql` for new ones) holds the
  same guidance in the owner's own words, plus how to tell the kinds apart: words like call, email, send, buy are
  tasks; "she said", "we talked" are notes; "move to", "booked" are stage moves. The owner edits it like any document.
  The migration is `INSERT OR IGNORE`: a copy that already has a `capture` document, and every other document, keeps
  its text and version. A test checks that the migration and the defaults hold the same text.
- **`list_tasks`** (read-only, `readOnlyHint: true`): the owner's AI app could add an undated standalone task but not
  list it, so it could not find a task's id or check what a capture wrote. Inputs, all optional and strict: `status`
  open (default) or done, `contact` and `deal` (id or name, resolved like `get_deal`; an ambiguous name is a refusal
  listing ids), `standalone` (only tasks with no person and no deal; refused with contact or deal), `limit` 1 to 100
  (default 50). Open means not done: snoozed tasks are included, with `snoozedUntil`. Order: due first (overdue ahead),
  undated last, then newest. The headline is a count only; each item lists `untrusted_fields` (an outside title is
  named there). Items use the camelCase names the other read tools use (`dueAt`, `snoozedUntil`, `doneAt`, `dealId`,
  `contactId`), not snake_case. A contact filter takes the person's own tasks and their deals'. Code:
  `listTaskItems` in `src/services/read.ts`. It is recorded here rather than in 0046 because capture is what needed it.
- **Acceptance sentence 26** (the plan called it 21; run 5 already uses 21 to 25): "Call Dana Friday, send Matt the
  deck, buy printer ink." One proposal with three tasks (Dana's and Matt's on them, the ink one on no one), one
  `apply_changes`, one `undo_change`. `tests/e2e/capture.test.ts` drives it over MCP.

## Why

- The risk in a ramble is a guess: the wrong Dana, a task invented from an unclear phrase. Showing the whole list
  first, with names matched in code, leaves the owner the yes, and leaving out what the AI is unsure of turns a guess
  into a question.
- Words in a rulebook document, not code, because how an owner talks differs (some say "ping", some say "text") and
  the AI reads that document before its first write anyway (server rule 1).
- One call, one yes and one undo is the whole point of 0044; a ramble of ten items should cost the owner one reply.

## Consequences

- Nothing new can be written that a proposal could not already write: every action goes through the same checks,
  trial and audit as any other. The rulebook text is advice, not a permission.
- The document is trusted text the owner controls; nothing outside text is copied into it.
- The demo seed is unchanged. The e2e test adds Matt Example itself and relies on the seed's Dana Whitfield being the
  only Dana.
