# 0037: Import deals and tasks

Run 5, task I4, 2026-11-23. Builds on 0022 (leads, invariant 1), 0029 (leads in the import), 0034 (the import engine),
0035 (one change at any size) and 0036 (the board import).

## Context

The board could import people only. The run asks for deals and tasks through the same three steps, and for the
board's CSV export of contacts, deals and tasks to import back: into another copy (people first, then deals, then
tasks) with the same ids, and into the same copy as all unchanged. Three review items from task I3 were open: the
module list was typed loosely, `ColumnDef.limit` was declared but never enforced, and the engine's options held
People-only choices. This record replaces 0036's consequence "Only People can be imported on the board".

## Decision

- **Engine.** `ImportOptions` is only `fieldDefs`; each module adds its own (People: `asLeads`, `allowDuplicates`;
  Deals: `closedAsHistory`; Tasks: none). `IMPORT_MODULES` must hold an `ImportModule` per key. `planRows` is the one
  way to plan mapped rows: it skips a value longer than its column's `limit`, for every module, before the module
  plans ("title is longer than 500 characters", People's wording); People dropped its own copy. A column read only
  as one of a list (stage, status, dates, ids, `lead_status`) has no limit. A module says whether it takes Add to
  notes (only People); `mapRows` refuses a notes target otherwise, naming the column by number. A module lists the
  export's bookkeeping columns (`version`, `created_at`, `updated_at`, `untrusted_fields`, `archived`, `fields`,
  `stage_entered_at`, `last_activity_at`, `lead_status_at`, `snoozed_until`, `source`): they are skipped and never
  fill a custom field of the same name.
- **Ids, every module.** An `id` column that names a record of the module matches it, and the row fills that
  record's empty values only. A well-formed id (`isContactId`, `isDealId`, `isTaskId`) that matches nothing is kept
  for the new record. Anything else in the column is ignored. The same id twice is skipped ("the same id as line 3").
  People: the id matches before the email; one person is never matched by two lines ("the same person as line 3").
- **Deals.** Columns `title` (required), `contact_id`, `email`, `name`, `business`, `stage` (key or label; alias
  `stage_key`), `status`, `value`, `next_step`, `next_at` and deal custom fields (New field makes a deal field).
  Without an id match every row is a new deal; deals never merge otherwise. The person is the contact on file by
  `contact_id`, then by email (ignoring case), then by name plus business (`businessKey`, both trimmed, spaces
  collapsed, case ignored; an empty business matches an empty one; two people with that pair are not guessed); then
  a person this file already added, the same way; else a new one with the row's name, email and business (and a
  kept `contact_id`). As in `add_deal`, the new person is a contact with no lead status. An archived person is never
  used ("contact ct_… is archived"). An unqualified lead who gets an open deal is Qualified in the same change
  (invariant 1). A closed deal alone does not qualify a lead: invariant 1 is about open deals, and `update_deal`
  qualifies only on reopening.
- **Stage and status.** The stage is a live stage by key or label; without one, the first stage of the status's kind
  (open when there is no status). A status that disagrees with the stage skips the row ("status doesn't match the
  stage (Replied is an open stage)"); the status always follows the stage. `value` takes digits with an optional
  currency sign, thousands commas and decimals, 0 or more. Dates are read like every date input, in the owner's
  timezone.
- **Closed deals.** A new deal in a Won, Lost or Not now stage comes in only when the check step's box "Bring in
  closed deals as history" is ticked; otherwise the row is skipped ("closed deal, not confirmed"). The check step says
  "3 deals come in as Won, 1 as Lost" and lists their lines. A closed deal's `stage_entered_at` is the import time,
  like an open one's: the export's `stage_entered_at` is bookkeeping, and nothing reports on when a deal closed.
- **A deal merge** (by id) fills an empty value, next step, next date and empty custom fields; it never moves the
  stage, renames the deal or changes its person.
- **Tasks.** Columns `title` (required), `due_at` (alias `due`), `deal_id`, `contact_id`, `email`, `name`, `done_at`
  (alias `done`). A task goes on the deal its `deal_id` names (and that deal's person), else on the person by
  `contact_id`, email or name (two people with that name are not guessed). It never adds a person or a deal: with
  none, "no person or deal matches". An archived deal or person is never used. A `done_at` makes it a task already
  done at that time. A task merge (by id) fills an empty due date only: it never completes, renames or moves a task.
- **Outside text.** Everything from the file is listed in `untrusted_fields`: a new person's name, email and business;
  a deal's title, value, next step, next date and custom fields; a task's title, due and done dates; and every value a
  merge fills.
- **One change each.** A deals or tasks import is one bulk change (actor `owner`, tool `import`): "Imported 3 deals
  and filled details on 0; added 1 contact; 1 lead is now Qualified", "Imported 2 tasks and filled details on 0". One
  undo takes back the deals, the people they added and the Qualified.
- **Reads.** A deals plan reads every contact, the stages, the settings and only the deals whose ids are in the file;
  a tasks plan every contact, the settings, and only the deals and tasks its ids name. Each list is one statement with
  the ids as one JSON parameter (`src/import/load.ts`), so any file is four reads in one batch.
- **Board.** `/import?module=deals` and `/import?module=tasks` are step 1 (in `boardRoutes`); Import buttons sit on
  Pipeline (deals) and Today (tasks). Step 1 of each module links to the other two, so Import in More reaches all
  three. Only People's matching step has "New people come in as"; Add to notes is offered only for People and New
  field only where the records have fields (not tasks). The check and done steps count per module (new deals, new
  people, closed deals). A deal or task id that another import wrote first is a plain refusal, nothing saved.

## Why

- Ids are what make an export one copy's history and another copy's starting point; matching by them first means the
  same file twice changes nothing.
- Never merging deals by title keeps two real deals with the same name apart; the id is the only safe key.
- Asking before closed deals keeps a won/lost history from landing unseen in the owner's counts, and makes the
  owner, not the file, say that a deal is closed (the MCP rule is the same).
- Planning through one `planRows` makes every limit hold for every module without each module remembering it.

## Consequences

- The export's `fields` JSON column is not read: custom field values come in through one column per field. A copy
  that wants them must have the same fields and a file with those columns.
- A person added by a deal import has no phone, source or notes; the deals file has no such columns.
- Seed drafts for deals and tasks are not added; the a11y check, Lighthouse and the screenshots cover their first
  step only. Their later steps share People's markup and are covered by the unit tests.
