# 0027: The People tab (Contacts, Leads, Companies) and the Leads list

Run 4, task L6, 2026-11-20. Builds on 0016 (contacts and companies), 0022 (leads on contacts) and 0025 (lead reads).

## Context

A lead is a contact row with a lead status (0022). The board had a Contacts tab with a two-link switch (People,
Companies). Leads needed a list of their own, and the people who are not yet worth a deal should not crowd the
Contacts list or the Companies cards.

## Decision

- **Nav.** The "Contacts" tab is now "People" (description "Contacts, leads and companies."); its address is still
  `/contacts`, its icon is unchanged. `/leads`, `/leads/new` (until task L7 moves it), `/companies` and every
  `/contacts/<id>` page mark People as the current section (`aria-current="true"`).
- **Three views.** `peopleSwitch` (`src/board/people-switch.ts`) draws Contacts, Leads and Companies, replacing the
  two-link switch of 0016. The Contacts page keeps its title and heading, "Contacts".
- **Contacts and Companies leave out unqualified leads.** `listContacts` and `listCompanies` skip a contact whose
  lead status is New, Contacted, Not now, Not a fit or Bad lead. A qualified lead is a normal contact and stays.
- **`/leads`** reads only `listLeads` (one query plus the source groups). The query is `status` (`open` by default:
  New, Contacted, Not now; or `new`, `contacted`, `not_now`, `closed` = Not a fit and Bad lead), `source` (an
  opaque token, below), `q` (name, email, phone or company; trimmed, 100 characters) and `sort` (`next_task`, `last_contact`,
  `added`). Anything unknown falls back to the default; an unknown or empty source token shows all sources (the token is
  resolved against the sources the first query returns; a known one adds one more query). A GET form with `role="search"`, a visible label on every control, a hint on the
  search box and a "Show leads" button; no JavaScript.
- **Rows** are cards like Contacts: the name (a link; an outside name is "Contact ct_…" in the link text with the
  "From outside" label beside it), the company (labelled when outside), Status, Last contact (a date, or "No contact
  yet") and Next task (a date, or "No task"). Dates are the owner's local time, as elsewhere.
- **Limit and counts** as 0016: at most 200 rows, "Showing the first 200 of N leads. Search to narrow it down.",
  "12 leads.", "3 leads match "smith".". The empty page says "No leads yet. A lead is someone you plan to approach who
  hasn't asked for anything yet." only when nobody holds a lead status; when only closed-out leads exist the open view
  says "No open leads. Choose Closed out under Status to see the rest."; another status with none says "No leads
  with that status." A search with no match says so and what to try.
- **Page titles** differ by status filter so each address in `boardRoutes` keeps a unique title and description:
  Leads, New leads, Contacted leads, Leads for later, Closed out leads. They never contain a lead's text.
- **Source options** show the source's spelling and its count ("Trade show (3)"), with ", from outside" when every
  spelling came from outside. The text sits in an `<option>`, which is neither a link nor the title or description.
  The option's value, and the Clear search link, carry only an opaque token (two FNV-1a hashes of the source key, 16
  hex characters), never the source text, because a source from outside must not become part of a URL (0016).
- **No "Add a lead" button yet.** `/leads/new` is still the person-plus-deal form until task L7 changes it, so the
  page leaves the button to L7. The Contacts page keeps its "New lead" button.
- **Demo seed.** Unchanged here (task L8 seeds about 12 leads), so `/leads` shows the empty state on the demo copy
  until then.

## Why

- One tab with three views keeps the phone tab bar at five items while giving leads a place.
- Leaving unqualified leads out of Contacts and Companies keeps those views about people already in a conversation
  or a deal, and avoids showing the same person on two lists.
- Cards and the same search form as 0016 mean the owner learns one pattern.

## Consequences

- A copy with only closed-out leads sees "No open leads." on the default view; the Closed out filter shows them.
- Two sources that hash alike would share a token (the first listed wins); with 64 bits this is not a practical risk.
- Opening an unqualified lead from the Leads list goes to the ordinary contact page (`/contacts/<id>`).
- The People tab name is a change in the meaning of one nav word; the owner may rename it.

## "AI defaults" (human-touch-design), flagged for the owner

- **A three-button segmented switch** with a tinted current item: the same pattern as 0016, extended. Alternatives:
  three plain links under the heading; or underlined text tabs.
- **Every lead as an identical card** (item 4, the SaaS-card kit), matching Contacts. Alternatives: one table-like
  list with a row per lead and the status as a column; or rows grouped under the status headings.
- **Label/value pairs inside each card** ("Status", "Last contact", "Next task"): labels above content, chosen so each
  fact reads on its own on a phone. Alternative: one line, "Contacted. Last contact Mon Nov 16. Next task Thu Nov 19."
- Not used: eyebrow labels, all caps, middle dots, arrows on links, count badges, new motion.
