# 0028: A lead's page, the status menu, Qualify, Add a lead or a deal, and Back to leads on the board

Run 4, task L7, 2026-11-20. Builds on 0022 (leads on contacts, binding: its Board section), 0023, 0024, 0027 (People
views), 0017 and 0018 (the write path and record forms) and 0021 (phone actions, Ask Claude).

## Context

0022 says what the board offers for leads; the copy was fixed by the owner's run brief. This records the calls the
brief left open.

## Decision

- **Routes.** Pages: `/leads/new` (Add a lead), `/deals/new` (Add a deal: the old New lead form, unchanged in what it
  does, now in the Pipeline section) and `/contacts/<id>/qualify`. Posts, in `src/board/lead-actions.ts` (listed in the
  route table): `/leads/new` (`add_lead`), `/contacts/<id>/lead-status` (`update_contact`), `/contacts/<id>/qualify`
  (`qualify_lead`) and `/deals/<id>/return-to-lead` (`return_to_lead`); `/deals/new` (`add_deal`) stays in
  `edit-actions.ts`. `/contacts/<id>/deals/new` is unchanged.
- **Add buttons.** Today, Pipeline and Contacts show "Add a deal" (primary) and "Add a lead" (quiet) under the lede;
  Leads shows "Add a lead" alone, as the primary button. `?from=` (today, pipeline, contacts, leads) only sets where
  Cancel goes; Add a lead falls back to Leads, Add a deal to Pipeline. Empty states that named "New lead" now name the
  new buttons; Pipeline's says "Inquiries from your website form" (a website form makes a deal, not a lead; 0022 renamed
  the brief's "New leads" to "New inquiries" for the same reason).
- **Add a lead.** Name, Business, Email, Phone, Source, Notes and the contact custom fields. Neither a name nor a
  business is refused on the Name field. The service's duplicate refusals are a `DuplicateLeadError` (a `UserError`
  that says which check and names the person through `contactRef`), so the board can say them in its own words and
  never shows tool names: an email on file names the person; a business on file names them and shows an "Add anyway"
  checkbox (`allow_duplicate=yes`). The new lead's page opens with the banner.
- **A lead's page.** Only a person with a lead status gets the "Lead" section (invariant 4). An unqualified lead who is
  not archived gets the status line, the status menu, Qualify, "Back to leads" as the page's back link and the Ask
  Claude intro. A Qualified or archived person gets the status line only, as history; they are not offered status
  changes or Qualify (making someone a lead again stays an MCP action in v1, 0022).
- **The status menu** needs no confirmation (0022). The check-back date is always shown (no script), with its hint; the
  board refuses a date with any status but Not now in its own words before calling the service. Saving the status a
  lead already has, with no date, gets the service's "Nothing to change" answer.
- **Qualify.** "Create a deal" is a checkbox, ticked; an unticked box sends nothing, which means no deal. Deal details
  given with no deal are refused (as 0024's service does), in board words. The stage select lists the open stages, the
  first chosen. No notes or custom fields (0024). With a deal it opens the deal page, else the person's page.
- **Back to leads** is a small quiet button under Move to on open, Lost and Not now deals that are not archived. A post
  without `confirm=yes` draws the confirm page with a "Lead status" select (Contacted chosen). A post for a Won or
  archived deal skips the confirm page and gets the service's refusal (it is never offered for them). Confirmed, it
  opens the person's page.
- **Where Undo lands.** When an undo removes the record the page was about, the board now looks first: a removed deal
  whose person is still there goes to that person (an undone Qualify, or an undone deal for someone on file, which went
  to Pipeline before); a removed lead goes to Leads; anyone else to Contacts, as before.
- **Ask Claude.** One prompt, "Draft an intro in my voice": "Draft an intro to contact ct_… in my voice. Read my
  rulebook first, then the contact." (the id only, 0021). The note says it names this person by their id only.
- **Screenshots.** The demo seed has no leads until task L8, so `tests/screenshots/leads.screens.ts` adds one through
  Add a lead, takes the lead's page, Qualify, and the Back to leads confirm page, then undoes the lead. A lead's page
  and Qualify are not in `boardRoutes` until the seed has a lead with a fixed id.

## Why

- Board words for service refusals keep MCP names (`allowDuplicate`, `update_contact`) off the owner's screen.
- Checking the date and the deal details on the board ties each message to its field.
- Showing a Qualified person's status as a line keeps the history visible without offering steps that would be refused
  or would need a decision the spec leaves to the AI app.

## Consequences

- `leadSpecs` is now `personDealSpecs`; `newLeadSpecs` is the lead form.
- The old `/leads/new` bookmark now opens Add a lead, not the person-plus-deal form.

## "AI defaults" (human-touch-design), flagged for the owner

- **The Lead section as one more white card** (item 4, the SaaS-card kit), matching Details. Alternatives: the status
  line under the h1 as a lede with the menu in a disclosure; or the status and Qualify in the Details card's foot.
- **Two buttons side by side, primary and quiet**, for Add a deal and Add a lead. Alternatives: one primary "Add"
  button opening a page with the two choices; or Add a deal as the button and Add a lead as a plain link.
- **Qualify as a full primary button** below the status menu, on a divider. Alternatives: a plain accent link like
  "Add a deal"; or Qualify beside Save status as a quiet button.
- Not used: badges or coloured pills for statuses (the words carry it), icons, modals, toasts.
