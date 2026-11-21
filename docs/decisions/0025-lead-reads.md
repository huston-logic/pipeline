# 0025: How the lead reads count

Run 4, task L4, 2026-11-20. Settles what 0022 left open for `list_leads`, the leads line in `pipeline_summary` and the
brief, and lead status in `search_contacts`. Code: `src/services/leads-read.ts`.

## Context

0022 names the reads but not their edges: how "within N days" counts, what "quiet" measures for a person with no
deals, how source groups are labelled, and what happens to snoozed tasks.

## Decision

- **Who is listed.** Unarchived people with a lead status. Default statuses New, Contacted and Not now; Not a fit, Bad
  lead and Qualified only when named.
- **Last contact** is the latest form, email, call, meeting or text (the `isReach` rule of `lead-change.ts`, written in
  SQL), on the person or on any of their deals, archived ones included. A plain note does not count.
- **Quiet for N days** means the latest reach (or, with none, the day the lead was added) is N days or more before now,
  the same test `gone_quiet` uses for deals.
- **Next task** is the soonest open task with a due date that is not snoozed past now, on the person or on one of their
  deals. A snoozed task does not count until it wakes.
- **Due within N days** means that next task is due before the end of the owner's local day N days from today, overdue
  ones included. N = 0 is "today or overdue". "Follow-ups due this week" in the summary is N = 6, counted as people.
- **Sorts.** `next_task` soonest first, `last_contact` longest ago first, `added` newest first. People with no next
  task or no contact go last; ties go by name.
- **Source groups** are keyed like companies (trimmed, inner spaces collapsed, case ignored), count the leads that
  match the statuses and the text (the source filter does not narrow them, so the picker keeps its other choices) and
  leave out leads with no source. The label is the earliest trusted spelling, else the earliest outside one, and
  `outside: true` marks a group whose every spelling came from outside, as 0016 does for companies.
- **Outside text.** Each item lists its outside values (name, business, source, email, phone) in `untrusted_fields`.
  Headlines carry counts only.
- **Summary and brief.** The summary's `leads` is null unless New, Contacted or Not now is above zero (invariant 4); its
  sentence lists the non-zero statuses among the five unqualified ones. The brief's Leads section is one line with the
  non-zero counts among New, Contacted and Not now, and the section is absent when all three are zero.
- **Limit.** At most 200 items, with `total` saying how many match.

## Why

Reusing the `gone_quiet` test and the 0016 company grouping keeps every number the owner sees in step with the ones he
already knows. Counting only awake tasks matches Today and `whats_due`.

## Consequences

- `ContactView` (so `get_deal`, the contact page data and `search_contacts`) gains `leadStatus` and `leadStatusLabel`.
- A lead whose only task is snoozed shows no next task and is not "due".
