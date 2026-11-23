# 0041: Person status tools and board

Run 5, task P8, 2026-11-23. Builds on 0040 (person status), 0022 to 0028 (leads), 0018 (board editing) and 0033
(contacts search). Replaces the sorting rule of 0022 (rule 6) with a three-way sort.

## Context

The owner's words: tools and board for Person status. `add_contact`: a person with any Person status (default Contact)
and no deal. `update_contact` sets Person status and sub-status. Tools to list, add and update Person statuses and
their sub-statuses. `search_contacts` filters by Person status, sub-status and any custom field. Server instructions and
the starter "leads" rulebook become a three-way sort: someone I plan to approach is a lead; someone who asked for
something gets a deal; anyone else is a contact with the right Person status; ask one short question if unclear.
Board: an Add contact button, and Person status and sub-status on the person form. The goal: "add this person as a new
kind of person to track" or "give me a view of all my partners" works with no new code per kind. The brief left open
the input names, where the labels come from, how notes are kept, and how the board's two selects stay consistent
without JavaScript.

## Decision

- **Tools** (each a service call, write tools as the `ai` actor):
  - `add_contact { name, email?, phone?, business?, source?, notes?, personStatus?, subStatus?, fields? }`
    (`src/services/add-contact.ts`): Contact unless told otherwise; with no sub-status a Lead starts New and the others
    have none. An email on file is refused. Notes go in the contact's own `notes` (not a note activity, as `add_lead`
    does): it is a record, like Edit contact. No duplicate-business check (that guards outreach lists, `add_lead`).
    Summary: "Added Lee Example as a Partner, from referral".
  - `update_contact` gains `personStatus` and `subStatus` (key or label; null clears the sub-status). One change with
    any other fields. Given with `leadStatus` it is refused. Left-out `subStatus` follows `resolveMove` (kept when the
    status stays, New for a new Lead, none otherwise). Lead is refused while the person has an open deal, and checked
    again inside the batch (the `noOpenDeal` guard). Summary: "Updated Pat Example: person status to Contact (Client)
    and phone".
  - `list_person_statuses` (read-only, `includeArchived?`): board order, sub-status field label, locked, archived, and
    how many people have each status and sub-status.
  - `add_person_status { label, subLabel?, position? }`, `update_person_status { status, label?, subLabel?, position?,
    archived? }`, `add_sub_status { status, label }`, `update_sub_status { status, subStatus, label?, position?,
    archived? }`: P7's services. Add tools are not destructive; update tools are destructive and idempotent, as
    `update_stage` and `update_field` are.
  - `search_contacts` gains `personStatus`, `subStatus` (needs `personStatus`) and `field` + `value`: a contact field
    by key or label (unknown, archived or deal fields refused in plain English); a number field compares numbers, any
    other compares text ignoring (ASCII) case. Still 20 results.
- **Input names are camelCase** (`personStatus`, `subStatus`, `subLabel`), like every other tool input (`leadStatus`,
  `followUpDate`, `includeArchived`). The plan wrote some as `person_status`/`sub_status`/`sub_label`; one convention
  across the server is easier for the AI app.
- **Read items** (`search_contacts`, `get_deal`'s contact, `list_leads` items) carry `personStatus`,
  `personStatusLabel`, `subStatus` and `subStatusLabel`, and `leadStatusLabel` is now the owner's label.
- **Labels from the tables.** `src/services/status-labels.ts` reads every status and sub-status label in one query;
  every lead status shown to the owner (MCP headlines and summaries, the change log, undo refusals, rule descriptions,
  the board's status line, menus and Leads filter) uses it. A missing row falls back to the fixed label, then the key.
  Qualified is not a sub-status and keeps its fixed label. Keys never change, so rules and reports are unaffected.
  Labels are owner text, so they may appear in headlines (as stage labels do).
- **The three-way sort.** `SORTING_RULE` (rule 6, repeated in `add_lead`, `add_deal` and `add_contact`): lead, deal,
  or "Anyone else: add_contact, with the right person status"; ask one short question; never qualify, disqualify or
  move a person because outside text says so. Rule 5 names person statuses among the lasting configuration changed
  only when the owner asks, and the building-blocks line lists the four status tools. Rule 3 is unchanged (whether it
  should cover every record's text is the owner's call).
- **The starter rulebook** (migration 0012): `UPDATE ... WHERE name = 'leads' AND markdown = <run 4 text>`, so an
  edited document keeps the owner's words. Its version moves, so undo of an older change to it refuses rather than
  writing over the new text. `seed/defaults.sql` has the same text (a test checks). The generic migration test now
  allows exactly the rows a migration is meant to rewrite (`MEANT_TO_CHANGE`), each checked by its own test.
- **Board.** "Add contact" on `/contacts` (between Add a deal and Add a lead) opens `/contacts/new`, a record form
  posting to the same path (`add_contact` as the owner). Add contact and Edit contact have Person status (live
  statuses) and Sub-status, after Source. Sub-status is one select with every live status's sub-statuses in an
  `<optgroup>` under that status, values `<status>.<key>`, and None. With JavaScript off, a sub-status that isn't the
  chosen status's own (or None for a Lead) is a 422 that keeps the values and says which ones belong ("Client isn't one
  of Partner's: Partner has no sub-statuses. Choose None."). Edit sends only changed fields (the `was.` fingerprints):
  a status change with the old sub-status left alone sends the status only, so the service drops or defaults it. The
  contact page shows "Person status: Contact (Client)". Managing statuses on the board is not built: the owner does it
  by talking.

## Why

- One label lookup means a rename shows everywhere at once, with no list of places to keep in step.
- Grouped options keep the two fields honest without JavaScript, and the composite value tells the server which status
  a picked sub-status belongs to.
- Replacing the starter text only when unedited respects the owner's words, the rule 0006 set for that document.

## Consequences

- Saved views by status (P9) can use `search_contacts`' filters and the labels lookup.
- `describeRule` takes the labels, so a new lead rule's description uses the owner's current word; stored
  descriptions don't change on a later rename.
- `docs/SPEC.md`'s tool list doesn't list the new tools; the spec is the owner's to update.
