# 0018: Editing from the board: forms, changed-fields-only edits, tasks, logging and a deal for a known contact

Run 2, task R4, 2026-11-19. Builds on 0014 (editable board), 0015 (look), 0016 (contacts) and 0017 (the write path).

## Context

R3 built one write path (a route table, the sign-in, origin and CSRF checks, Post/Redirect/Get with the change banner
and Undo) and used it for moving deals. The run 2 brief asked for the rest of the owner's daily edits on the same
path: add a lead, add a deal for a contact already on file, edit a contact and a deal, add, complete and snooze tasks,
and log a call, email, meeting or note. It left open whether forms are pages or inline, how an edit form avoids turning
outside text into the owner's word (`update_contact` marks every field it sets as the owner's), how dates are entered,
what the snooze presets are, how a deal is added for a contact with no email, and how refused forms look.

## Decision

- **Pages for records, inline for small things.** New lead (`/leads/new`), a new deal for a contact
  (`/contacts/<id>/deals/new`), Edit contact (`/contacts/<id>/edit`) and Edit deal (`/deals/<id>/edit`) are pages,
  posted back to their own path, and are in `boardRoutes`. Add a task and Log sit on the deal and contact pages under a
  native disclosure ("Add a task", "Log a call, email or note"); Done and Snooze sit on every task card (Today, the
  deal page, the contact page). Every one is a plain form through the R3 route table, calling the matching service as
  actor `owner` with the MCP tool's name: `add_lead`, `update_contact`, `update_deal`, `add_task`, `complete_task`,
  `snooze_task`, `log_activity`.
- **Changed fields only.** Each field of an edit form carries a fingerprint (22 characters of the SHA-256 of the value
  as drawn, `was.<name>`). On save, a field whose posted value still has its fingerprint was left alone and is never
  written; one the owner changed is in the patch (empty sets null); one both the owner and another writer changed is a
  conflict, nothing is saved, and the form comes back showing the stored value with a message. A field the owner left
  alone keeps another writer's newer value. What a browser does to an untouched value (CRLF in a textarea, newlines
  dropped from an input, spaces at the ends) is not a change. Saving with nothing changed is refused ("Nothing to save").
  So re-saving a form never confirms outside text: a value stays labelled "From outside" until the owner changes it,
  and the form says so. Fingerprints rather than hidden copies, because a 10,000-character note twice would pass the
  16 KB form limit.
- **A deal for a known contact.** `addLead` takes an optional `contact` (id or exact name); the name is then not
  needed, the deal goes to that contact, and their details are left as they are (the summary says so when details were
  given). A default title built from a name that came from outside is marked as outside text, as `/intake` does.
  MCP `add_lead` takes the same `contact` (no new tool); its `name` is now optional and the service asks for it when
  neither is given. On the board the deal title is required on this form, so no title is built from a name.
- **Dates.** A date input plus an optional time input, read in the owner's timezone (`YYYY-MM-DD` or
  `YYYY-MM-DDTHH:mm`, as the services take them). Not `datetime-local`: a half-filled one is sent as empty, which would
  silently clear a date. A time with no date is refused. Next date and Due: no time means the start of that day. Log:
  both blank means now; a date with no time is refused. Snooze until: no time means 9:00 AM.
- **Snooze presets**, in the owner's timezone as wall-clock times: "Tomorrow morning" is 9:00 AM tomorrow, "Next week"
  is 9:00 AM next Monday (a week ahead when today is Monday). The presets are one form and the date and time another,
  so Enter in the date field never picks a preset. A hint line says what the presets mean.
- **Refused forms.** A 422 with "Error: " in the title, an error summary (`role="alert"`, an h2 with the count, each
  message linking to its field), the message above each field in rust with "Error:" for screen readers,
  `aria-invalid` and `aria-describedby`, and the values kept. A service's own refusal (an email another contact uses, a
  task already done, a time in the past) is in the summary. Inline forms come back on their own page ("The task wasn't
  added", "Nothing was logged", "The task wasn't snoozed") with "Back to the page".
- **Where things go.** A new lead or deal opens the new deal's page with the banner. An undo that removes the record
  the page was about (a new lead's deal) goes to its list (`/pipeline`, `/contacts`) instead of a 404. New lead
  carries `?from=today|pipeline|contacts`, which only sets where Cancel goes back to.
- **Fields.** Labels on every field, "(required)" in words, custom fields from `field_defs` by type (text, number,
  date, choice as a select with "Not set"); archived fields are left off. Numbers are text inputs with a decimal keypad
  (a number input drops "1,500" silently); commas are allowed. Record inputs have `autocomplete="off"`: they hold other
  people's details, and autofill would offer the owner's own.
- **Copy.** The undo confirm page says "It removes 1 task. This can't be reversed." The footer says "Add leads, edit
  contacts and deals, and move, log and undo here, or change anything by talking to your AI app." Empty states name
  what the board can do now (Today: "Add a task on a deal or contact page, or add a new lead.").
- **Code.** The editing routes are in `src/board/edit-actions.ts`, listed in the R3 route table; shared handler pieces
  moved to `src/board/action-kit.ts`. The log route takes `type`, `summary` and `when.date`/`when.time`, so task R5's
  one-tap logging can post to it.

## Why

- Long forms read best as their own page on a phone; a task or a note is a few words beside the record it is about.
- Sending only what changed is the only way to keep `untrusted_fields` honest without changing `update_contact`, and it
  stops one tab from quietly undoing another's edit.
- A date plus an optional time matches how people think about follow-ups ("Friday", "Friday at 2") and never loses a
  date to a half-filled control.

## Consequences

- An owner who wants to confirm an outside value without changing it can't do it from the board; they ask the AI app
  (`update_contact` with the same value), which is the existing way.
- `/leads/new`, the two edit pages and the new-deal page accept POST; the board test that every page answers 405 to
  POST skips them.
- Four more routes for the a11y, Lighthouse and screenshot checks.

## "AI defaults" (human-touch-design), flagged for the owner

- **Every form in one white card with stacked full-width fields** (item 4, the SaaS-card kit). My choice.
  Alternatives: fields straight on the page with a divider between Contact and Deal; or two columns of fields from
  60rem.
- **Done and the snooze presets as quiet outline buttons on every task card.** My choice, so a list of cards isn't a
  wall of green. Alternatives: Done as a small primary button; or a checkbox-style "Mark done" link.
- **A rust-bordered error summary box.** A common pattern (GOV.UK-like). Alternatives: the messages as a plain list
  under the h1; or only the per-field messages with a one-line count.
- **Disclosures for Add a task and Log** (the browser's triangle, in accent). Alternatives: the forms always open; or
  links to their own pages.
- Not used: modals, toasts, floating action buttons, icons on buttons, placeholder text as labels.
