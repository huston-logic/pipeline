# 0033: A Contacts search that finds only leads points to Leads

Run 4, final-review fixes, 2026-11-20. Builds on 0016 (contacts search), 0022 (leads on contacts) and 0027 (the People
tab and the Leads list).

## Context

Since 0027 the Contacts view leaves out unqualified leads. The owner's daily use is outreach, so most people he searches
for are leads. A Contacts search for one of them answered only "No contacts match", which invites adding the person a
second time. The whole-run review asked for one line pointing to Leads.

## Decision

- When a Contacts search finds no contacts, the page asks `listLeads` (its default statuses, New, Contacted and Not
  now, with the same search and a limit of 1, for the total only) how many leads match.
- If any do, one plain line follows the "No contacts match" message: "1 lead matches." or "<N> leads match.", then the
  link "See Leads" to `/leads?q=<the same search>`. The address is built with `URLSearchParams`, and the line goes
  through the `html` tag. The search is the owner's own typed text, kept in the query string as the Contacts page
  already keeps it; no lead's text is in the line or the link.
- No line when contacts were found, when no lead matches, or when the only matches are closed-out leads (Not a fit, Bad
  lead), because the Leads view the link opens would not show them.

## Why

- One line where the owner is already looking stops the duplicate add, without mixing leads into the Contacts list
  that 0027 separated.
- Counting the Leads view's default statuses keeps the number equal to what the link shows.
- The extra query runs only on a search with no contact results, so the usual Contacts page costs nothing more.

## Consequences

- Closed-out leads are not hinted at; the owner finds them under Leads with Closed out. Revisit if duplicates of
  closed-out people turn up.
- New copy, changing no existing meaning: "1 lead matches.", "<N> leads match.", "See Leads".
