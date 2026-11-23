# 0040: Person status

Run 5, task P7, 2026-11-23. Replaces parts of 0022 (leads on contacts), as listed under "What it replaces". Builds on
0009 (changes and undo), 0022 to 0029 (leads), 0034 to 0039 (the import) and the stages model (`stages.ts`).

## Context

The owner's words: every person has one Person status that says what kind of person they are. Seed Lead, Contact and
Partner. The owner can add, rename, reorder and archive statuses, as with stages; Lead and Contact can be renamed but
not archived. Each status has its own sub-status list, with a field label the owner can rename per status, and values
the owner can add, rename or archive. Lead's sub-statuses are today's lead statuses (their keys stay fixed because
rules and reports use them); Contact has Client; Partner has none. The app moves people by itself in three places
(New to Contacted on a reach, Lead to Contact on a deal, Contact to Client on Won) and never because outside text says
so. Moving to Lead is refused while the person has an open deal. The lead engine (the lead follow-up rule,
`list_leads`, the brief, What it caught, export, the import) must keep working. The brief left open how the new model
sits next to `lead_status`, what can and can't be added or archived, and how the import reads the new columns.

## Decision

- **The model** (migration 0011). Two tables: `person_statuses` (key, label, position, `sub_label`, `locked`,
  archived, version, times) and `person_substatuses` (id `"<status>.<key>"`, `status_key`, key, label, position,
  archived, version, times; one key per status). `contacts` gains `person_status` (NOT NULL, default `contact`) and
  `sub_status`. No foreign key on `contacts.person_status`: SQLite can't add a column with REFERENCES and a non-NULL
  default while foreign keys are on, so the services check it. The three statuses and six sub-statuses are seeded by
  the migration (with `INSERT OR IGNORE`), not by `seed/defaults.sql`, so a copy has them before its people get one
  and the "from the previous version" migration tests can still load the defaults at any earlier version.
- **The migration.** An unqualified `lead_status` becomes Lead with `sub_status = lead_status`; everyone else (never a
  lead, or Qualified) becomes Contact with no sub-status. `lead_status`, `lead_status_at` and every `version` are left
  exactly as they were, so "was qualified" stays and undo of an earlier change still finds its rows as it left them.
- **Two pairs kept in step.** `lead_status` and `lead_status_at` stay the lead engine's columns. One pure function,
  `personStatusPatch(contact, to, now)` (`src/services/person-move.ts`, re-exported by `person-status.ts`), returns
  both pairs: to Lead with sub-status X sets `lead_status = X`; from Lead to any other status sets Qualified; a move
  between two other statuses leaves `lead_status` alone; `lead_status_at` moves only when `lead_status` does.
  `withLeadStatus` and every place that creates a person (`newPersonColumns`) go through it; it treats a row as a lead
  when either pair says so, so a row written by hand (a test, an old script) still leaves Lead properly. The
  invariant: `person_status` is `lead` exactly when `lead_status` is unqualified, and then `sub_status` equals it.
  `src/services/person-status-invariant.test.ts` runs every service that moves or creates a person, and the undo of
  each, on the fixture seed and checks the whole table after each step.
- **Keys and labels.** A new status's or sub-status's key is the slug of its first label (`slug.ts`), unique (archived
  ones count), and never changes; refs take a key or a label, ignoring case, as stages do. Labels are at most 60
  characters and unique among the live ones (of that status, for a sub-status).
- **What can change.** Statuses: add (with an optional sub-status label and position), rename, change the sub-status
  label, reorder, archive and bring back. Lead and Contact (`locked`) can't be archived. A status anyone (not archived)
  has can't be archived either; the refusal names up to five of them. Sub-statuses: Lead's five can be renamed and
  moved but not archived, and Lead gets no new ones, because the lead engine and the `lead_status` CHECK use exactly
  those keys: the follow-up rule, `list_leads`, the brief and What it caught read the five keys, and a new or missing
  key would leave people in Lead that the lead engine can't see. Other statuses' sub-statuses can be added, renamed,
  moved, archived (not while anyone has one) and brought back. Client can be renamed and archived.
- **The owner's move** (`setPersonStatus`). Any live status and one of its live sub-statuses, in one audited change.
  With no sub-status given: kept when the status stays the same, New for a new Lead, none otherwise. Lead always has a
  sub-status. Lead is refused while the person has an open deal, pointing to `return_to_lead` or closing the deal,
  and checked again inside the batch (a `write_guard` row) so a deal added at the same moment can't slip past.
- **Moves the app makes.** New to Contacted on a logged reach (`contactedIfNew`, unchanged); Lead to Contact when a
  write gives the person a deal (`qualifyIfLead`, invariant 1); Contact (any sub-status) to Client when `update_deal`
  (or the board) marks one of their deals Won, in the same change, so one undo reverses both. A Client stays Client;
  a Partner or any other status is left alone; nobody moves while Client is archived. The summary says
  "<name> is now a Client" with the owner's current label. A lead whose Lost or Not now deal is marked Won directly
  is treated like a reopen for invariant 1: they become a Contact and then a Client in the same change ("is now
  Qualified and a Client"), and one undo puts them back in Lead. A deal brought in as Won by an import moves nobody:
  the file's stage is outside text.
- **Undo.** The status tables are change tables (undoable, exported, bulk-writable). Undo refuses to remove a status or
  sub-status someone has (its dependents are people, matched by key). An undo summary that puts back a lead status
  doesn't list the person status and sub-status as well. An undo that would archive a status or sub-status again
  (undoing its bring-back) is refused while anyone has it, as archiving is. A snapshot from before migration 0011 has
  no status columns; undoing it puts back what the migration gives its lead status, so the two pairs still agree.
- **Import.** The People module gains `person_status` and `sub_status` columns (a live status, and one of its live
  sub-statuses, by key or label). `lead_status` still works: Lead with it, or Contact for Qualified, also by the
  owner's current Lead sub-status label. When a file gives both, the person status wins and having been a lead stays
  as Qualified. A Lead with no sub-status starts New. A People import may create someone directly as Contact, Client,
  Partner or any live status: that is the owner's choice of column mapping (the columns only say what a new person
  is), unlike a Won stage in a deals file, which moves nobody. A bad value skips the row; the reason names the column
  and the live keys, never the value. A merge never moves anyone. The board, MCP and CLI imports read the copy's
  statuses (the CLI with two more queries); a caller that passes none (a test) gets the seeded three.
- **Seeds.** Every person in the dev, fixture and scale seeds has a consistent pair; the dev seed's Hannah Cole
  (`ct_seed13`, an architect who sends work) is a Partner.

- **Reports.** What it caught counts a person as qualified when `lead_status` became Qualified in the month, so a move
  from Lead to Partner (or to any status other than Lead) by `setPersonStatus` or an import counts as qualified too.
  That is deliberate: they left the lead list for a real relationship.
- **Tests.** Test databases (`createTestDb`) carry a trigger that refuses any contact row whose pairs disagree, from a
  service or from a test's own SQL; tests set a lead status through `tests/helpers/people.ts`. The either-pair
  fallback in `personStatusPatch` exists only to repair such a row, never to trust one.
- **CLI.** On a copy without migration 0011, `import:contacts` says "This copy hasn't been updated yet. Run npm run
  copies:update first, then import." instead of SQLite's "no such table".

## What it replaces

From 0022: "a lead is a row in contacts with a lead status" is now "a person whose person status is Lead" (the lead
status is still stored, as the lead engine's column); "the labels live in one place" is replaced by the
`person_substatuses` labels (the fixed `LEAD_STATUS_LABELS` stay the defaults and what summaries and the board still
show until task P8); "no other status moves by itself" gains Contact to Client on Won; and "there is no way to clear a
lead status in v1" is replaced by `setPersonStatus`, which moves a lead to any other status (Qualified kept as
history). "Not in this run: owner-defined statuses" no longer holds.

## Why

- Keeping `lead_status` as the engine's column leaves every rule, report, view and test of run 4 working unchanged,
  while one function makes drift between the two pairs impossible by construction.
- Fixed Lead keys keep the lead follow-up rule, the brief counts and the leads views correct whatever the owner calls
  them.
- Refusing to archive anything in use mirrors stages and never leaves a person on a status the board can't offer.

## Consequences

- MCP tools and board forms for statuses come in task P8; they call the services in `src/services/person-status.ts`.
- Places that show a lead status still use the fixed labels; renaming Lead's sub-statuses changes only the table
  until P8 reads the labels from it.
- A copy must run migration 0011 (`copies:update`) before the CLI import; the import says so.
