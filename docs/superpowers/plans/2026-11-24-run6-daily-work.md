# Run 6: Daily work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The AI app proposes record changes and writes them only after the owner's yes, as one change with one undo
(FR-02); to-dos work like a list, with or without a person or deal (FR-06); rambling to the AI app becomes one
proposal (FR-05); and the owner can time work, with work types and hourly rates (FR-03, FR-04).

**Architecture:** A proposal is a stored list of record actions (`proposals`, migration 0014). Proposing plans the
actions through the ordinary services in *collect mode*: `commitChange` records each service's `ChangeInput` into a
collector instead of writing, and single-row reads see the rows already planned. The collector merges everything into
one `ChangeInput`; the proposal list is rendered from that plan's rows, so it shows exactly what would be written.
Applying plans again at apply time, refuses unless every row it reads still has the version it had when proposed, and
commits once. Tasks lose their "deal or contact" check (migration 0016). Time entries, work types and client rates are
records like any other (migration 0018); a running timer is a time entry with no end.

**Tech Stack:** Cloudflare Workers, D1, TypeScript run by Node type stripping, `node:test`, the D1 shim over
`node:sqlite`, `wrangler dev --local` for e2e, the MCP SDK v2 server already in the repo. No new dependency.

**Spec:** the owner's run 6 brief (summarised in `docs/PLAN.md`, "Run 6"), `docs/SPEC.md`, AGENTS.md, and decisions
0009 (change records and undo), 0014/0017/0018 (board writes and forms), 0021 (Ask Claude), 0022/0040 (leads and person
status, invariant 1), 0035 (bulk change), 0036/0039 (drafts and the MCP import's preview-then-apply). Read them.

## Global Constraints

- One branch and PR per task from a fresh `main` (`git switch main && git pull --ff-only`). A task that needs an
  unmerged one is built on a local branch stacked on it and rebased onto `main` before its push (run 5 ruling 7). TDD.
  `npm run check` before every commit; a failure stops the commit. Never `--no-verify`, never `[skip ci]`.
- Every write is one audited change with a one-line summary ending `(change chg_…)`, undoable, through the service
  layer. No delete tools. Headlines, summaries, questions and error messages never contain outside text
  (`src/services/labels.ts` names such records by id).
- Proposals are scratch space like `import_drafts`: not audited, not exported, never logged; ids `pr_` + 12 base32.
  At most 25 actions per proposal, at most 10 open proposals at once, each expires 2 hours after it was made.
- Standard owner replies, in the proposal text and the instructions, exactly: `Yes`, `Yes with changes: ...`, `No`.
- Plain tools and text only: no MCP elicitation, sampling or UI resources.
- Board: new paths in `boardRoutes` with fixed seed ids; a new kind of page takes a `lighthouseRoutes` slot (at most
  20: replace the slot of a kind another listed page already covers, and say which in the decision); CSRF on every
  form; one `<h1>`; 44 px targets; the `html` tag only; `board.css` tokens only; 375 and 1280 px; every action works
  with JavaScript off; outside text never in an address, a `<title>` or a link's text.
- Fake people only (`example.com`, `.org`, `.net`, `.test`).
- Migrations: 0014 (A1), 0015 (A2), 0016 (B3), 0017 (C5), 0018 (D6). Each passes the generic "from the previous
  version" test in `src/db/migrations.test.ts` (new tables get `FAKE_ROWS`) and the "from empty" test.
- Decisions: 0044 (A1), 0045 (A2), 0046 (B3), 0047 (B4), 0048 (C5), 0049 (D6), 0050 (D7), 0051 (D8); any extra call
  takes the next free number from 0052. Each judgment call also goes in STATUS.md under "Run 6 rulings (cost if wrong)".
- New MCP tools are added to `src/mcp/server.test.ts` and `tests/e2e/mcp.test.ts`, and to the server instructions.

## Review Focus

1. **"Log my call with Dana and move her deal to Call booked."** Two actions touching the same deal row must plan as
   one before → after per row, exactly what running them one by one would write (A1 test
   `apply equals running the actions one by one`).
2. **A yes that arrives after the board changed the record.** The owner edits Dana on the board between propose and
   yes: apply refuses in plain English, names the record by label or id, writes nothing, and the proposal stays open
   for a fresh propose (A1 test `stale proposal is refused`).
3. **Two people with the same first name.** "Dana" with two Danas on file is a question listing both, never a guess,
   and nothing is stored (A1 test `ambiguous name becomes a question`).
4. **Yes twice.** A second `apply_changes` on the same id (retry, a double "Yes") writes nothing and answers with the
   first change id (A1 test `apply twice writes once`).
5. **A timer left running overnight.** Stopping a timer started yesterday stores the real span; an entry longer than
   16 hours is refused with "edit the start or end" (D6 test `a timer over 16 hours asks for the times`).

---

### Task A1: Proposals: `propose_changes` and `apply_changes` (decision 0044, migration 0014)

The hard task. Opus implementer, Opus review plus a security review.

**Files:**
- Create: `migrations/0014_proposals.sql`, `src/services/plan.ts` (collector), `src/services/proposals.ts` (store,
  propose, apply), `src/services/proposal-actions.ts` (the action list, parsing and resolving refs),
  `src/services/proposal-text.ts` (rendering), `src/services/name-match.ts`, `src/mcp/tools-proposals.ts`,
  `src/mcp/record-inputs.ts` (the record tools' zod inputs, moved out of `tools-write.ts` so both use them),
  tests beside each, `tests/e2e/proposals.test.ts`, `docs/decisions/0044-approve-before-change.md`
- Modify: `src/services/change.ts` (`Ctx.plan`, `commitChange` defers to it), the single-row reads the record services
  use (`src/services/lookup.ts`, `src/services/tasks.ts` `findTask`, `src/db/queries.ts` `getContact`/`getDeal`
  callers inside services, `src/services/activities.ts` open deals of a contact) so they see planned rows,
  `src/mcp/tools-write.ts`, `src/mcp/server.ts`, `src/mcp/instructions.ts`, `src/cron.ts` (delete expired proposals),
  `src/db/db.ts` (row type), `src/db/migrations.test.ts`

**Migration 0014:**
```sql
CREATE TABLE proposals (
  id TEXT PRIMARY KEY,                         -- pr_ + 12 base32
  actions TEXT NOT NULL CHECK (json_valid(actions) AND json_type(actions) = 'array'),   -- resolved actions
  reads TEXT NOT NULL CHECK (json_valid(reads) AND json_type(reads) = 'object'),        -- {"<table>:<id>": version|null}
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'dropped')),
  replaced_by TEXT,
  change_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;
CREATE INDEX proposals_open ON proposals (status, expires_at);
```

**Interfaces (produces):**
```ts
// src/services/plan.ts
export class PlanCollector {
  readonly changeId: string;                       // the one change id the apply will use, chg_...
  record(ctx: Ctx, input: ChangeInput): ChangeResult;   // called by commitChange when ctx.plan is set
  /** The planned row (after every action so far), undefined when untouched, null when planned deleted. */
  row(table: ChangeTable, id: string): Row | null | undefined;
  /** Planned rows of a table matching a predicate, for list reads such as a contact's open deals. */
  rows(table: ChangeTable, match: (row: Row) => boolean): Row[];
  /** "<table>:<id>" -> the version read from the database before the first planned write (null: inserted). */
  reads(): Record<string, number | null>;
  /** One ChangeInput: each row once, earliest `before`, latest `after`, version = before.version + 1; extras in order. */
  build(target: { table: ChangeTable; id: string }, summary: string): ChangeInput;
  summaries(): string[];
}
// change.ts: interface Ctx { ...; plan?: PlanCollector }

// src/services/proposal-actions.ts
export type RecordAction =
  | { action: "add_lead"; ... } | { action: "add_deal"; ... } | { action: "add_contact"; ... }
  | { action: "update_contact"; contact: string; ... } | { action: "update_deal"; deal: string; ... }
  | { action: "qualify_lead"; ... } | { action: "return_to_lead"; ... }
  | { action: "log_activity"; ... } | { action: "add_task"; ... }
  | { action: "complete_task"; task: string } | { action: "snooze_task"; task: string; until: string };
// Each variant's fields are exactly the matching tool's input (record-inputs.ts), so a tool call and an action
// are the same object plus `action`. D6 adds "add_time_entry", "start_timer", "stop_timer".
export const RECORD_ACTIONS: readonly RecordAction["action"][];
export const recordActionSchema: z.ZodType<RecordAction>;   // discriminated union on "action"
/** Runs one resolved action through its service with ctx (which may carry a plan). */
export function runAction(ctx: Ctx, action: ResolvedAction, deps: { extraOwnerEmails: string[] }): Promise<ChangeResult>;

// src/services/name-match.ts
export type Match<T> = { kind: "one"; row: T } | { kind: "many"; rows: T[] } | { kind: "none" };
export function matchContact(db: Db, ref: string): Promise<Match<ContactRow>>;
export function matchDeal(db: Db, ref: string): Promise<Match<DealRow>>;
export function matchTask(db: Db, ref: string): Promise<Match<TaskRow>>;

// src/services/proposals.ts
export type ProposeAnswer =
  | { kind: "proposal"; id: string; expiresAt: string; text: string; list: ProposalList }
  | { kind: "questions"; questions: string[] };
export function proposeChanges(ctx: Ctx, input: { actions: RecordAction[]; replaces?: string },
  deps: { extraOwnerEmails: string[] }): Promise<ProposeAnswer>;
export function applyChanges(ctx: Ctx, id: string, deps: { extraOwnerEmails: string[] }): Promise<ChangeResult & { applied: number }>;
export function deleteExpiredProposals(db: Db, now: Date): Promise<number>;
export const PROPOSAL_MAX_ACTIONS = 25, PROPOSAL_MAX_OPEN = 10, PROPOSAL_TTL_MS = 2 * 60 * 60 * 1000;

// src/services/proposal-text.ts
export interface ProposalList { add: Item[]; update: Item[]; tasks: Item[]; notes: Item[]; time: Item[] }
export interface Item { record: string; id: string; fields: { field: string; from?: string; to: string }[] }
export function renderProposal(list: ProposalList, meta: { id: string; expiresLocal: string }): string;
```

How it works (the decisions the implementer cannot make alone):
- **Collect mode.** With `ctx.plan` set, `commitChange` calls `ctx.plan.record(ctx, input)` and returns
  `{ changeId: plan.changeId, summary }` without touching the database. `record` merges each `RowChange` into its map:
  a row seen before keeps its first `before` and takes the new `after`; `extra` and `leading` statements are kept in
  order. Bulk inputs are refused in collect mode (no record service uses bulk).
- **Planned reads.** Every single-row read a record service makes by id (contact, deal, task, and in D6 a time entry)
  and the "open deals of a contact" read go through helpers that return `ctx.plan.row(...)` when the plan has the row,
  else the database row. A planned row's `version` is the database version + 1, so `record` rewrites a `before` that
  came from the plan back to the first `before`. The test that proves this is the equivalence test below; any read the
  test shows missing is routed the same way.
- **New records in the same proposal.** An action may name a record added by an earlier action as `"@<n>"` (1-based
  action number), only as the subject of `log_activity` or `add_task` (D6 adds `add_time_entry` and `start_timer`).
  Any other use is refused: "Action 3 changes the person action 1 adds. Put those details in action 1 instead."
- **Name matching** (`name-match.ts`): an id; else an exact name or title, ignoring case and extra spaces; else the
  non-archived records whose name has the ref as a whole word or word prefix ("Dana" finds "Dana Example"), or whose
  business equals it. One match is used. Several make a question; none makes a question too. Deals: an id, an exact
  title, else a person ref whose match has exactly one open deal (several open deals is a question). Tasks: an id, else
  an open task whose title matches the same way. A question names each candidate with `contactRef`/`dealLabel`
  (outside names become ids), for example: `Which Dana? Dana Example (ct_...) or Dana Sample (ct_...). Send the list
  again with the id.` When any action has a question, nothing is stored and every question is returned at once.
- **Propose.** Validate (schema, caps, `@n` rules) → resolve every ref to an id (questions stop here) → open a
  `PlanCollector`, run each action with `runAction` against `ctx` with the plan → `UserError`s from a service come back
  as "Action N: <message>" and nothing is stored → render the list from `plan.build(...)` → insert the proposal (actions
  with ids, `plan.reads()`, `expires_at`) and, with `replaces`, mark that proposal `dropped` with `replaced_by`, in one
  batch. The 11th open proposal is refused ("Ten proposals are waiting. Apply or drop one first: say No to one, or
  send a revised list with replaces."). `No` from the owner: the AI simply does not apply; the proposal expires.
- **Apply.** Load the proposal: unknown → "No proposal pr_x. Propose the changes again."; applied → answer with its
  change id and write nothing; dropped → "pr_x was replaced by pr_y. Apply pr_y if the owner said yes to it.";
  expired → "pr_x expired at 3:40 PM. Propose the changes again and show the owner the new list." Then plan again
  with `ctx.now` = apply time; if any key of the new `plan.reads()` differs from the stored `reads` (a version moved, a
  row appeared or vanished) refuse: "<Record> changed since this list was made. Propose the changes again and show
  the owner the new list." Else `commitChange` once (actor `ai`, tool `apply_changes`, `changeId = plan.changeId`)
  with a leading guard that the proposal is still open and an extra statement marking it applied with the change id
  (both in the same batch, like `import_drafts`). Use `bulk` when the built change has more than 50 rows. Summary:
  `Applied pr_x: <summaries joined with "; ">`, cut to 500 characters with "…".
- **Rendering.** From the built change's rows, never from the action text: inserted contacts and deals → Add (each
  field set); updated contacts and deals → Update (each changed column `old -> new`); tasks inserted or updated →
  Tasks; activities inserted → Notes (a stage_change activity is shown in the deal's Update line instead); D6's time
  entries → Time. Empty groups are left out. Columns that are bookkeeping (`version`, `created_at`, `updated_at`,
  `untrusted_fields`, `last_activity_at`, `stage_entered_at`, `lead_status_at`) are not shown. Keys become labels
  (stage, person status, sub-status, lead status, custom field label from `field_defs`, contact or deal by label).
  An old value that was outside text shows as `(text from outside)`. Text:
  ```
  Proposal pr_… (expires 3:40 PM). Nothing has changed yet.

  Add
  - Lead Dana Example: business Acme Example; source referral
  Update
  - Deal "Website refresh" (Pat Example): stage New inquiry -> Call booked; next date (none) -> Thu Nov 26, 2:00 PM
  Tasks
  - New task "Buy printer ink": no person or deal; due (none)
  Notes
  - Call with Pat Example: She wants a quote by Friday

  Show this list to the owner as it is. Their answer: "Yes" (call apply_changes with pr_…), "Yes with changes: ..."
  (send a revised list with replaces pr_…), or "No" (apply nothing).
  ```
  The tool answer is that text, a blank line, then the JSON `{ proposal, expiresAt, list }` (`toolResult`).
- **Tools** (`tools-proposals.ts`): `propose_changes { actions: RecordAction[1..25], replaces?: "pr_..." }` (kind
  write, not destructive: it writes only scratch space) and `apply_changes { proposal: "pr_..." }` (kind write,
  destructive). Both act as `ai`. Add both to the instructions' tool list (A2 rewrites the rules).
- **Cron:** the hourly run deletes proposals past `expires_at` and every applied or dropped one older than a day.

Steps:
- [ ] **Write the failing tests** in `src/services/proposals.test.ts` (fixture seed, fake people):
  `proposal writes nothing` (every table's row count and `audit_log` unchanged after propose; one `proposals` row);
  `apply writes once with one undo` (three actions: `add_task` on Pat, `log_activity` on Pat's deal, `update_deal`
  stage of that deal → one new `audit_log` row; `undo_change` on it restores every row; a second undo refuses);
  `apply equals running the actions one by one` (two fresh databases from the same seed: run the actions through the
  services one by one on A, propose+apply on B; every touched row equal except ids, timestamps and `version`, where B
  is exactly one bump per row; cover update_deal + log_activity on one deal, add_deal for an existing lead then
  add_task on `@1`, add_lead then log_activity on `@1`, complete_task); `stale proposal is refused` (update the contact
  between propose and apply → refusal text contains "changed since this list was made", no new audit row, proposal
  still open); `ambiguous name becomes a question` (seed two contacts "Dana Example" and "Dana Sample"; `add_task`
  contact "Dana" → `kind: "questions"`, the question starts `Which Dana?` and lists both ids, no proposal row);
  `apply twice writes once`; `expired proposal is refused` (now + 2 h 1 min); `replaces drops the old one` (the old
  id's apply answers "was replaced by"); `an action's refusal names the action` (`complete_task` on a done task →
  "Action 2: ..."); `the 11th open proposal is refused`; `@n only as a subject` (`update_contact` on `@1` refused);
  `outside text never in the list` (an update of the intake contact ct_seed02 shows `(text from outside)` and no
  value from its `untrusted_fields`).
- [ ] **Run** `node --disable-warning=ExperimentalWarning --test src/services/proposals.test.ts` → FAIL (module not found).
- [ ] **Implement** migration 0014, `plan.ts`, the planned-read helpers, `name-match.ts` (with its own tests:
  word-prefix, business, case and spaces, archived skipped), `proposal-actions.ts`, `proposal-text.ts` (golden-text
  test for the sample above), `proposals.ts`, the tools and the cron cleanup. Add `proposals` to `FAKE_ROWS`.
- [ ] **Run** the new tests, then `npm run check` → all pass.
- [ ] **e2e** `tests/e2e/proposals.test.ts`: over MCP, `propose_changes` (three tasks) → `apply_changes` → `undo_change`
  of the returned change id restores the task count; `tools/list` includes both new tools.
- [ ] **Decision 0044**: collect mode and planned reads, why apply plans again, the 2-hour expiry, the caps, `@n`,
  name matching, rendering from rows. **Commit**, push, PR.

### Task A2: The "AI edits" setting; record tools propose (decision 0045, migration 0015)

Opus implementer (it touches every record tool); Sonnet review.

**Files:**
- Create: `migrations/0015_ai_edits.sql`, `src/mcp/record-write.ts` (the review/apply switch), tests,
  `docs/decisions/0045-ai-edits-setting.md`
- Modify: `src/services/settings.ts` (`aiEdits`), `src/mcp/tools-write.ts`, `src/mcp/tools-read.ts` (`get_settings`
  shows it), `src/mcp/instructions.ts`, `src/mcp/server.test.ts`, `tests/e2e/mcp.test.ts`, `tests/e2e/acceptance.test.ts`
  and any e2e test that calls a record write tool (they now call propose then apply, or set the setting first),
  `docs/ACCEPTANCE.md` wording if a sentence's flow changes, the rulebook guardrails default only if needed

**Migration 0015:** `ALTER TABLE settings ADD COLUMN ai_edits TEXT NOT NULL DEFAULT 'review' CHECK (ai_edits IN ('review', 'small'));`

**Interfaces (produces):**
```ts
export type AiEdits = "review" | "small";               // settings.ai_edits; MCP: aiEdits "review_first" | "apply_small"
/** true when the action may apply at once under "Apply small changes". */
export function isSmallAction(action: RecordAction): boolean;
/** Every record write tool's run(): propose (review, or not small) or apply at once, one shape of answer. */
export function recordWrite(deps: ToolDeps, action: RecordAction): Promise<CallToolResult>;
```

Rules:
- The record tools are exactly the `RECORD_ACTIONS` tools: `add_lead`, `add_deal`, `add_contact`, `qualify_lead`,
  `return_to_lead`, `update_contact`, `update_deal`, `log_activity`, `add_task`, `complete_task`, `snooze_task` (D6 adds
  its time tools). Each one's `run` becomes `recordWrite(deps, { action: "<name>", ...args })`. Their names, inputs and
  annotations stay. Their descriptions gain one sentence: "Unless the owner chose Apply small changes, this returns a
  proposal for the owner to approve; nothing changes until apply_changes."
- Small: `log_activity` with type `call` or `note` on an existing person or deal, and `complete_task`. Everything else
  is proposed, under both settings.
- An applied-at-once answer is the service's summary line, as today. A proposed answer is the proposal text from A1.
- Settings, rules, stages, fields, person statuses, sub-statuses, views, the rulebook, imports and `undo_change` write
  as they do today.
- `update_settings` takes `aiEdits` (`review_first` or `apply_small`); its summary says "AI edits: Review first" or
  "AI edits: Apply small changes". Rule 5 already covers it (only when the owner asks).
- Instructions: a new rule 7 and a changed rule 4:
  - 4: "Report every change in one line, with its change id. Each write answers with that line; it ends with
    \"(change chg_...)\"."
  - 7: "Record edits need the owner's yes. For contacts, leads, deals, activities, tasks and time, call
    propose_changes with every action the owner asked for, in one call, and show the owner the list exactly as
    returned. Call apply_changes only after the owner says yes. The owner answers \"Yes\", \"Yes with changes: ...\"
    (send a revised list with replaces) or \"No\" (apply nothing). The record tools themselves also return a proposal
    unless the owner chose Apply small changes. When propose_changes asks a question (\"Which Dana?\"), ask the
    owner; never guess."

Steps:
- [ ] **Failing tests** `src/mcp/record-write.test.ts` over the in-memory client: `review first: add_task returns a
  proposal and writes nothing`; `apply small: log_activity call applies at once`; `apply small: complete_task applies
  at once`; `apply small: add_task is still a proposal`; `apply small: log_activity email is still a proposal`;
  `settings, stages and rules still write at once under review first`; `update_settings aiEdits round-trips and is
  undoable`. Instructions test: rule 7's text present, the three replies quoted exactly.
- [ ] **Run** → FAIL. **Implement**. Update every test that used a record tool. **Run** `npm run check` → pass.
- [ ] **Decision 0045** (default, what counts as small and why, what stays direct). **Commit**, PR.

### Task B3: Standalone tasks (decision 0046, migration 0016)

Opus implementer (table rebuild); Opus review.

**Files:**
- Create: `migrations/0016_standalone_tasks.sql`, `docs/decisions/0046-standalone-tasks.md`
- Modify: `src/services/tasks.ts` (`addTask` with no subject), `src/services/lookup.ts` (`findSubject` optional),
  `src/mcp/record-inputs.ts` (`add_task` description), `src/db/queries.ts` and every read that joins tasks to contacts
  or deals with an inner join (`whats_due`, the brief, `src/report/*`, the board's task lists, export, import's tasks
  module, leads reads), `src/services/proposal-text.ts` ("no person or deal"), `src/db/migrations.test.ts`

**Migration 0016:** rebuild `tasks` with the same columns, indexes and `untrusted_fields`, without
`CHECK (deal_id IS NOT NULL OR contact_id IS NOT NULL)`, following 0006's pattern exactly (`PRAGMA defer_foreign_keys =
true`; copy aside, drop, create under the same name, copy back, drop the copy), because `rule_firings.task_id`
references `tasks`. Every row, id and version kept.

Steps:
- [ ] **Failing tests:** migrations test `0016 keeps every task and rule firing` (fake rows with a rule-made task and
  its firing; after 0016 the firing still points at the task, `PRAGMA foreign_key_check` clean) and `a task with no
  deal or contact inserts after 0016`; `tasks.test.ts` `add_task with neither adds a standalone task` (summary `Added
  task "Buy printer ink"` with no "for"), `complete and snooze a standalone task`, `undo of a standalone task`;
  `whats_due lists a standalone task`; `the brief counts a standalone overdue task` (compose test); `What it caught
  counts a standalone task once` (if it counts owner tasks; otherwise a test that it is ignored without throwing);
  `rules still create tasks on deals and leads after 0016` (run the existing rule tests unchanged); export and the tasks
  import round-trip a standalone task (an import row with no person or deal columns filled becomes standalone; a row
  that names someone who does not match is still skipped).
- [ ] **Run** → FAIL. **Implement**: migration; `addTask` and `findSubject` allow none; switch inner joins to left
  joins where a task is read; `describeTask` and labels say nothing about a subject when there is none.
- [ ] **Run** `npm run check` → pass. **Decision 0046** (why no subject is allowed, the import rule). **Commit**, PR.

### Task B4: Today works like a list (decision 0047)

Sonnet implementer (board page work); Sonnet review plus the a11y reviewer.

**Files:**
- Create: `src/board/task-list.ts` (sorting, filtering, grouping, pure), its test, `docs/decisions/0047-today-list.md`
- Modify: `src/board/pages/today.ts`, `src/board/actions.ts` / `src/board/edit-actions.ts` (quick add route),
  `src/board/task-forms.ts`, `src/board/routes.ts` (`/?sort=newest`, `/?show=standalone` in `boardRoutes`),
  `public/board.css`, `scripts/seed-dev.ts` (two standalone tasks, one with no due date), `tests/screenshots/*` if a
  route list lives there

Behaviour:
- Today shows open, not-snoozed tasks in two lists: **To do** (has a due date) and **Needs a due date** (none).
- `sort=due` (default): overdue first, then by due time ascending; `sort=newest`: created newest first;
  `sort=subject`: by person name (a deal's person), standalone last, then due. `show=all` (default) | `linked` |
  `standalone`. Unknown values fall back to the default. The address carries only these keys, never record text.
- The sort and filter are a GET form (selects plus a Show button), so they work with JavaScript off.
- Quick add: one form at the top of Today, `POST /tasks/quick`, one text input labelled "Add a to-do" and an optional
  date input labelled "Due (optional)"; Enter submits. It calls `addTask` (actor `owner`, tool `add_task`) with no
  subject, answers 303 back to Today with `?change=` so the Undo banner shows. An empty title is the usual 422 page.
- Each task row says what it is for (the person or deal link) or "No person or deal".
- Everything else on Today (brief excerpt, deals due) stays.

Steps:
- [ ] **Failing tests** `src/board/task-list.test.ts`: `overdue first then soonest`, `undated tasks go to Needs a due
  date`, `newest sort`, `subject sort puts standalone last`, `linked and standalone filters`, `unknown sort falls back`;
  board tests: `quick add creates a standalone task and shows Undo`, `quick add with a date`, `empty quick add is 422
  with the value kept`, `Today with JavaScript off has the sort form as a GET form`.
- [ ] **Run** → FAIL. **Implement**. **Run** `npm run check`, then `npm run build` and `npm run test:a11y` (board
  markup changed; if Chromium is missing locally, say so and rely on CI's `a11y`). **Decision 0047**. **Commit**, PR.

### Task C5: Capture through the AI app (decision 0048, migration 0017)

Sonnet implementer; Sonnet review.

**Files:**
- Create: `migrations/0017_capture_rulebook.sql` (INSERT OR IGNORE a `capture` rulebook document), test,
  `docs/decisions/0048-capture.md`, `tests/e2e/capture.test.ts`
- Modify: `seed/defaults.sql` (the same document for new copies), `src/mcp/instructions.ts` (a capture line in
  "Also"), `docs/ACCEPTANCE.md` (sentence 21)

Content:
- Instructions line: "When the owner rambles (a voice note, a list of things to do), turn all of it into one
  propose_changes call: tasks on a person, a deal or nothing, notes logged on the right person or deal, dates in the
  owner's timezone, stage moves. Leave out anything you are unsure of and ask about it after showing the list.
  Example: \"Call Dana Friday, send Matt the deck, buy printer ink\" is three add_task actions: one for Dana due
  Friday, one for Matt, one with no person."
- `capture` rulebook document: a short owner-editable version of the same, plus "Words like call, email, send, buy
  are tasks; 'she said', 'we talked' are notes; 'move to', 'booked' are stage moves."
- Acceptance sentence 21: "Call Dana Friday, send Matt the deck, buy printer ink." Pass: one proposal with three
  tasks (Dana's and Matt's linked to them, the ink task standalone), applied by one `apply_changes`, removed by one
  `undo_change`. The e2e test seeds or uses fake "Dana Example" and "Matt Example" (add them to the demo seed if
  missing) and drives propose → apply → undo over MCP.

Steps:
- [ ] **Failing tests:** e2e `capture: three tasks, one yes, one undo`; migrations test `0017 adds capture and keeps an
  edited rulebook` (a fake edited `pipeline` document is unchanged; a copy that already has `capture` keeps its text);
  instructions test for the capture line.
- [ ] **Run** → FAIL. **Implement**. **Run** `npm run check` → pass. **Decision 0048**. **Commit**, PR.

### Task D6: Time entries, timer, work types and rates: data, services and MCP (decision 0049, migration 0018)

Opus implementer (migration and money); Opus review.

**Files:**
- Create: `migrations/0018_time_tracking.sql`, `src/services/time-entries.ts`, `src/services/timer.ts`,
  `src/services/work-types.ts`, `src/services/time-read.ts`, `src/mcp/tools-time.ts`, tests beside each,
  `docs/decisions/0049-time-and-rates.md`
- Modify: `src/services/settings.ts` (`timeTracking`), `src/services/change.ts` (tables and nouns),
  `src/services/proposal-actions.ts` and `src/mcp/record-write.ts` (time actions), `src/services/proposal-text.ts`
  (Time group), `src/services/undo.ts` if a new table needs a refusal, `src/http/export.ts` (new tables in the JSON and
  CSV export), `src/db/db.ts`, `src/db/migrations.test.ts`, `src/mcp/server.ts`, `src/mcp/instructions.ts`

**Migration 0018:**
```sql
ALTER TABLE settings ADD COLUMN time_tracking INTEGER NOT NULL DEFAULT 0 CHECK (time_tracking IN (0, 1));
CREATE TABLE work_types (
  id TEXT PRIMARY KEY,                               -- wt_
  name TEXT NOT NULL,
  hourly_rate REAL CHECK (hourly_rate IS NULL OR hourly_rate >= 0),
  billable_default INTEGER NOT NULL DEFAULT 1 CHECK (billable_default IN (0, 1)),
  position INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  version, created_at, updated_at                    -- as every table
) STRICT;
CREATE UNIQUE INDEX work_types_name ON work_types (lower(name)) WHERE archived = 0;
CREATE TABLE client_rates (
  id TEXT PRIMARY KEY,                               -- cr_
  work_type_id TEXT NOT NULL REFERENCES work_types (id),
  contact_id TEXT NOT NULL REFERENCES contacts (id),
  hourly_rate REAL NOT NULL CHECK (hourly_rate >= 0),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  version, created_at, updated_at
) STRICT;
CREATE UNIQUE INDEX client_rates_pair ON client_rates (work_type_id, contact_id) WHERE archived = 0;
CREATE TABLE time_entries (
  id TEXT PRIMARY KEY,                               -- te_
  contact_id TEXT REFERENCES contacts (id),
  deal_id TEXT REFERENCES deals (id),
  task_id TEXT REFERENCES tasks (id),
  started_at TEXT NOT NULL,
  ended_at TEXT,                                     -- NULL: the running timer
  minutes INTEGER CHECK (minutes IS NULL OR minutes BETWEEN 1 AND 960),
  work_type_id TEXT REFERENCES work_types (id),
  billable INTEGER NOT NULL DEFAULT 0 CHECK (billable IN (0, 1)),
  rate REAL CHECK (rate IS NULL OR rate >= 0),       -- the hourly rate used, fixed when the entry is saved
  notes TEXT,
  activity_id TEXT REFERENCES activities (id),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  untrusted_fields TEXT NOT NULL DEFAULT '[]',
  version, created_at, updated_at,
  CHECK ((ended_at IS NULL) = (minutes IS NULL))
) STRICT;
CREATE UNIQUE INDEX time_entries_one_running ON time_entries ((1)) WHERE ended_at IS NULL AND archived = 0;
CREATE INDEX time_entries_started ON time_entries (started_at) WHERE archived = 0;
CREATE INDEX time_entries_contact ON time_entries (contact_id, started_at);
CREATE INDEX time_entries_deal ON time_entries (deal_id, started_at);
```
(The `version, created_at, updated_at` shorthand means the three columns exactly as in 0013's `views`.)

**Interfaces (produces):**
```ts
// time-entries.ts
export interface TimeEntryInput { contact?: string; deal?: string; task?: string; startedAt: string; endedAt?: string;
  minutes?: number; workType?: string; billable?: boolean; notes?: string }
export function addTimeEntry(ctx: Ctx, input: TimeEntryInput): Promise<ChangeResult & { entryId: string }>;
export function updateTimeEntry(ctx: Ctx, ref: string, patch: Partial<TimeEntryInput> & { archived?: boolean }): Promise<ChangeResult & { entryId: string }>;
/** Client rate for (work type, the entry's person) beats the work type's rate; null when neither has one. */
export function rateFor(db: Db, workTypeId: string | null, contactId: string | null): Promise<number | null>;
// timer.ts
export function startTimer(ctx: Ctx, subject: { contact?: string; deal?: string; task?: string; workType?: string }): Promise<ChangeResult & { entryId: string }>;
export interface StopInput { notes?: string; workType?: string; billable?: boolean; nextStepDate?: string;
  startedAt?: string; endedAt?: string }
/** One change: the entry ended (minutes, rate fixed), notes logged as a note activity on its person or deal (if any
 * subject and notes), a "Next step" task when nextStepDate is given. */
export function stopTimer(ctx: Ctx, input: StopInput): Promise<ChangeResult & { entryId: string; activityId: string | null; taskId: string | null }>;
export function runningTimer(db: Db): Promise<TimeEntryRow | null>;
// work-types.ts
export function addWorkType(ctx: Ctx, input: { name: string; hourlyRate?: number | null; billableDefault?: boolean }): Promise<ChangeResult & { workTypeId: string }>;
export function updateWorkType(ctx: Ctx, ref: string, patch: { name?: string; hourlyRate?: number | null; billableDefault?: boolean; archived?: boolean }): Promise<ChangeResult & { workTypeId: string }>;
export function setClientRate(ctx: Ctx, input: { workType: string; contact: string; hourlyRate: number | null }): Promise<ChangeResult>;  // null archives it
export function listWorkTypes(db: Db): Promise<WorkTypeView[]>;
// time-read.ts
export type Period = { from: string; to: string };            // local dates, inclusive
export function periodOf(name: "this_week" | "last_week" | "this_month" | "last_month", now: Date, tz: string): Period;  // weeks start Monday
export interface TimeSummary { entries: TimeEntryView[]; totalMinutes: number; billableMinutes: number;
  billableAmount: number; byPerson: Total[]; byDeal: Total[] }
export function listTime(db: Db, filter: { period: Period; contact?: string; deal?: string }, tz: string): Promise<TimeSummary>;
export function timeByClientMonth(db: Db, month: string /* YYYY-MM */, tz: string): Promise<ClientMonthRow[]>;
```

Rules:
- Time tracking off (default): every time tool and service refuses with "Time tracking is off. The owner can turn it
  on (update_settings timeTracking true)." Reads answer the same. The board shows no time UI (D7, D8).
- An entry needs a start and either an end or minutes (the other is worked out); 1 to 960 minutes (16 hours); end after
  start. Links are optional and checked like a task's (a deal's person is the entry's person; a task's deal and person
  are used when none is given). Entries are archived, never deleted.
- Rate used: when billable, `rateFor(...)` at save time; when not billable, null. A later rate change never rewrites an
  entry; editing an entry's work type, person or billable recomputes its rate from today's rates (say so in the decision).
- Amount = `rate * minutes / 60`, rounded to cents on read, never stored. Hourly only.
- Timer: one running at a time (`startTimer` refuses: "A timer is already running for <label> since 9:10 AM. Stop it
  first."). Stop with no `endedAt` uses `ctx.now`; minutes are rounded up to the whole minute, at least 1. A running
  timer older than 16 hours cannot be stopped without `startedAt`/`endedAt` (Review Focus 5).
- Notes on stop are owner text (trusted). The note activity's summary is the notes; it is linked from the entry
  (`activity_id`). `nextStepDate` adds the task "Next step" (or "Next step: <deal title>" when the title is trusted)
  due that date on the same subject.
- MCP tools: `start_timer`, `stop_timer`, `add_time_entry`, `update_time_entry`, `list_time` (period or from/to,
  contact, deal), `list_work_types`, `add_work_type`, `update_work_type`, `set_client_rate`. The four record ones
  (`start_timer`, `stop_timer`, `add_time_entry`, `update_time_entry`) are record actions: added to `RECORD_ACTIONS`,
  proposed under Review first; under Apply small, `start_timer`, and `stop_timer` without `nextStepDate`, apply at once.
  Work types and client rates are configuration (rule 5: only when the owner asks) and write directly. `update_settings`
  takes `timeTracking`.
- Proposal Time group: `Time 1 h 30 min, Design, billable at $95.00/h ($142.50), for Pat Example`.

Steps:
- [ ] **Failing tests:** `time-entries.test.ts`: `entry from start and end`, `entry from start and minutes`,
  `end before start is refused`, `client rate beats default`, `rate is kept after the work type's rate changes`,
  `not billable stores no rate`, `undo of an entry`; `timer.test.ts`: `one running at a time`, `stop stores the entry,
  the note and the next-step task in one change`, `stop with no subject logs no note`, `a timer over 16 hours asks for
  the times`, `undo of a stop restores the running timer`; `time-read.test.ts`: `this week starts Monday in the owner's
  timezone`, `totals by person and deal, billable vs not`, `client and month rows`; `work-types.test.ts`: names unique
  among live ones, archive and restore, client rate set and cleared; `tools-time.test.ts`: `time tools refuse while
  time tracking is off`, `add_time_entry under review first is a proposal`, `start_timer under apply small applies`;
  migrations test for 0018 with `FAKE_ROWS` for the three tables; export test includes the three tables.
- [ ] **Run** → FAIL. **Implement**. **Run** `npm run check` → pass. **Decision 0049** (one running timer as an entry
  with no end, rates per person, rate fixed on save, 16-hour cap, hourly only). **Commit**, PR.

### Task D7: The timer on the board (decision 0050)

Sonnet implementer; Sonnet review plus the a11y reviewer.

**Files:**
- Create: `src/board/timer-bar.ts`, `src/board/pages/timer-stop.ts`, `src/board/time-actions.ts`, tests,
  `docs/decisions/0050-timer-on-the-board.md`
- Modify: `src/board/context.ts` (`PageContext.timer`: the running entry's label and start, or null; read only when
  time tracking is on), `src/board/layout.ts` (the Stop bar), `src/board/pages/contact.ts`, `deal.ts` and the task rows
  (a "Start timer" form), `src/board/actions.ts`, `src/board/ask-claude.ts` (a fixed prompt with the entry and activity
  ids), `src/board/routes.ts`, `public/board.css`, `scripts/seed-dev.ts` (time tracking on and one finished entry
  `te_seed01` with a note; no running timer, so every page's screenshot stays the same)

Behaviour:
- Time tracking off: no Start, no bar, `/timer/*` posts are 404 and `GET /timer/stop` is 404.
- "Start timer" on a person, deal or task: `POST /timer/start` with the subject id (hidden field), 303 back with
  `?change=`. Refused (422 page) while one runs.
- Stop bar on every board page while a timer runs: one line under the header, "Timer: <label> · since 9:10 AM" and a
  "Stop" link to `/timer/stop` (a link, not a post, because Stop opens the form). No JavaScript; no live clock.
- `/timer/stop` (GET): "What did you do?" form: Notes (textarea), Work type (select, "None" first), Billable
  (checkbox, preset from the work type's default, else unticked), Next step date (optional), Start and End (date +
  time, preset to the start and now). `POST /timer/stop` calls `stopTimer` (actor `owner`), then 303 to
  `/timer/done?entry=<te id>&change=<id>`. With no timer running, the GET page says "No timer is running." and links
  Today.
- `/timer/done`: the saved entry (duration, work type, billable, amount), links to the note and task if made, and
  "Ask Claude to turn these notes into updates" (the existing Ask Claude link mechanism; prompt text fixed, carrying
  only the time entry id and activity id: "Read time entry te_… and its note ac_… in my pipeline and propose the
  updates they imply, with propose_changes.") plus Copy prompt.
- `boardRoutes`: `/timer/stop` with the seed's state (no timer → the "No timer is running" page) and
  `/timer/done?entry=te_seed01`; one Lighthouse slot for `/timer/done` (replace a slot of a kind already covered).

Steps:
- [ ] **Failing tests:** `time-actions.test.ts`: `start then the bar shows on Today`, `start while running is 422`,
  `stop saves entry, note and task and redirects to done`, `time tracking off: no Start button, no bar, 404s`;
  `ask-claude.test.ts`: the done page's prompt has only ids; layout test: the bar is inside `header` or right after it,
  with text, not colour alone.
- [ ] **Run** → FAIL. **Implement**. **Run** `npm run check`, `npm run build`, `npm run test:a11y` (or note CI covers
  it). **Decision 0050**. **Commit**, PR.

### Task D8: Time pages, hand entry and CSV (decision 0051)

Sonnet implementer; Sonnet review.

**Files:**
- Create: `src/board/pages/time.ts` (This week), `src/board/pages/time-entry.ts` (add and edit),
  `src/http/time-csv.ts`, tests, `docs/decisions/0051-time-pages.md`
- Modify: `src/board/routes.ts` (`moreItems` gains "Time" only when time tracking is on; routes `/time`,
  `/time?week=2026-11-16`, `/time/new`, `/time/te_seed01/edit`), `src/board/actions.ts`, `src/board/icons.ts` (a
  generic clock icon), `public/board.css`, `scripts/seed-dev.ts` (two work types "Site visit" $120/h and "Drawings"
  $95/h, a client rate for one seed contact, eight entries this week and last across three people and two deals, one
  not billable), `src/http/export.ts` link if export lists files

Behaviour:
- `/time`: the week (Monday to Sunday, owner's timezone; `?week=<a Monday>` picks another; Previous and Next week
  links), entries by day (time, duration, person or deal, work type, billable, amount, Edit link), then totals: by
  person, by deal, billable vs not billable minutes and the billable amount. A "Download CSV" link for this month and
  a month picker form (`GET /time/export.csv?month=YYYY-MM`).
- `/time/new` and `/time/:id/edit`: record forms built like the others (`record-form.ts`, `inputs.ts`): person or deal
  (select of the seed's open deals and people, optional), work type, date, start, end or minutes, billable, notes;
  edit has Archive. Both call the D6 services (actor `owner`) and 303 back with `?change=`.
- CSV `time-<YYYY-MM>.csv`: one row per person ("client") and work type for the month: client, work type, hours
  (2 decimals), billable hours, rate, amount; the formula guard from `src/http/csv.ts`; outside names are written as
  they are inside the CSV (it is the owner's own export, like `/export`).

Steps:
- [ ] **Failing tests:** `time.test.ts` (page): `week totals match the entries`, `other week by address`, `bad week
  falls back to this week`; `time-entry.test.ts`: `hand entry saves and shows Undo`, `edit changes the rate only when
  billable or work type changes`, `archive hides the entry`; `time-csv.test.ts`: `one row per client and work type`,
  `formula guard`; `routes.test.ts`: Time is in More only when time tracking is on.
- [ ] **Run** → FAIL. **Implement**. **Run** `npm run check`, `npm run build`, `npm run test:a11y`. **Decision 0051**.
  **Commit**, PR.

### Task E9: Closing docs and status

Sonnet implementer for the docs; the controller does the CPU re-measure and STATUS facts.

**Files:** `docs/UPDATING.md` ("Run 6: after you update"), `docs/INSTALL.md` (only if a step changed), `docs/ACCEPTANCE.md`
(sentences 21 to 25 if not already added: capture; "Log that I called Pat and move the deal to Call booked" as one
yes; "Start a timer on Pat's deal" then "Stop it: drew the site plan, an hour, bill it"; "What did I bill this week?";
"Add a work type Drawings at 95 an hour"), `docs/PAID-PLAN.md` ("Run 6 re-measure"), `docs/STATUS.md`.

- UPDATING.md run 6 steps: `npm run copies:update -- --copy <name> --dry-run`, then for real (migrations 0014 to 0018);
  reconnect the AI app's connector if `propose_changes` or the time tools don't appear (remove and add the connector,
  or start a new chat); the AI now shows a list before record edits; how to choose "Apply small changes" by talking;
  how to turn time tracking on and add work types by talking; the sentences to try.
- CPU: `scripts/cpu-check.ts` on the big fake copy for Today (new sorts), `propose_changes` with 10 actions, `apply_changes`,
  `/time` and `list_time` with 2,000 entries; record in PAID-PLAN.md.
- STATUS.md in place: Current state, Changelog (one dated line with the PR numbers), Needs Grant (update the live copy
  to run 6, in order), For the master (one line per product change), "Run 6 rulings (cost if wrong)".
