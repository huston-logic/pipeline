# Status

History of every earlier run: [docs/history/STATUS-history.md](history/STATUS-history.md).

## Current state

Checked on 2026-11-27 against the run 12 ledger and the repo files. `gh` was not read for this update.

- **Merged:** everything in the spec and in the runs 2, 4, 5 and 6 briefs, all of run 7 (#73, #74, #75), all of run 8 (#76, #77, #78, #79), run 9's core and board pages (#82, #83), run 10 (#87 to #91), run 11 (#92), and run 12 PRs A #93, B #94 and C #95. The repo has migrations 0001 to 0029 and decisions 0001 to 0062.
- **Open:** run 12 PR D (this PR).
- **Board, run 12 (decision 0062):** task descriptions and editing; one-tap actions in place (Done, Snooze, add, save, move, Start timer, Stop, Undo) with a status corner for the timer and the latest change; one task row everywhere; Today grouped (13 rows on a laptop, 7 on a phone with the demo seed); the project page in one column with the facts you choose; tabs Today, Deals, People, Projects, Marketing, More; Companies is Accounts and Company is Account; tables by default; the Brief is a switch, off by default.
- **Projects (runs 9 and 10):** delivery after the sale, off by default: a project from a won deal or by hand (or internal, with no client), tasks with sub-tasks, notes and time, the owner's own statuses, fields and saved views, task plans from the AI app, templates, the Projects list and project page (0055 to 0059).
- **Board approval (run 10, strict in run 11):** the owner can choose to approve AI changes on the board only, on the Pending changes page; In chat is the default (0060). Run 11 made it strict: nothing the AI app does applies at once, small changes and rule changes included (0061).
- **Managed hosting (decision 0054):** every client copy is hosted in Grant's own Cloudflare account on Workers Paid, behind one Zero Trust organisation (the owner signs in as an allowed email). Email goes from the client's own domain through Grant's one Resend account. On request a copy moves to the client's own accounts (docs/OFFBOARDING.md, **not yet rehearsed**). Docs only: no code, test or check changed.
- **Campaigns (run 8):** email campaigns, off by default: drafts by the AI app or by hand, review and approve on the board, batches every 15 minutes within a daily limit, one-click unsubscribe, delivery results by webhook (0053).
- **Built earlier:** board editing and the daily screen (0014 to 0021, 0047, 0050, 0051); pipeline and contacts (0016, 0017, 0020, 0043); people and leads (0022 to 0029, 0040 to 0043); CSV import (0034 to 0039); AI app approval, to-dos and capture (0044 to 0048); time tracking, off by default (0049 to 0051); the brief's phone notification (0030) and email logging (0031).
- **Brief and alerts:** the daily brief is off until the owner turns it on (0062), with its rules (0010, 0011); "What it caught" report (0032); `/intake` website form (0012).
- **Build process (run 7):** `npm run check:fast` (commit check, decision 0052), one shared Worker for the e2e tests, `npm run check:process`, docs/PROCESS.md for the build rules, a one-line-per-decision index in docs/decisions/README.md.
- **Sign-in, copies and protection:** Cloudflare Access for the board and `/api`, OAuth for `/mcp` (0006); the owner updates copies with `npm run copies:update` (0007); copies live in the owner's account (0054). The "Protect main" ruleset is active (details in CLAUDE.md). 0 open code-scanning alerts after PR C (from the run 12 ledger). Merging deploys nothing (decision 0007).
- **Dependencies** (exact-pinned): runtime `agents` 0.33.0, `@modelcontextprotocol/server` 2.4.0, `@cloudflare/workers-oauth-provider` 1.2.4, `postal-mime` 4.2.1, `zod` 4.6.7. Dev: `@playwright/test` 1.65.0, `@modelcontextprotocol/client` 2.4.0, `typescript-eslint` 8.72.2. Runs 5 to 12 added none.
- **Tests:** npm run check passes (2331 unit, 80 e2e); local a11y 453 passed. CI runs a11y and Lighthouse too.
- **First copy:** your copy "grant" was updated to run 6 on 2026-11-24 (you confirmed). Runs 7 to 12 (migrations 0019 to 0029) reach it when you run the update (Needs Grant 3). Its live state, and which Cloudflare account holds it, cannot be checked from the repo or `gh`.

## Needs Grant

Steps only you can do, in order. Items marked "per copy" repeat for each new client copy.

1. **Create the `full-audit` label.** Use Issues > Labels > New label, or `gh label create full-audit --description "Run the full a11y and Lighthouse audits on this PR"`. Adding it to a PR forces both audits. Adding any label re-runs a PR's CI.
2. **The site template's own docs/PROCESS.md.** Make it in the same format, as its own run in huston-logic/site-template. It is a different product, so it is not a straight port.
3. **Update your copies to run 12 (per copy).** Run `npm run copies:update -- --copy <name> --dry-run` first, then the same command without `--dry-run`. Migrations 0019 to 0029 apply. Run 12 adds no cron and no secret. After the update the Brief is OFF on every copy until you ask your AI app to turn it on ("Turn the Brief on."). Then follow docs/UPDATING.md, "Run 8", "Run 9", "Run 10: after you update" and "Run 12". A copy still on run 4 or 5 needs "Run 4" and "Run 5" first. Projects stay off until you turn them on, and approval stays In chat until you choose.
4. **Copy wording to review from run 6.** Nothing was changed without you: the tasks import lede and SPEC.md's tasks line (#64); Today's labels "Add a to-do", "Due date / Newest first / Person", "Nothing to do." (#65); the timer bar and the What did you do? page (#68); the time pages, "Billable" choices and CSV labels such as "No person" (#69); the "capture" rulebook document's text (migration 0017), which you edit by talking.
5. **Copy wording to review from run 8.** Nothing was changed without you: the campaign form hints; the review page's warning and multi-day lines; the confirm pages (Pause, Cancel, Allow campaign emails again); the results labels ("Marked as spam", "Not confirmed", "Waiting"); the unsubscribe page; and the AI app's new Campaigns instruction line.
6. **Copy wording to review from run 9.** Nothing was changed without you: "To start a project, open the person's page or a won deal."; "Start a project?"; "This deal is won. Start a project to track the work."; "Start another project"; "No projects yet."; "No projects here."; "Also move this deal's N open tasks to the project"; "The deal's title came from outside. Name the project in a few words."; "Edit project"; "See time"; "All statuses"; and the AI app's new Projects instruction line and Won question.
6a. **Copy wording to review from run 10.** Nothing was changed without you: "Start a project", "Internal", "Move open tasks to the project", "Complete all open tasks" and its hint, "This deal's open tasks"; "Complete its sub-tasks too?", "Complete them too", "Only this task"; "N of M done", "Has N more level(s) below. Your AI app can show them.", the per-row "Change" menu label; the Templates pages' hints (Under, Remove, Archive), "Start from a template" and its hint, "Starts today unless you set a start date."; "Pending changes", "Nothing is waiting for you.", the Discard hint, the Today notice, "Where AI changes are approved" with "In chat" and "On the board only"; the AI app's new instruction lines (planning, rule 3's record-text sentence, rule 7's board line) and the capture document's planning paragraph and example.
6b. **Run 10's Lighthouse approval.** Lighthouse now scores 22 pages (your approval in the brief); a full Lighthouse run takes about 10% longer in CI.
6c. **Copy wording to review from run 11.** Nothing was changed without you: the Pending page's hint under "On the board only" ("You approve here. Nothing your AI app proposes is saved until you do, small changes and changes to your rules included."); the AI app's rule 5 and rule 7 sentences about the board and the rule tools' and `update_settings`' descriptions; how a rule shows on Pending changes ("Rule: ...", "Rule ru_...: now ... -> ...", "paused: ...", "resumed: ...", "described as ..."). Your call: the other AI writes that still apply at once under the board setting (stages, fields, statuses, views, the rulebook, work types, rates, campaign drafts) are configuration; gate them too?
6d. **Copy wording to review from run 12.** Nothing was changed without you. Quoted lines:
   - Tasks: "Title", "Description", "Add task", "Add sub-task", "Give the task a title.", "The task wasn't saved", "Done: <task name>", "Snoozed until <time>", "Snoozed to <day>", "Done <day>", "<n> open sub-task(s)", "Open the deal", "Open the person", "Open the project"; "Add a task above, or add one on a deal or person page."
   - Corner and timer: "Stop", "Undo", "Time logged: <from> to <to>", "Edit or add notes", "Close", "Discard timer", "Keep it", "Discard the timer?", "It has run N min. Nothing will be logged.", "The timer wasn't stopped", "The timer wasn't discarded", "No timer is running."; "Done", "Snoozed", "Added", "Saved", "Moved", "Timer started", "Time logged", "Timer discarded", "Undone" (and "Undone: <name>" or "Undone."); "Confirm: discard the timer"; "Discarding the timer logs nothing. Confirm, or keep the timer running."; "Couldn't save. Check your connection and try again."; "Couldn't load. Check your connection and try again."; the AI app's "Discard the timer" tool title and "Discard the running timer (<who>, started 8:30 AM)".
   - Today: "Overdue", "Today", "Upcoming", "No due date", "Sort and filter", "Sort", "Show", "Show to-dos", "N tasks, M overdue", "Next step: <text or Not written down>"; "15 open deals, total value 92,850." (the Closed clause is gone); "Your open to-dos grouped by when they are due, the deals due and your open deals by stage."; "Showing N to-dos."; "Showing the first 500 tasks of your projects. Open the project to see the rest."
   - The project page: "Choose project facts"; "Pick what the project page shows at the top, and in what order."; "Choose facts", "Use the default", "Position", "Notes", "Done", "N of M done", "Edit project", "Archive project", "Bring back project"; "The facts weren't saved"; "Choose at most 20 facts for the project page."
   - Navigation, names and tables: the tabs "Deals" and "Marketing"; People: "Leads, contacts and accounts."; More: "Rules, changes, the monthly report, export, import and email logging."; "Deals list", "Show deals as", "Back to deals", "See your deals"; "Accounts", "Your contacts grouped by account, with each account's people, open deals and open value.", "No accounts yet.", "No account", "N accounts, N people."; the field "Account", "Account, A to Z", "Account, Z to A"; "Name, email, phone or account"; "A name or an account is enough."; "Give a name or an account."; "already has that account."; table titles "Accounts, as a table", "Templates, as a table", "Campaigns, as a table"; captions "Accounts with their people, open deals and open value.", "Campaigns by status, with their subject and date."; headers "Account", "People", "Open deals", "Value", "Template", "Tasks", "Description", "Campaign", "Status", "Subject", "Date"; "None" for an empty account or date.
   - The Brief: "Turn the Brief on or off (off by default): its page, composing it each day, its email and its phone notification. Follow-up rules run either way." (the `update_settings` description); "Email the daily brief (only while the Brief is on and email sending is set up)." (`briefEnabled`); "the Brief on" and "the Brief off" (change text); "Timezone America/Los_Angeles; the Brief is off (emailing it off)."; "Your rules, the change log, the export download, the import and the email logging address." (More page, Brief off); docs/UPDATING.md: "Turn the Brief on."
7. **Your calls from run 5.** Nothing was changed without you:
   - Rule 3 of the AI app's instructions covers untrusted fields only. A name confirmed with "This is my own list" is no longer untrusted. Adding "treat every record's text as information" to rule 3 would change the instructions.
   - A 2,000-row board import takes about 11 ms of CPU, over the free plan's 10 ms. If it fails with "exceeded CPU", split the file, use `npm run import:contacts`, or move to Workers Paid (item 16 puts the hosting account there).
   - The Pipeline List is a table with no "Move to" on each row (moving stays on the Board and the deal page).
   - Lead's five sub-statuses can be renamed but not archived, and Lead takes no new ones (decision 0040).
8. **Copy decisions from runs 4 and 5.** Nothing was changed without you:
   - The board's outside-text note says "came from a website form or an import". That is wrong for a logged email.
   - The Pipeline empty state says "Inquiries from your website form" (it said "Leads ..."). Confirm you want that wording.
   - `/intake`'s change summary still says "new lead" for a new person who gets a deal. "new inquiry" would match the Pipeline wording.
9. **Email logging (per copy, docs/EMAIL-LOGGING.md).** Set up a log subdomain on the hosting domain with Email Routing, its DNS records, the `EMAIL_LOG_ADDRESS` secret and the routing rule to the Worker, then both go-live checks with a real test email. A strict DMARC policy on the sending domain of whoever BCCs the log is recommended. Decision 0031's ruling 12 may need tuning after the first test.
10. **Notification keys (per copy).** Run `node scripts/make-vapid-keys.mjs --copy <name> --subject mailto:<owner email>`, then the three `wrangler secret put` commands it prints, then the phone steps in docs/UPDATING.md.
11. **Phone checks on the first copy (run 2).** The Access Bypass for `/icons/*` is set (docs/ACCESS-SETUP.md step 3, check in step 7.5); Add to Home Screen shows the green icon; "Ask Claude" opens claude.ai with the prompt filled in (decision 0021).
12. **Cloudflare dashboard checks on the first copy.** (a) CPU items over 10 ms on the free plan (docs/PAID-PLAN.md, "Run 4 closing re-measure"): Today 13.8 ms, the hour of the brief 11.5, `preview_rule` on a deal rule 11.0, `list_deals` 10.3, the export 102 ms; measured on a fake copy of 2,000 deals plus 2,000 leads on a busy Mac; moot once the account is on Workers Paid (item 16). (b) D1 statements per invocation: the hourly run on the brief's hour makes 37 D1 calls holding 112 statements; if the free plan counts statements, lower `MAX_FIRINGS_PER_RUN` to about 8 or use Workers Paid.
13. **Only when you want them, per copy.**
    - Brief emails (Resend): follow docs/INSTALL.md, "Sending email from the client's domain", run `npx wrangler secret put RESEND_API_KEY -c .copies/<copy>/wrangler.jsonc`, set `BRIEF_SENDING = "on"` and `BRIEF_FROM` in that copy's generated config, then ask the AI app to `update_settings` with the brief address and brief on (the Brief itself must be on too). Details: docs/SECRETS.md.
    - Website form: generate a long random value (for example `openssl rand -hex 32`), run `npx wrangler secret put INTAKE_SECRET -c .copies/<copy>/wrangler.jsonc`, and put the same value in the website's server-side form handler as the `X-Intake-Secret` header. Until it is set, `/intake` answers 503.
    - A new copy: it goes in your own account (item 16). Run `npx wrangler login` yourself, follow docs/INSTALL.md and docs/ACCESS-SETUP.md. Count the owner emails against Zero Trust Free's 50 users first.
14. **Campaigns, only when a client wants them (per copy, docs/CAMPAIGNS.md).** In order:
    - (a) The client's sending subdomain in your Resend account (docs/INSTALL.md), an API key with "Sending access" for that subdomain only, and `npx wrangler secret put CAMPAIGN_RESEND_API_KEY -c .copies/<copy>/wrangler.jsonc` (steps 1 to 3). (b) The client adds the subdomain's DNS records from Resend (DNS only, grey cloud, if on Cloudflare) and a DMARC record (step 2).
    - (c) The Access Bypass for `unsubscribe` and `hooks/resend` (docs/ACCESS-SETUP.md step 3), then the private-window check of `/unsubscribe/test` (step 6). (d) The webhook endpoint `https://<copy host>/hooks/resend` and its secret: `npx wrangler secret put CAMPAIGN_WEBHOOK_SECRET -c .copies/<copy>/wrangler.jsonc` straight after saving the endpoint (step 7).
    - (e) Turning sending on: `CAMPAIGN_SENDING = "on"` and `CAMPAIGN_FROM` in the copy's generated config, then `npm run copies:update -- --copy <copy>`; the postal address on Campaign settings; then the go-live check (step 8).
15. **Leftover temp folder** from a manual test (harmless, nothing secret). Remove it with `rm -r /var/folders/xf/zt8g4lzn0211myfvc6kzmt0r0000gn/T/pipeline-e2e-p134is`. Checked on 2026-11-21. Two older `pipeline-e2e-*` folders from 2026-11-18 and 2026-11-23 are in the same temp folder; they can go too.
16. **Before the first client copy: your Cloudflare and Resend accounts (decision 0054).**
    - (a) Check which Cloudflare account holds your copy "grant" (this repo cannot tell). Every client copy goes in one hosting account, on Workers Paid ($5 a month): Free allows 5 Cron Triggers and 10 D1 databases, and each copy uses 2 of each. Zero Trust: choose the team name once, on the Free plan; Free allows 50 users in total, owners included (checked 2026-11-24).
    - (b) Keep a hosting domain on Cloudflare in that account; a client's own domain cannot hold the Worker or its Access application (docs/INSTALL.md, step 1). Resend: one account on Pro ($20 a month), 10 sending domains, one per client subdomain. Put both logins on passkeys or two-step sign-in.
    - (c) Rehearse docs/OFFBOARDING.md once, on a fake copy and a second Cloudflare account; decide on a full-restore command (its step 6 "Gap") and how long an old copy stays up for unsubscribe links.
    - (d) Resend webhooks: check whether an endpoint can be limited to one sending domain (decision 0054); decide before the first client campaign. Read the managed hosting wording in docs/INSTALL.md, ACCESS-SETUP.md and OFFBOARDING.md; the fee and the client terms live in the master, not here.

## For the master

- The app's build rules now live in docs/PROCESS.md; the master links to it and does not repeat them.
- Email campaigns (newsletters and event invites) are built, off by default; sending needs a sending subdomain on the client's own domain in Grant's Resend account.
- Projects (delivery after the sale) are built, off by default.
- Projects can now be shaped by the owner: their own statuses, custom fields and saved views; internal projects with no client.
- Project tasks can have sub-tasks, and the AI app can draft a whole task plan for the owner to approve in one go.
- Project templates: reusable task lists for repeat jobs, picked when a project starts.
- AI changes can be approved on the board instead of in chat (a setting); on the board only, nothing the AI app does applies at once, rule changes included.
- The board was reworked for daily speed: denser lists, one-tap actions with no page reload, and a one-tap timer.
- The daily brief is now optional and off by default; it turns on when the owner asks for it.
- Pipeline is now Deals, Companies is now Accounts, and the tabs were regrouped (Today, Deals, People, Projects, Marketing, More).
- Follow-up series, open/click tracking, images and RSVP tracking are not built yet.
- Pipeline docs describe managed hosting and offboarding.

## Last run: run 12, App layout and ease of use

Plan: `docs/superpowers/plans/2026-11-26-run12-layout-ease.md`. Decision 0062, migrations 0026 to 0029, no new dependency. The brief was complete. Run 11 is in the history file.

| PR | What | Work window | Commits | Checks | CI |
|---|---|---|---|---|---|
| A #93 | task titles, descriptions and editing (migration 0026) | 13:55 to 14:31 (opened), merged 14:45 | 7 | check:fast per commit; full check before push; local a11y 432 passed | 13 min (opened 14:32, merged 14:45); all 6 green first time |
| B #94 | actions in place, the status corner, the timer | 14:32 to 15:38 (opened), merged 15:52 | 6 | check:fast per commit; full check before push; local a11y 442; security reviewer twice | 13.5 min (opened 15:39, merged 15:52); green first time |
| C #95 | one task row, Today and the project page (migration 0027) | 15:39 to 17:30 (opened); fixes 23:19 and 00:05 | 10 | as above; local a11y 451 | 6 h 44 min from open to merge (a usage pause from about 18:30 to 22:40 PST): Lighthouse failed (Today 0.89 on mobile), then a CodeQL high alert on the fix, then a midnight-flaky test; each fixed, then green |
| D (this PR) | navigation, names, tables, the Brief switch (migration 0028), the audit index (0029), docs | 17:31 to open | 6, plus the final fix wave | as above; local a11y 453 | auto-merge queued at open; CI result not known when this was written |

Judgment calls (one line each):
- In place: the script posts the real form and swaps marked regions of the page the server would show. (cost: medium, a fragment API would touch every page)
- The old change banner moved into the status corner. (cost: small)
- The "Time logged" note lasts 2 minutes across pages unless closed; Close is a cookie, not a row. (cost: small)
- Task edits are board only; no `update_task` MCP tool. (cost: small, a tool over `updateTask` plus proposal text)
- The three-level cap counts from the top; deeper existing rows stay and show. (cost: small)
- A due at local midnight is a date with no time, so a task really due at midnight shows as a day. (cost: small, a flag column)
- Timer Undo archives the running entry (`cancel_timer`) and asks first after 5 minutes. (cost: small)
- Project facts are a settings column of view column keys. (cost: medium, moving them to views later needs a migration)
- Project rows on Today count top-level tasks that are open or have open sub-tasks; overdue counts any depth. (cost: small)
- Marketing is under More on phones. (cost: small, CSS and the More page)
- The brief is a module switch (`settings.brief`), apart from `brief_enabled`, which still means "email it". (cost: small)
- Two pages added to the a11y list; Lighthouse stays at 22 routes. (cost: small)
- `save_project_as_template` copies levels 1 to 3 and leaves deeper tasks out, instead of refusing. (cost: the owner may expect a refusal)
- Work happens in the main checkout on feature branches, not in a worktree. (cost: none noted)
- Project task rows reuse the task edit form function unchanged. (cost: none noted)
- The close cookie is `pipeline_corner`, exported as `CORNER_COOKIE`. (cost: none noted)
- The browser test that writes to the preview data restores it by Undo at the end. (cost: none noted)
- Task C follows the B4 interface for in-place regions and forms. (cost: none noted)
- The B4 hooks (`data-autosubmit`, `data-close-narrow`, the task-row hooks) stayed in the code until the markup landed in C. (cost: dead code until C landed)
- Autosubmit is an in-place GET swap with `replaceState`, not a page load. (cost: one extra code path in `live.js`)
- Tab order in a task row: Done, the row, the open content, then the sub-tasks. (cost: open rows put actions before the sub-task toggle)
- Add a deal, Add a lead and Import sit on a quiet line at the foot of Today. (cost: one more scroll to add a deal from Today)
- At most 200 task rows on Today in all, dated first. (cost: very busy owners see fewer undated rows)
- A project's count on Today counts only open, awake tasks. (cost: none known)
- "Overdue" stays on every overdue row; on a phone the due date and "belongs to" share line 2. (cost: "belongs to" is cut on phone rows)
- A project's status is the head tag only, not a pair in the facts. (cost: the owner can hide the tag only through the facts chooser)
- "Notes" appears twice on the project page. (cost: two things named Notes)
- More is marked current on `/campaigns` at every width; the wide CSS hides its look. (cost: wide-screen readers hear More as current too)
- `renderPage` takes `region: true` on read-only list and board pages only, never on form pages. (cost: other pages need a reload to show a corner Undo's effect)
- The corner's Undo works in place only for task and timer changes. (cost: other Undos reload the page)
- Row actions sit in a `<noscript>` for scripts off and come from `/tasks/<id>/actions` with scripts on (Lighthouse and CodeQL). (cost: one small request per row open)
- The timer clock moved to `public/clock.js`, with the note's expiry and the corner's scroll room. (cost: one more script on every signed-in page)
- Migration 0029 adds an `audit_log (tool, time)` index. (cost: one more migration)
- The Brief and emailing the brief are named apart in change text. (cost: none noted)
- At most two pages added to the a11y list; `/pending`'s region and both `layout=cards` entries removed. (cost: less axe coverage of card fallbacks)

Queued:
- Linkify strips only one trailing punctuation mark; URLs with balanced brackets are not handled.
- More is marked current on wide screens too on `/campaigns` (the CSS hides only the look).
- Search text typed on `/contacts` or `/leads` can be lost when a corner action swaps the page.
- `live.js` is at 3,017 of 3,072 bytes gzipped; the next addition moves code to `clock.js`.
- `live.js` accepts a redirected page for row actions; the Notifications page has extra live regions (push-note and push-status).
- The Lighthouse page list is unchanged at 22 routes; the new a11y pages are not scored by Lighthouse.

## Changelog

- 2026-11-25, run 11, "Board approval, strict": small changes and rule changes wait on the board (#92).
- 2026-11-26 to 27, run 12, "App layout and ease of use": tasks with descriptions and editing (#93); actions in place, the status corner and the timer (#94); one task row, Today and the project page (#95); navigation, names, tables and the Brief switch, closing docs (this PR).

Runs 1 to 10: docs/history/STATUS-history.md.
