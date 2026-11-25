# 0053: Campaigns, step 1

Run 8, 2026-11-24. Migration 0019. Builds on 0031 (email logging, which uses the `email` activity type) and 0049
(the settings and switch pattern). Campaign tools are not proposals.

## Context

The run 8 brief asks for email campaigns to groups of people, for owners who asked for them: newsletters and event
invites now, follow-up series later. There are two doors to one campaign. The owner can ask their AI app to set it
up, or build it by hand on the board. Either way it is the same draft, on a Campaigns page. Nothing sends until the
owner reviews it there and taps send.

SPEC.md lists "Sending to groups or campaigns" and "emailing leads" as out of scope for v1. This decision brings
campaigns into scope for step 1 and removes those two items from the out-of-scope list.

## Decision

Six hard rules, from the brief:

1. Only the board sends. "Approve and send", "Schedule" and "Send test to me" are board actions behind the owner's
   sign-in. No MCP tool sends, schedules, approves, pauses, cancels or clears a suppression. The AI can only create
   and edit drafts.
2. Off until set up. The Campaigns setting is off by default. Sending also needs the copy's own switch, Resend key
   and from address, and a postal address in settings. The review page names the first missing piece.
3. Unsubscribe always works. Every email has a one-click unsubscribe link, the List-Unsubscribe headers, the business
   name and the postal address. The unsubscribe page is public and shows only the business name.
4. Suppression is permanent for campaigns. Unsubscribed, bounced and complained addresses are never sent a campaign
   again. The AI cannot clear one. The owner clears an unsubscribe only on the person's page, with a confirm.
5. No one gets the same campaign email twice. The list is frozen at approval, with one recipient row per person per
   step. This holds on retry, pause and resume.
6. Client-owned sending. Mail goes from the owner's own Resend account, on a sending subdomain. No client keys or
   addresses go in the repo.

The rulings the brief left open:

- **Ruling 1: recipient and batch rows are delivery records, not audited changes.** Each approve, batch and
  suppression writes its rows beside an audited change. A delivered event writes its row alone. These rows are never
  undone. Why: one audited row per delivered event would flood the Changes page. Cost if wrong: if the owner wants
  every delivered event in Changes, thousands of rows would show there.
- **Ruling 2: at most 2,000 people per campaign.** More is refused with "narrow the group". Why: the import's own
  cap. Cost if wrong: a bigger list needs two campaigns. Measured (docs/PAID-PLAN.md, "Run 8"): approving 2,000
  people is 6 D1 calls, one of them a batch of 8 statements, so the cap stays.
- **Ruling 3: outside text never goes into an email.** The first name is the first word of the person's name, only
  if that name is not in the person's `untrusted_fields` and the word is 1 to 40 letters, with `'` or `-` allowed.
  Otherwise the campaign's fallback is used ("there" by default). Why: a name from a form or import is outside text.
  Cost if wrong: imported people get "Hi there" until the owner confirms their names.
- **Ruling 4: a small body format, not markdown.** Paragraphs split on blank lines, single line breaks are kept,
  links are `[text](https://…)` or a bare `https://…` URL. Only https links. Merged values never become links.
  `{{first_name}}` merges in the subject and body. Why: no HTML from the owner and no parser to maintain. Cost if
  wrong: an owner who types markdown bold sees the asterisks.
- **Ruling 5: reply-to is the owner's email.** It is the first owner email in `settings.owner_emails`, else the first
  in `OWNER_EMAILS`. Why: replies should reach the owner's mailbox, not the sending subdomain. Cost if wrong: a
  separate reply-to address needs one more setting.
- **Ruling 6: the daily limit counts UTC days.** `settings.campaign_daily_limit` defaults to 90 and is at most 5,000.
  A run sends at most 100 (one batch). Why: Resend counts UTC days, and 90 leaves room on Resend Free (100 a day) for
  the brief and for tests. Cost if wrong: the owner's day and the limit's day differ by their UTC offset.
- **Ruling 7: a batch already handed to Resend always resolves.** Pause and cancel stop new batches only. Why: the
  copy cannot know what Resend did, so resolving is the only way to avoid a double send. Cost if wrong: up to 100
  emails can go out after a pause or cancel. The confirm says so.
- **Ruling 8: a campaign email does not count as reaching a person.** Campaign activities have `via: "campaign"`,
  and `isReach`, `REACH_SQL` and `leads-read.ts`'s `REACH` skip them. No deal's last activity moves, and a New lead
  stays New. Why: a newsletter is not a follow-up, so it must not silence `gone_quiet`, `stage_followup` or
  `lead_followup`. Cost if wrong: if the owner wants a campaign to count as contact, the three exclusions come out.
- **Ruling 9: the unsubscribe token is stored, not derived.** It is 32 random bytes (base64url), made at approval and
  kept on the recipient row. It is not an HMAC of a Worker secret. Why: a stored token keeps every sent link working.
  A lost or changed key would break them. A retried batch also rebuilds a byte-identical payload. The token is never
  shown on the board, in MCP answers, in logs or in the export. Cost if wrong: a key-signed token would be one
  function and one more secret, and old links would still need the stored token.
- **Ruling 10: unsubscribing takes two steps.** `GET /unsubscribe/<token>` shows a page with one button, and the button
  POSTs. Unsubscribing on GET is refused. Why: mail scanners open links. Cost if wrong: one extra tap from the email
  body. The header's one-click POST needs no tap.
- **Ruling 11: test sends are capped.** "Send test to me" sends one email to the signed-in owner, with the subject
  prefixed "Test: " and the link `/unsubscribe/test`. A test counts against the day's room and is capped at 10 a UTC
  day. Why: one count for Resend's daily quota, and a cap so a test cannot use up the day. Cost if wrong: an owner who
  tests a lot waits a day.
- **Ruling 12: the Campaign review page takes a Lighthouse slot.** `/campaigns/cp_seed01` replaces
  `/import/im_seed02/preview` in `lighthouseRoutes`, which is full at 20. Why: the campaign review page is the new
  kind of page to score. Cost if wrong: the import's check step is still axe-scanned but no longer Lighthouse-scored.

Further settled points:

- **Cron.** A second trigger, `"5,20,35,50 * * * *"`, runs only the campaign job. The hourly `"0 * * * *"` trigger is
  unchanged. Each run has its own CPU and D1 call budget, so a send does not share the brief hour's budget.
- **Switches.** `settings.campaigns` (0 or 1, default 0) turns the feature on. The Worker pieces are set per copy:
  `CAMPAIGN_SENDING` (var, `on` or unset), `CAMPAIGN_FROM` (var, an address on the sending subdomain),
  `CAMPAIGN_RESEND_API_KEY` (secret) and `CAMPAIGN_WEBHOOK_SECRET` (secret, optional; without it, delivery results
  stay "Sent").
- **Undo refusals.** `undo_change` refuses every change made by `campaign_approve`, `campaign_schedule`,
  `campaign_send`, `campaign_pause`, `campaign_resume`, `campaign_cancel`, `campaign_test`, `unsubscribe` and
  `campaign_webhook`. The board shows no Undo for them. Undoable: the draft tools (`add_campaign_draft`,
  `update_campaign_draft`, `duplicate_campaign`, `archive_campaign`), `clear_suppression` and the settings.
- **Activities.** A sent campaign email writes an `email` activity on the person, with the summary "Campaign: <name>"
  and data `{"via":"campaign","campaign":"cp_…"}`. Its actor is `system` and its tool is `campaign_send`. It has no deal
  and no untrusted text, because the body is the owner's.

## Why

Sending is the one thing that cannot be taken back, so the rules keep it with the owner: only the board sends, and
the AI can only draft. The unsubscribe and suppression rules keep the copy inside email rules that protect the owner's
main mailbox. A frozen list with one row per person is what makes "never twice" true on a retry.

## Consequences

- Follow-up series will use `campaign_steps`. The table already allows several steps per campaign. Step 1 accepts one
  step only, and `delay_days` and `stop_when` are not read yet.
- Open tracking, click tracking, images and templates in campaign emails, and RSVP tracking are not built. They are
  out of scope for step 1.
- The first real send checks how Resend behaves: batch errors, idempotency replays and the webhook's retries. Until
  then, the design is built on the Resend docs read on 2026-11-24. Those docs may change, so re-read them before
  that send.
- Worker CPU for a 2,000-person approve and a 100-email send is measured in PAID-PLAN.md "Run 8".
- The copy's live Resend account, sending subdomain and webhook are set up by the owner and cannot be checked from
  the repo.
