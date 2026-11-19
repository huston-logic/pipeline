# 0016: Contacts search and sort, contact pages, the Companies view and the demo seed

Run 2, task R2, 2026-11-19. Builds on 0013 (board pages, outside text) and 0015 (board look and navigation).

## Context

The owner could not see contacts or companies on the board. The run 2 brief asked for a searchable, sortable Contacts
tab that works without JavaScript, a page per contact, a Companies view grouped by the contact's `business` (there
is no companies table), and a demo seed that looks like a real small engineering firm, with entries in the change
log. It left open how search matches, how sorting and the list size work, how companies are grouped and named, how
the two views share one tab, and how seeded `audit_log` rows stay safe to undo.

## Decision

- **Search** (`listContacts` in `src/services/read.ts`). `/contacts?q=` matches the text anywhere in the name, email,
  phone or company, ignoring case (SQLite `LIKE`, so case is ignored for A to Z only; `%` and `_` are plain text).
  The text is trimmed and cut to 100 characters. An empty search lists everyone. The page says "18 contacts.",
  "3 contacts match "smith"." or "No contacts match ...", with a Clear search link that keeps the sort.
- **Sort.** One select, `sort=<key>-<asc|desc>`: name A to Z (the default) or Z to A, company A to Z or Z to A, most
  or fewest open deals, latest or oldest activity first. Ties go by name. Contacts with no company, or nothing logged,
  go last either way, so the top of the list is always the useful part. An unknown value falls back to the default.
  A GET form with `role="search"`, a visible label, a hint and a "Show contacts" button; no JavaScript.
- **Limit.** The list shows at most 200 contacts (`CONTACT_LIST_LIMIT`) and then says "Showing the first 200 of N
  contacts. Search to narrow it down." It is one SQL query: two aggregate CTEs (open deals per contact, as a count
  and a JSON list; newest activity per contact, on the contact or any of their deals) joined to `contacts`, with
  `COUNT(*) OVER ()` for the total before the limit. No query per contact.
- **Contact page** `/contacts/<id>` (`contactDetail`): details (email, phone, company, source, custom contact fields
  from `field_defs`, notes, added), every deal that is not archived (open and closed, in board order), open tasks on
  the contact or their deals, and one timeline of the contact's own entries and their deals' (newest first, the
  latest 50; the page says so when there are more). Each timeline entry on a deal says which deal. Outside text is
  labelled as on the deal page; an outside name becomes "Contact ct_…" in links, the `<title>` and the description.
  `isContactId` in `src/ids.ts` (like `isDealId`) refuses anything that can't be a contact id, which gets the 404
  page without a lookup. The deal page's contact card links to the contact page ("Open the contact page").
- **Companies** (`listCompanies`). Contacts that are not archived are grouped by `business`, trimmed, inner spaces
  collapsed and compared ignoring case; blank or missing goes to "No company", shown last. A company is shown with
  the spelling on the earliest contact the owner or the AI gave it; if only outside text names it, its first
  spelling is shown with the "From outside" label. Companies are sorted by that name. Each card lists its people
  (linked, by name), its open deal count and open value, and its open deals with their stage. No URL is ever built
  from a company name (no per-company page); the page needs no in-page anchors.
- **One tab, two views.** `/contacts` and `/companies` both start with a two-link switch, "People" and "Companies",
  with `aria-current="page"` on the one shown. The Contacts tab is current (`aria-current="true"`) on `/companies`
  and on every contact page. The switch is a list of links, not a second `nav` landmark.
- **Demo seed** (`scripts/seed-dev.ts`). "Fernbrook Engineering (demo)", a made-up structural engineering firm: 18
  contacts at 11 companies (five with two or three people; one company typed in lower case with a stray space, to
  show the grouping; one homeowner with no company), 20 deals over every stage (3 new inquiry, 3 replied, 3 call
  booked, 2 call done, 3 proposal sent, 3 won, 2 lost, 1 not now), values from 950 to 22,000, a contact Role field
  and a deal Project type field, about 70 activities, 11 tasks (overdue, due later today, upcoming, snoozed, done,
  one on a contact alone), one website-form lead whose outside text says it is made up, and yesterday's brief. Every
  address is at example.com, example.org or example.net. The business name is set only when the local copy has none.
  `dl_seed01` (a normal deal), `dl_seed02` (the form lead) and `ct_seed01` keep their ids and roles. Deal dates
  (`last_activity_at`, `stage_entered_at`) are computed from the seeded activities, the way the services keep them.
- **Seeded change log.** Thirteen `audit_log` rows from the last 30 days, by the owner, the AI and the form, with
  real snapshots of full rows. The newest change on each row matches the row as seeded, so undo works on it exactly
  as on a live copy (nine of them). Four are refused, each with what `undo_change` really answers: the AI's earlier
  move of Elena's deal to Call booked (`chg_seed00000013`) gets "deal … changed since (see recent_changes)", because
  the deal has moved on to Call done and nothing depends on what the change added; Dana's lead as first added
  (`chg_seed00000003`) gets "other records now depend on it (5 activities and 1 task)", because undo would remove the
  contact that later activities and a task point at (dependents are checked before "changed since"); one AI move
  that was undone a few minutes later (`chg_seed00000006`) gets "already undone"; and its undo entry
  (`chg_seed00000007`) gets "Undo entries can't be undone". A seed test runs `undo_change` on every seeded change and
  checks each of these answers. This was chosen over marking every row as undone: the demo's Undo (task R3) should
  work on it. Dana's refusal suggests changing the dependent records first, which the owner can't do (no delete
  tools); it is kept as the honest answer for a lead that has history, and the "changed since" case is the one the
  demo shows for an edited record.
- **Tests and the seed.** The unit tests that needed exact seed names, ids and counts now load the old seed,
  unchanged, from `tests/helpers/fixture-seed.ts`; the demo seed has its own tests that check its shape, not its
  names. The e2e and acceptance tests run on the demo seed and were updated to its people and counts; the intake e2e
  test now compares counts with the seed's own. This closes the run 1 finding "test dependence on seed ids".

## Why

- Search on the four fields an owner remembers someone by, ignoring case, is what a phone search box is expected to
  do; a GET form keeps it working with no JavaScript and makes every search a link.
- Putting "nothing yet" last whichever way the list is sorted keeps the first screen useful on a phone.
- 200 cards is already a long phone page; a later task measures CPU on 2,000 deals, and one query with aggregates
  costs the same whatever the number of contacts shown.
- The spec's company is the contact's `business` text, so grouping must forgive how people type it; preferring the
  owner's spelling, and labelling one that only came from a form, keeps outside text from becoming a trusted heading.
- Real snapshots keep the change log honest: what the board shows is what undo would do.

## Consequences

- `LIKE` ignores case for ASCII only: "élan" does not find "ÉLAN". Revisit if a copy has many non-English names.
- A website form can name an existing company; that contact joins the company's card, labelled From outside.
- The Companies page has no limit; with thousands of contacts it is long. Revisit with the CPU measurement task.
- Tests that need fixed data must use the fixture; changing the demo seed only touches the seed's own tests, the e2e
  tests and docs/ACCEPTANCE.md.

## "AI defaults" (human-touch-design), flagged for the owner

- **A segmented two-button switch** (People / Companies) with a tinted current item: a common app pattern, my choice.
  Alternatives: two plain links in the lede ("Show by company"); or tabs as underlined text.
- **Every company as an identical card** (item 4, the SaaS-card kit), required by the brief ("each company a
  card/section"). Alternatives: one panel with a row per company and its people inline; or company sections with
  the people's cards under each heading.
- **Small grey headings inside cards** ("People", "Open deals"): labels above content, my choice, because a card
  holds two lists. Alternative: one list of people, with each open deal under its person.
- Not used: eyebrow labels, all caps, middle dots in the stage notes, arrows on links, count badges.
