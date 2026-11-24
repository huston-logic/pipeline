# 0050: The timer on the board

Run 6, task D7, 2026-11-24. Builds on 0049 (time entries, the timer, work types and client rates), 0021 (Ask Claude
prompts carry ids only) and 0047 (Today as a list).

## Context

0049 gave the owner `start_timer` and `stop_timer`, but only the AI app could use them. The owner works at a phone or
a desk and wants to start a timer from the person, deal or task they are about to work on, see that it is running on
every page, and stop it with a few words about what was done, which become a note and, when asked, a next step task.

## Decision

- With time tracking on, a person's page, a deal's page and each task row have a Start timer form: a plain POST to
  `/timer/start` with the subject's id as a hidden field. It calls `start_timer` as the owner and answers 303 back with
  the change banner. While a timer runs the buttons are not drawn; a post made anyway is a 422 page with 0049's words
  ("A timer is already running for ... since ... Stop it first.").
- While a timer runs, a one-line Stop bar is the first thing in the page body on every board page that gets the page
  frame: "Timer", who it is for, "since 9:10 AM", and a Stop link. Stop is a link to `GET /timer/stop`, not a post,
  because Stop opens a form. No JavaScript and no live clock.
- `/timer/stop` asks "What did you do?": Notes, Work type (None first, the running entry's own preselected), Billable
  (ticked when that work type is billable by default), Next step date (optional), Start and End (date and time,
  preset to the start and now). `POST /timer/stop` calls `stop_timer` as the owner and answers 303 to
  `/timer/done?entry=<te id>&change=<chg id>`. A start or end left as drawn is not sent, so the timer keeps its own
  start (with its seconds) and the end is the moment of saving; one the owner changed is sent. A refusal (for
  example 16 hours, 0049) draws the form again, 422, with the values kept and the timer still running. With no timer
  the page says "No timer is running." and links Today.
- `/timer/done` shows what was saved (time, work type, billable, rate, amount, who, start, notes), links to the note's
  timeline and the next step task when they were made, and offers one Ask Claude prompt, "Ask Claude to turn these
  notes into updates", with Copy prompt. The prompt is fixed text around two ids: "Read time entry te_... and its note
  ac_... in my pipeline and propose the updates they imply, with propose_changes." With notes but no note record (a
  timer for no one) it names the entry alone.
- While time tracking is off nothing is drawn (no button, no bar) and every `/timer/*` path, post or page, is a 404. A
  timer left running when tracking was turned off is not shown.
- Board pages: `/timer/stop` (the seed has no running timer, so it is the "No timer is running." page) and
  `/timer/done?entry=te_seed01` are in `boardRoutes`. Lighthouse: `/timer/done?entry=te_seed01` takes the slot of
  `/leads/new`, a form page whose kind `/contacts/ct_seed02/edit` already covers.
- The demo seed turns time tracking on and adds the Design and Admin work types and one finished entry, `te_seed01`,
  with a note on the won taproom deal (older than its last call, so no last contact moves). No timer is seeded, so
  no page's screenshot gains a bar.

## Why

- The services already did everything; the board only needed the doors. Posting through the same services keeps one
  audit row and one undo per tap, and the AI edits setting stays for the AI app alone (0045).
- A bar on every page is the only way to remember a timer is running; its words, not its tint, say so.
- Not sending an unchanged start or end avoids rounding the stored start to the minute and avoids an "end" older than
  the click.
- Only ids go in the Ask Claude prompt (0021): notes are the owner's text, but names and titles may be outside text.

## Consequences

- The bar sits in `.app-body` (above `main`), not in `<header>`: on wide screens the header is the side bar and the
  bar would have no place there. It follows the header in the document.
- Refused-post pages drawn with a bare frame (the generic refusal page, 404) have no bar; pages of the form posts
  that refuse with a full context (the stop form) do.
- Choosing None for the work type does not clear the work type a timer already has (the service cannot); the form
  preselects the timer's own.
- Billable is preset from the timer's work type; changing the work type in the form does not tick Billable without
  JavaScript. The owner ticks it.
- The done page finds a next step task by the moment the entry was saved, so after the entry is edited later the
  link to it is not shown.
