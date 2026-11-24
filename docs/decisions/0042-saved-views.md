# 0042: Saved views

Run 5, task P9, 2026-11-23. Builds on 0016 and 0027 (the People tab and its switch), 0020 (row caps), 0040 and 0041
(person status and its tools) and the stages model (`stages.ts`).

## Context

The owner's words: a view is a name, a module (people or deals), filters (Person status, sub-status, any custom field,
source, search text), a sort, a layout and its columns. Tools `list_views`, `add_view`, `update_view`, `archive_view`.
Each Person status gets a default view automatically, so a new status shows on the board with no code. Saved views
appear in the People switch after the built-in ones. The phone tab bar stays at five items, and outside text never
goes in an address (0016, 0027). Part 2's goal: "give me a view of all my partners" works with no new code per kind.
The brief left open the board addresses, what a deals view filters by, the sorts and columns, how filters are checked,
where deals views appear and what an unknown view does.

## Decision

- **The table** (migration 0013): `views (id 'vw_…', name, module 'people'|'deals', filters JSON object, sort
  '<key>-<asc|desc>', layout 'cards'|'table', columns JSON array, position, archived, version, created_at,
  updated_at) STRICT`. Stored filter keys are exactly `person_status`, `sub_status`, `source`, `q`, `fields
  {<key>: value}` and, for deals, `stage`. It is a change table (audited, undoable, bulk-writable) and is exported
  (`views.csv`, "Saved views"). `isViewId` in `src/ids.ts`.
- **What a view can hold** (`src/services/view-spec.ts`). People filter by person status, sub-status (needs the
  status), source, search text and contact fields; deals by stage, source (the deal's person's), search text and deal
  fields. A person status filter on a deals view, or a stage on a people view, is refused in plain English, as is any
  other key. Sorts: people `name`, `business`, `last_activity`, `next_task`, `created`; deals `days_in_stage`,
  `value`, `next_date`, `created`; each with asc or desc, defaulting to its natural one (A to Z, latest activity,
  soonest task, longest in stage, highest value, soonest date, newest). Empty values sort last either way. Columns:
  the module's built-in keys (people name, business, email, phone, source, person_status, sub_status, next_task,
  last_activity, created; deals deal, person, stage, value, next_step, next_date, days_in_stage, source, created) or
  a live custom field of the module as `fields.<key>`, at most 12, each once, starting with name or deal (the column
  that links to the record). Defaults are task P10's: people name, business, person status, sub-status, next task,
  last activity; deals deal, person, stage, value, next step, days in stage.
- **Checked when written, stored by key** (`src/services/views.ts`). A status, sub-status, stage or field is taken by
  key or label and must be live; a field value must fit its type (a number field takes "1,500" as 1500; a choice must
  be one of its choices). So a rename never breaks a view. Search and source are trimmed, at most 100 characters,
  never empty. At most 10 field filters. Names: at most 60 characters, unique among the live views of the module
  (ignoring case), and not a built-in view's name (Contacts, Leads, Companies; Board, List).
- **Tools.** `list_views { module?, includeArchived? }` (read-only): per module, the built-in views, then (people) one
  default view per live person status other than Lead and Contact, then the saved views; each with its board path,
  and saved ones with id, filters, a plain-English `shows`, sort, direction, layout, columns and position. No record
  counts. `add_view { name, module, filters?, sort?, direction?, layout?, columns?, position? }` (not destructive),
  `update_view { view, name?, filters?, sort?, direction?, layout?, columns?, position? }` (destructive, idempotent;
  `filters` replaces every filter, `{}` clears them; `direction` alone keeps the sort key) and `archive_view { view }`
  (destructive). A view is named by its id or, among live ones, its name. Each write is one audited change as the
  `ai` actor; summaries use the view's name and labels (owner text): "Added people view Partners (vw_…): person status
  Partner; by name, A to Z". An archived view can't be updated; undo of the archive brings it back. Positions count
  among the module's live views and are renumbered 1..n in the change that moves one, as stages are.
- **Filter keys over MCP are camelCase** (`personStatus`, `subStatus`, `stage`, `source`, `q`, `fields`), the
  convention 0041 set for every tool input; storage uses the snake_case keys above. The instructions' example is
  "add_view with module people and filters personStatus partner".
- **Instructions.** One line: a view is how the board shows a kind of person or deal; every person status has a
  default view; add_view saves another ("give me a view of all my partners"). Rule 5 names views among the lasting
  configuration changed only when the owner asks.
- **Default views have no row.** Every live person status other than Lead and Contact (whose views are the built-in
  Leads and Contacts) has one, worked out at read time: everyone with that status, by name. A new status appears in
  the switch at once; an archived one leaves it. `/people?status=lead` and `contact` also work (a default view of
  that status); they are just not in the switch.
- **Board addresses.** `/people?status=<status key>` (a default view), `/people?view=<vw id>` (a saved people view) and
  `/pipeline?view=<vw id>` (a saved deals view). Keys and ids are owner-made, never outside text. Anything that can't
  be a key or id, an unknown or archived one, a view of the other module, and `/people` with neither is the board's
  404. `/pipeline?view=` with anything not starting `vw_` is still the board, as before. Router pages may now answer
  null for the 404.
- **Switches.** The People switch lists Contacts, Leads, Companies, the status views in status order, then saved people
  views in position order; the Pipeline's lists Board, List, then saved deals views. One query each. Still a labelled
  list of links (44 px targets), `aria-current="page"` on the one shown; it now wraps on a phone instead of growing
  past the screen. People is still one tab, so the phone tab bar keeps five items. `/people` pages mark People as the
  current section.
- **Pages.** The view's name (or the status's label) is the `<h1>` and the title; the lede says what it shows and how
  it sorts, then the count ("2 people."). Cards: people with company, person status (and sub-status), last activity
  and next task; deals with contact, stage, value, next date and days in this stage, and the Overdue tag. No Move to
  form and no board.js on a deals view. A deals view without a stage shows open deals; with one, every deal in that
  stage, open or closed. A table layout is stored and, from 0043, drawn as a table. At most 200 rows, then "Showing
  the first 200 of N people, in this view's order." (0020). Outside names stay labelled and out of link text, as on
  every list.
- **Undo.** Undo of adding a stage or a person status that a saved view filters by is refused ("view Demos shows Demo
  booked"), like a rule watching a stage.
- **Seed.** The demo seed has `vw_seed01` (Referrals: people from referral, latest activity first) and `vw_seed02`
  (Commercial jobs: open deals with Project type Commercial, highest value first); `boardRoutes` gains
  `/people?status=partner` and both saved views. Unit tests use stand-in rows (`tests/helpers/views.ts`).

## Why

- Checking and storing keys keeps a view working through renames, and the plain refusals tell the AI app what to fix.
- Computing default views at read time is the only way "a new status shows with no code" holds without a write per
  status, and it can never drift from the status list.
- Ids and keys in addresses keep outside text out of URLs, and one tab keeps the phone layout as it is.

## Consequences

- Undo of adding a sub-status or a custom field that a view filters by is not refused (the view then shows nobody for
  that filter); only stages and statuses are checked. Undo of an archive can bring back a view whose name a newer view
  has taken: both show in the switch.
- A view's stored layout and columns do nothing visible until P10 draws the table.
- Many saved views make the switch wrap onto more lines; there is no cap.

## "AI defaults" (human-touch-design), flagged for the owner

- **The segmented switch, now any length,** wrapping onto a second line on a phone. Alternatives: a "More views" list
  of links under the switch; or a select with a Show button (works without JavaScript).
- **Every record as an identical card** (item 4), as on Contacts and Leads. Alternative: P10's table, which every view
  can choose.
- **The lede in one sentence** ("Everyone whose person status is Partner, by name, A to Z. 2 people."). Alternative:
  the filters as a short list of label/value pairs above the cards.
- Not used: eyebrow labels, all caps, count badges on the switch, arrows on links, new motion.
