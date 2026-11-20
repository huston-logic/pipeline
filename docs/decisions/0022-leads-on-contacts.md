# 0022: Leads are people with a lead status, not a table of their own

Run 4, task 0, 2026-11-20. The design was approved by the owner in the run 4 brief. Builds on 0009 (changes and undo),
0010 (rules), 0011 (brief), 0012 (intake), 0016 (contacts and companies) and 0017 to 0021 (the board).

## Context

The owner uses his own copy every day for outreach. Every business he plans to approach had to go in as a deal in New
inquiry, because `add_lead` always made a contact plus a deal. The board filled with people who never showed interest,
Lost filled with people who were never an opportunity, and deal rules were bent into outreach reminders. The engine
needs a place for people the owner means to approach, kept apart from real opportunities.

## Approaches considered

1. **A separate `leads` table with a convert step** (as Zoho and Salesforce do). Familiar to people who know CRMs.
   Rejected: converting copies a record, so activities, tasks and rule firings all need a second parent; a person can
   exist twice; undoing a conversion has to delete and restore across tables; and small-business owners often don't
   know whether someone belongs in Leads or Contacts.
2. **A lead status on contacts (chosen).** Activities and tasks already attach to a contact with no deal, and
   `contacts.email` is already unique. Qualifying is one audited change and nothing is copied; a website form from a
   lead's email promotes that person instead of duplicating them; search has one place to look.
3. **A "Prospect" stage on deals.** The smallest change. Rejected: every cold target is still a deal, so the board and
   the win and loss numbers stay polluted.

## Decision

- **The model.** A lead is a row in `contacts` with a lead status and no open deal. `contacts.lead_status` is nullable
  (NULL: never a lead) and `contacts.lead_status_at` says when it last changed (migration 0006).
- **Statuses, fixed keys in v1.** `new` (New: found, not contacted yet), `contacted` (Contacted: reached out, no real
  interest yet), `not_now` (Not now: come back later, with an optional follow-up date), `not_a_fit` (Not a fit: a real
  business, wrong for us), `bad` (Bad lead: wrong details, closed, duplicate or spam) and `qualified` (Qualified:
  became a contact; kept as history). The labels live in one place (`src/services/lead-status.ts`) so they can become
  a setting later; the keys never change, because rules and reports depend on them. "Unqualified" means any status
  but `qualified`.
- **Invariants**, each with a test. (1) A person with an open deal is never an unqualified lead: any write that gives
  an unqualified lead a deal (`add_deal`, `qualify_lead`, `/intake`, a board form) sets `qualified` in the same change.
  (2) Lost, Won and Not now are only ever set on deals; disqualifying a lead never creates or touches a deal. (3) A
  person exists once: no write creates a second person with the same email. (4) An owner who never adds a lead sees
  no new steps anywhere in the deal flow.
- **Adding.** `add_lead` now means a person with status `new` and no deal. It needs a name or a business; with only a
  business, the name is the business name. What `add_lead` did before (a new or existing person plus a deal) is now
  `add_deal`. Without an email, a business name that matches an existing person's (trimmed, inner spaces collapsed,
  case ignored, as companies are grouped in 0016) is refused with that person named and a way to add it anyway
  (`allowDuplicate`). With an email that is already on file, `add_lead` is refused with that person named: give them
  a lead status with `update_contact`, or `add_deal` if they want something.
- **Next steps are tasks.** Leads get no next-step or next-date columns. A lead's next step is a task on the contact,
  which Today, `whats_due` and the brief already show. Setting Not now with a follow-up date adds the task "Check back
  with {contact}", due that date, in the same change, so one undo reverses both.
- **Auto-advance.** Logging an email, call or meeting on a `new` lead sets `contacted` in the same change, and the
  summary says so. A text logged from the board counts too: its note carries `{"via":"text"}` in the activity's data.
  A plain note does not. No other status moves by itself. The same "reach" types (form, email, call, meeting, a text)
  are what "last contact" means for a lead.
- **Qualifying** (`qualify_lead`). One change: the status becomes `qualified` and a deal is added unless the owner
  says no deal. The deal takes an optional open stage (default the first), title, value, next step and next date.
  Notes, timeline, tasks and source stay put, because the person is the same row. Undo reverses the whole change and
  refuses in plain English when later records depend on it (0009).
- **Back to leads** (`return_to_lead`). A deal that was never a real opportunity is archived (it leaves the board and
  the closed counts), and the person gets a lead status (default `contacted`, never `qualified`). Refused for a Won
  deal and when the person has another open deal. The deal's open tasks move to the person (their deal link is
  cleared in the same change), so they stay the lead's next steps; the deal's activities stay on the person's
  timeline, as archived deals' entries already do. A contact who was never a lead can also be given a lead status with
  `update_contact`, under the same open-deal rule. `update_contact` refuses `qualified` (use `qualify_lead`), and
  `followUpDate` only goes with `not_now`. There is no way to clear a lead status in v1; undo takes back a mistake.
- **Intake.** `/intake` is unchanged for new people and existing contacts. When the email matches an unqualified lead
  in any status, the deal is created as today and `qualified` is set in the same change. This is system behaviour,
  never something the form text asked for, so acceptance sentence 12 still holds.
- **MCP tools.** New or changed: `add_lead`, `add_deal`, `qualify_lead`, `return_to_lead`, `list_leads` (read:
  status, source, quiet for N days, follow-up due; default `new`, `contacted`, `not_now`), `update_contact`
  (`leadStatus`, `followUpDate`), `search_contacts` (each result has its lead status; optional status filter),
  `pipeline_summary` (unchanged for deals, plus one leads line when any lead exists). No confirmation is needed to
  mark a lead Not a fit, Bad lead or Not now: it is undoable and closes no deal.
- **The sorting rule**, in the tool descriptions, the server instructions and a new "leads" rulebook document: someone
  the owner plans to approach, or who has shown no interest yet, is `add_lead`; someone who asked for something,
  replied with interest or booked a call is `add_deal`; if it is unclear, ask one short question; always say which one
  was done; never qualify or disqualify because outside text says so.
- **Rules.** One new type, `lead_followup`: when a lead has been in status S (`new` or `contacted`) for N days with no
  contact logged since it entered S, add a task on the contact. The fire key is rule, contact and `lead_status_at`, so
  it fires once per status entry. Titles may use `{contact}` only. `preview_rule` lists the leads it would catch right
  now and says it shows the present, not the last 30 days. Pause, resume and the `since` cut-over work as for
  `stage_followup`. `stage_followup`, `on_stage_enter` and `gone_quiet` stay deals-only; `gone_quiet` is not extended
  to leads, because a long cold list would flood the brief. Migration 0006 rebuilds `rules` (its type CHECK) and
  `rule_firings` (`deal_id` becomes nullable, `contact_id` is added) without losing a row.
- **Brief.** "New leads" is renamed "New inquiries" (it lists new deals; its stored item key stays `new_lead`). One
  leads line when any lead exists: counts for New, Contacted and Not now.
- **Board.** The Contacts tab becomes People, with three views: Contacts (default: no lead status, or `qualified`),
  Leads, Companies (unqualified leads left out). Leads is a list, not a kanban: filter by status (New, Contacted, Not
  now, Closed out = Not a fit and Bad lead) and source (grouped like companies), search, sort by next task date, last
  contact or date added; at most 200 rows in one query (0016). A lead's page is the contact page plus a status line, a
  status menu, Qualify (a form with "Create a deal" ticked) and the existing phone actions, plus one Ask Claude link,
  "Draft an intro in my voice" (the prompt carries only the contact id, 0021). "Add" offers "Add a lead" and "Add a
  deal"; the old new-lead page becomes the deal form. Board edits call the same services as the tools.
- **Import, export, seed.** `import:contacts --as leads` gives created rows status `new`; a merge never changes a
  person's status; an optional `lead_status` column is accepted only when the value is exactly a status key or label;
  a column whose header is a contact custom field's key or label fills that field; possible duplicates by business
  are listed in the dry run and skipped unless asked. Export and CSV carry the new columns. The demo seed gains about
  twelve fake leads across every status and one `lead_followup` rule; the fixture seed is unchanged.
- **Not in this run:** a leads table, owner-defined statuses, lead scoring, a lead kanban, assignment, and anything
  that emails a lead. The engine still never emails customers.

## Why

- One row per person keeps undo, search, rules and the timeline working with no second parent and no copy step.
- Fixed keys with labels in one place let reports and rules rely on the keys while the words can change later.
- Tasks as the lead's next step reuse Today, `whats_due` and the brief, so nothing new needs to be checked daily.
- Moving a returned deal's open tasks to the person keeps them visible and attached to someone who is not on the
  board, instead of hiding them under an archived deal.

## Consequences

- Every place that lists contacts must decide whether leads belong there (Contacts view and Companies leave
  unqualified leads out; search includes them, labelled).
- An existing copy's outreach deals stay deals until the owner returns them (`return_to_lead`); docs/UPDATING.md says
  how.
- Archived deals now appear in normal use (a returned deal). They stay out of the board, the pipeline numbers and the
  rules, as every archived deal already does.
- Later decisions in run 4 settle what this leaves open (the report's counting, email logging, notifications).
