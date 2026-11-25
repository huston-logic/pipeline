# 0060: Approving AI changes on the board

Run 10, 2026-11-25. Builds on 0044 and 0045 (proposals, the "AI edits" setting). Migration 0025. The design is in
`docs/superpowers/specs/2026-11-25-projects-finished-design.md`, "Area 5".

## Context

Run 6's ruling 15 left open where the owner approves a proposed list. Until now the owner says yes in the AI app's chat
and the AI app calls `apply_changes`. Some owners want to read the list and approve it on the board, where nothing the AI
app says can stand in for their yes.

## Decision

- A setting, `settings.ai_approval` (migration 0025): `chat` (the default) or `board`. Shown as "Where AI changes are
  approved" with "In chat" and "On the board only". Nothing changes for a copy until the owner chooses.
- Page `/pending` ("Pending changes", under More; `src/board/pages/pending.ts`, posts in `src/board/pending-actions.ts`).
  It lists each open proposal with its stored text. Approve runs the same `applyChanges` as the MCP tool, as the owner
  (actor `owner`, tool `apply_changes`), so the guards and the audit row are the same. Discard drops the proposal; it is
  scratch space, so it is not audited. The page also holds the setting form, and Today shows a notice when something is
  waiting.
- Under `board`, the AI's `apply_changes` refuses with a link to `<origin>/pending`, its `undo_change` refuses for every
  change with a link to `<origin>/changes`, and its `apply_import` refuses with the board import link
  `<origin>/import/<draft>`.
- Propose and apply read the setting through the request memo (undo and apply_import read it directly), so a maximum-size propose and apply stay at 40 D1 calls or fewer (a
  tool-level test keeps it).
- Ruling 15: the AI app may tighten the setting to `board` but never loosen it. Loosening is the board's.
- Ruling 16: board-only approval leaves "Apply small changes" as it is. The AI may not set `aiEdits` to `apply_small`
  while the setting is `board`.

## Why

- The board is the one place the owner is signed in and no record text can speak. An approval there is the owner's.
- Letting the AI loosen the setting would let it remove the gate it was put behind.
- Reusing `applyChanges` means there is one apply path to test and one audit shape.

## Consequences

- Owner call 1: under `board`, small changes still apply at once if "Apply small changes" was set earlier (ruling 16). The
  owner can set it back to Review first.
- Owner call 2: under `board`, the AI's rule tools (`add_rule`, `update_rule`, `resume_rule`) still write at once, because
  rules are configuration (rule 5).
- Undo by the AI app is unavailable under `board`; the owner undoes from Changes.
- Discarded proposals leave no trace; an open one expires after 2 hours as before.
