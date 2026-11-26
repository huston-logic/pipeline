# Status

Business priorities live in the Google Doc "00 Huston Logic: Source of Truth"; the master links to this file. This
file is the repo's status: update it in place at the end of every run (CLAUDE.md, "Status and source of truth").
Spec: `docs/SPEC.md`. Plan: `docs/PLAN.md`. Decisions: `docs/decisions/`. Dates are in the owner's timezone
(America/Los_Angeles), taken from the PR merge times in `gh`.

Last checked on 2026-11-24 from the run 6 ledger and `gh` (PR states and merge times). The local `main` was not pulled,
so no `main` commit is named here.

## Managed hosting (docs run, 2026-11-24)

"Managed hosting", the pipeline half of the 09 doc's item H1 (2026-11-24). Plan: `docs/superpowers/plans/2026-11-24-managed-hosting.md`. Decision 0054. One PR, docs only.

Changed: decision 0054 and its index line (0007 marked partly replaced); INSTALL.md (steps 1 to 3, a "Sending email from the client's domain" section), UPDATING.md, ACCESS-SETUP.md (one Zero Trust organisation, the 50-user limit and its source), SECRETS.md, SPEC.md, README.md, and the same account wording in CAMPAIGNS.md, EMAIL-LOGGING.md and PAID-PLAN.md; new docs/OFFBOARDING.md (not yet rehearsed); a "Hosting" rule in PROCESS.md. No code, test, threshold or required check changed.

| PR | Wall-clock | Commits | Time in checks | Waiting on CI |
|---|---|---|---|---|
| Managed hosting (this PR) | about 12 min from the first commit (21:25) to PR open; reading and the limit lookups came before. One review fix commit after. | 4 | check:fast on each commit (docs only, seconds); one full `npm run check` 27 s | see the PR |

Judgment calls (one line each):

- The client price stays out of the repo (PROCESS.md "Where facts live"); decision 0054 says the fee lives in the master. Grant's costs (Workers Paid $5, Resend Pro $20) are vendor list prices and are in.
- The client's own domain can't host the copy: a Worker's custom domain and its Access application must be in the Worker's account. So a copy answers on a hosting domain, the email-log subdomain moves there too, and the client's domain is used for email sending only.
- The developers "account limits" page states no Zero Trust user cap; the 50-user figure is from Cloudflare's plans page, and the docs say so.
- The offboarding runbook names two gaps instead of papering over them: no whole-copy restore (only people, deals and tasks import) and the unsubscribe links already sent point at the old host.
- Handover date and terms go in the master's client record, never this public repo.
- A fresh review of the diff found six real doc gaps (who receives the sign-in code, Access application names colliding across copies, the webhook, the suppression list, the sending switches, "owner" meaning two people); all are fixed here.

Queued: nothing beyond Needs Grant 16. The two stale prompts in `scripts/copies.mjs` ("Ask the client to invite your Cloudflare user", "Which account is the client's?") were fixed in a small follow-up PR, with their test.

## Current state

**Merged.** Everything in the spec and in the run 2, 4, 5 and 6 briefs is built. #1 to #69 are merged. Open on
2026-11-24: #70 (the final-review fixes) and #71 (this PR). Both have auto-merge queued (GitHub merges the PR by itself
once the required checks pass). Run 6, "Daily work", added: approve before change (the AI app shows a list and waits for
"Yes"; `propose_changes` and `apply_changes`, with a setting to let small changes go straight in), to-dos that belong to
no one, a Today page that works like a list, capture of a ramble as one list (with `list_tasks`), and optional time
tracking (timer, entries, work types, client rates, Time pages and a month CSV). The repo has migrations 0001 to 0018 and
decisions 0001 to 0051. 0 open code-scanning alerts on 2026-11-24 (checked with `gh`; CodeQL is GitHub's code security
scan).

**Protection.** The "Protect main" ruleset is active (details in CLAUDE.md).

**Live.** Merging deploys nothing (decision 0007). The first client copy was installed by the owner on 2026-11-19, which
PR #29 ("install lessons from the first live copy") corroborates, and its config folder is on this Mac in the
git-ignored `.copies/`. What that copy runs now can't be checked from the repo or `gh`: whether it has been updated to
run 4's code (migrations 0006 to 0008) is open until you confirm it. Run 5's code (migrations 0009 to 0013) reaches
it only when you run the update (Needs Grant 1); the same goes for run 6's code (migrations 0014 to 0018).

**Open.** What is left from earlier runs and from run 6 is in "Needs Grant" and in the minor findings below.

**Dependencies** (exact-pinned in `package.json`): runtime `agents` 0.33.0, `@modelcontextprotocol/server` 2.4.0,
`@cloudflare/workers-oauth-provider` 1.2.4, `postal-mime` 4.2.1, `zod` 4.6.7. Development: `@playwright/test` 1.65.0,
`@modelcontextprotocol/client` 2.4.0, `typescript-eslint` 8.72.2. Added in run 4: `postal-mime` (PR #37). Runs 5 and 6
added none.

**Tests.** `npm run check` on the run 6 branches passes: 1,512 unit and 56 end-to-end tests, 0 failures. Local a11y does
not run on this Mac (Needs Grant 8) and local Lighthouse is no longer run (CLAUDE.md, #56); CI runs both. CI's
`lighthouse` job scores 20 pages, 3 runs each (about 12 minutes), and collects again only the pages whose runs crashed
(#59). The `a11y` job runs about 284 tests and takes about 6 minutes, inside the 12-minute `globalTimeout` (#69, confirmed by you on 2026-11-24).

## Changelog

- 2026-11-18, run 1: spec, plan and the twelve milestones M1 to M12, then the whole-run review fixes. #1 to #14.
- 2026-11-18 to 2026-11-19, run 2: the board becomes the daily screen: spec change, look and navigation, contacts and
  companies, pipeline kanban and write path, home-screen app, CPU check, minor findings, decision wording, run 2
  closing status. #15 to #21, #23 and #25.
- 2026-11-19, run 3: edit from the board and phone actions (stacked, merged after the CI timeout fix), engine reviewers
  and CI timeout (owner-copied), run 3 status. #22, #24, #26, #27.
- 2026-11-20, run 4: people and leads (design, install lessons, migration, `add_lead` and `add_deal`, qualify and return,
  reads, lead rule, People tab, lead pages, import and seed, acceptance), then "it comes to you" (phone
  notification, email logging, What it caught), closing status, final-review fixes. #28 to #43.
- 2026-11-21, status format: STATUS.md reshaped into Current state, Changelog, Needs Grant and For the master, facts
  re-checked against the repo and `gh`; "Status and source of truth" added to CLAUDE.md. #44.
- 2026-11-21, minor findings: seven of the run 4 minor findings fixed with tests first; the rest sorted into "wording"
  and "your call" in the section below. #45.
- 2026-11-22 to 2026-11-23, run 5, "Import and people": the plan (#46); Part 1, import: one engine (#47), one change
  at any size (#48), board import for people (#49), deals and tasks (#50), "This is my own list" (#51), import over MCP
  (#52); Part 2, people: Person status (#53), its tools, Add contact and the form fields (#54), saved views (#55), table
  layout (#57); CLAUDE.md drops local Lighthouse (#56); closing docs and status (#58).
- 2026-11-23, CI: the `lighthouse` job scores at most 20 pages, 3 runs each, and retries pages whose runs crashed with
  Chrome's `NO_NAVSTART` (#59); a CodeQL alert in a table test helper fixed in #57; status brought up to date (#60).
- 2026-11-23 to 2026-11-24, run 6, "Daily work": the plan (#61); approve before change (#62); the "AI edits" setting (#63);
  standalone to-dos (#64); Today as a list (#65); capture and `list_tasks` (#66); time and rates, data and MCP (#67);
  the timer on the board (#68); the time pages and CSV (#69); the final-review fixes (#70: D1 calls, Today's database
  sort, the list showing every column it writes); closing docs and status (#71, this PR).

## Needs Grant

Steps only you can do, in order. Items marked "per copy" repeat for each new client copy.

1. **Update the first copy to run 6** (per copy). `npm run copies:update -- --copy <name> --dry-run` first, then
   without `--dry-run` (migrations 0014 to 0018 apply; 0009 to 0013 too if the copy is still on run 4), then
   docs/UPDATING.md: "Run 4: after you update" and "Run 5: after you update" if that copy never had them, then "Run 6:
   after you update" (reconnect the connector, the AI app now waits for your yes, "Apply small changes", turning time
   tracking on, the sentences to try). Not checkable from here which run the copy is on.
2. **Does a D1 batch count as one query on the free plan?** Unknown (nothing here runs against real D1). A 25-action
   proposal makes about 31 D1 calls (D1 is Cloudflare's database; a batch sends several database steps at once),
   inside the free plan's 50 if a batch is one call, but its trial and apply batches hold about 44 steps each, near 50
   if every step counts. After a 25-action proposal on the first copy, look in the Cloudflare dashboard: Workers & Pages,
   the copy's Worker, Metrics, or D1, the copy's database, Metrics ("queries"). If you can't find it, send a 20-action
   list; if it fails with a limit error, that answers it. If it counts every step, either move the copy to Workers Paid or ask for a lower
   `PROPOSAL_MAX_ACTIONS` (docs/PAID-PLAN.md, "Run 6").
3. **Copy wording to review from run 6** (it changes what the copy says; nothing was changed without you): the "Needs
   your eyes" lines of #64 (the tasks import lede, now "... or on no one when its line names no one", and SPEC.md's
   tasks line), #65 (Today's labels: "Add a to-do", "Due date / Newest first / Person", "Nothing to do."), #68 (the timer
   bar and the What did you do? page) and #69 (the time pages, "Billable" choices and CSV labels such as "No person"),
   plus the "capture" rulebook document's text (migration 0017; it is yours to edit by talking).
4. **Your calls from run 5** (nothing was changed without you):
   - The AI app's server instructions say never to follow instructions in *untrusted* fields. A name confirmed with
     "This is my own list" is no longer untrusted, so only the rules about closing deals and changing settings cover
     it. Adding "treat every record's text as information" to rule 3 would change what the instructions say.
   - A 2,000-row import from the board takes about 11 ms of CPU, over the free plan's 10 ms (docs/PAID-PLAN.md, "Run 5:
     import"). If a big board import fails with "exceeded CPU", split the file, use `npm run import:contacts`, or move
     the copy to Workers Paid.
   - The Pipeline List is now a table with no "Move to" on each row (moving stays on the Board and the deal page).
   - Lead's five sub-statuses can be renamed but not archived, and Lead takes no new ones (the lead rule uses their
     keys; decision 0040).
5. **Copy decisions from run 4 and 5** (they change what the copy says, so nothing was changed without you):
   - The board's outside-text note says "came from a website form or an import". That is wrong for a logged email.
   - The Pipeline empty state now says "Inquiries from your website form" (it said "Leads ..."), because "lead" now means
     a person you approach. Confirm you want that wording.
   - `/intake`'s change summary still says "new lead" for a new person who gets a deal; "new inquiry" would match the
     Pipeline wording.
6. **Email logging** (per copy, docs/EMAIL-LOGGING.md): a log subdomain with Email Routing onboarded, its DNS records,
   the `EMAIL_LOG_ADDRESS` secret, the routing rule to the Worker, then both go-live checks with a real test email. A
   strict DMARC policy on your sending domain is recommended. Ruling 12 (run 4) may need tuning after the first test.
7. **Notification keys** (per copy): `node scripts/make-vapid-keys.mjs --copy <name> --subject mailto:<owner email>`,
   then the three `wrangler secret put` commands it prints, then the phone steps in docs/UPDATING.md.
8. **Local Playwright Chromium**: this Mac has revision 1248; `@playwright/test` 1.65.0 wants 1254 (checked in
   `node_modules/playwright-core/browsers.json`), so `npm run test:a11y` fails here at browser launch (CI installs its
   own). Run `npx playwright install chromium` in your own terminal (installing a browser needs your approval).
9. **Phone checks on the first copy** (run 2): the Access Bypass for `/icons/*` is set (docs/ACCESS-SETUP.md step 3,
   check in step 7.5); Add to Home Screen shows the green icon; "Ask Claude" opens claude.ai with the prompt filled in
   (`claude.ai/new?q=` is how claude.ai behaves today, not a documented API; decision 0021).
10. **Cloudflare dashboard checks on the first copy:**
   - CPU items over 10 ms on the free plan (docs/PAID-PLAN.md, "Run 4 closing re-measure"): Today 13.8 ms, the hour of
     the brief 11.5, `preview_rule` on a deal rule 11.0, `list_deals` 10.3, the export 102 ms. All measured on a fake
     copy of 2,000 deals plus 2,000 leads on a busy Mac. `/companies` (7.7 ms) and `/leads` (2.1 ms) are fine.
   - D1 statements per invocation: the hourly run on the brief's hour makes 37 D1 calls holding 112 statements. If the
     free plan counts statements, lower `MAX_FIRINGS_PER_RUN` to about 8 or use Workers Paid.
11. **Only when you want them, per copy:**
   - Brief emails (Resend): verify the sending domain, create an API key with "Sending access" for that domain only,
     `npx wrangler secret put RESEND_API_KEY -c .copies/<copy>/wrangler.jsonc`, set `BRIEF_SENDING = "on"` and
     `BRIEF_FROM = "Pipeline <brief@<your domain>>"` in that copy's generated config, then ask the AI to
     `update_settings` with the brief address (it must be an owner email) and brief on. Details: docs/SECRETS.md.
   - Website form: generate a long random value (for example `openssl rand -hex 32`), then
     `npx wrangler secret put INTAKE_SECRET -c .copies/<copy>/wrangler.jsonc`, and put the same value in the website's
     server-side form handler as the `X-Intake-Secret` header. Until it is set `/intake` answers 503.
   - A new copy: ask the client to invite your Cloudflare user (Manage Account > Members > Invite, Administrator), run
     `npx wrangler login` yourself, follow docs/INSTALL.md and docs/ACCESS-SETUP.md. Zero Trust Free covers up to 50
     users.
12. **Leftover temp folder** from a manual test (harmless, nothing secret; the hook stops Claude deleting outside the
   repo; checked on 2026-11-21): `rm -r /var/folders/xf/zt8g4lzn0211myfvc6kzmt0r0000gn/T/pipeline-e2e-p134is`

Done since the last file (checked on 2026-11-21): the CI workflow no longer runs `check:placeholders` (nothing in
`.github` mentions it); the CI lighthouse timeout and the owner-only reviewer proposals landed in #26; the first copy
was installed.

## For the master

Changes to scope, product or a decision since run 3, one line each:

- Product: "lead" now means a person you approach (a contact with a lead status and no open deal); real inquiries are
  deals (decisions 0022 to 0029, 0033).
- Product: email logging by BCC to a log address, owner mail only, authenticated by Cloudflare's headers (0031).
- Product: a phone notification when the daily brief is ready, fixed payload, no record text (0030).
- Product: a monthly "What it caught" report on the board and in the brief (0032).
- Cost: five reads exceed the free plan's 10 ms CPU on a 2,000-deal-plus-2,000-lead copy; Workers Paid may be needed on
  a big copy (docs/PAID-PLAN.md).
- Process: STATUS.md is now the one status file, in four sections; the rule is in CLAUDE.md.
- Product (run 5): owners import a CSV of people, deals or tasks from the board, on a phone or a laptop, with no
  terminal; up to 2,000 rows and 1 MB as one change with one undo (0034 to 0037).
- Product (run 5): the owner's AI app can import a shared sheet (`import_rows`, then `apply_import` after the owner's
  yes); "This is my own list" lets the owner confirm short identity values on the board only (0038, 0039).
- Product (run 5): every person has a Person status (Lead, Contact, Partner, and kinds the owner adds by talking) with
  sub-statuses; the sort is now three-way: lead, deal, or contact with the right status (0040, 0041; supersedes parts
  of 0022).
- Product (run 5): saved views and a table layout for every list; the Pipeline List is a table (0042, 0043).
- Cost (run 5): a 2,000-row board import is about 11 ms of CPU, over the free plan's 10 ms (docs/PAID-PLAN.md).
- Process (run 5): no local Lighthouse runs; CI's required job is the check (CLAUDE.md, #56). That job now scores at
  most 20 pages, 3 runs each, and retries crashed runs, so it takes about 12 minutes and stops growing (#59).
- Product (run 6): the AI app shows a list of what it would change and waits for your "Yes", "Yes with changes: ..." or
  "No" before it edits records; a yes is one change with one undo (0044).
- Product (run 6): an "AI edits" setting: Review first (the default) or Apply small changes (a logged call or note, a
  ticked task, starting or stopping a timer go straight in) (0045).
- Product (run 6): to-dos can belong to no person or deal, and Today is a list you can sort, filter and add to, up to 50
  shown per list (0046, 0047).
- Product (run 6): capture: talk a ramble into the AI app and get one list of to-dos, notes and stage moves; a read
  tool, `list_tasks`, shows every to-do including undated ones (0048).
- Product (run 6): time tracking, off by default: a timer, time entries, work types, a rate per client (a person), a
  Time page and a month CSV (0049 to 0051).
- Cost (run 6): the free plan's 50 D1 calls per request: a 25-action list is about 31 calls after the fix; whether a
  batch counts as one call is unknown. Today fell from 16 ms to 7 ms of CPU on a 3,140-task copy (docs/PAID-PLAN.md,
  "Run 6").

---

# History (kept from earlier runs; facts re-checked on 2026-11-23)

## Run 10, Projects, finished (2026-11-25)

Plan: `docs/superpowers/plans/2026-11-25-run10-projects-finished.md`. Design: `docs/superpowers/specs/2026-11-25-projects-finished-design.md`. Decisions 0056 to 0060, migrations 0021 to 0025. The brief was complete. No new dependencies. Run 9 is in the history file.

| PR | What | Work window | Commits | Checks | CI |
|---|---|---|---|---|---|
| A #87 | projects shaped by the owner | 09:37 to 10:33 (56 min, with design and plan) | 12 | check:fast per commit (3 to 11 s); full check about 30 s before push | merged about 50 min after opening (6 of 6) |
| B #88 | sub-tasks | 10:33 to 10:54 (21 min) | 7 | same | merged (6 of 6) |
| C #89 | AI task plans | 10:54 to about 11:15 | 3 | same | merged (6 of 6) |
| D #90 | project templates | about 11:15 to 11:39 | 8 | same | merged (6 of 6) |
| E (this PR) | approve on the board, closing | 11:39 to open (see the PR) | see the PR | same | see the PR |

Each PR after A was built on the previous tip while CI ran, then rebased onto main (no force push).

Judgment calls (one line each):

- The AI app may tighten "Where AI changes are approved" to the board but never loosen it (ruling 15).
- Board-only approval leaves "Apply small changes" as it is (16).
- Under the board setting the AI's `undo_change` refuses for every change, with a link to /changes.
- The AI may not loosen `aiEdits` to apply_small while the setting is the board.
- `apply_import` over MCP refuses with the board import link.
- The setting is read through the request memo; a test keeps a maximum-size propose and apply at 40 D1 calls or fewer.
- The board approves as the owner (tool `apply_changes`); Discard drops a proposal and is not audited.
- A template copy keeps no link back (0059 ruling 17). The CLAUDE.md sentence about clients inviting your wrangler user was fixed.

Queued:

- A crafted board POST can move a done top-level project task; past the 500-task read a move may swap with an unshown one.
- A sub-task added between the read and the write of a parent's completion stays open.
- The get_project answer carries the task tree beside the flat open and done lists (about twice the size).
- The left-out count for a saved template rides in a display-only field as text.

## Run 9, Projects (2026-11-25)

Plan: `docs/superpowers/plans/2026-11-25-run9-projects.md`. Design: `docs/superpowers/specs/2026-11-25-projects-design.md`. Decision 0055, migration 0020.

Run 9 added projects, delivery work after a sale: a project comes from a won deal or is started by hand, holds tasks, notes and time, and shows on a Projects list and project page, all off until the owner turns it on.

| PR | Wall-clock | Commits | Time in checks | Waiting on CI |
|---|---|---|---|---|
| A #82 core: data, services, AI app | 22:18 to 22:59 (41 min) to open | 12 | check:fast on each commit (3 to 7 s); one full `npm run check` about 30 s | 13 min (merged 23:12) |
| B #83 board pages | 23:00 to 23:26 (26 min) to open | 7 | check:fast on each commit; one full check about 30 s | 11 min (merged 23:37) |
| C #84 closing: exports, acceptance, final-review fixes, docs | 23:26 to open | 4 | check:fast on each commit; one full check | merged 23:46 |

Judgment calls: the brief's cut-off last line read as "can later grow without reshaping its data" (ruling 1); the person is required and a deal is optional and must be Won (2); three fixed statuses, renamed only (3); a project's tasks leave the deal (4); the offer lives on the won deal's page (5); the move-tasks box is unticked by default (6); notes on a project are activities (7); no board settings switch (8); no Lighthouse slot (9); nothing shows while projects are off (10); no project views, import or custom fields (11); `update_time_entry` never moves an entry off its project implicitly; the demo seed moved from PR C to PR B.

Queued then (all fixed in run 10): the archived filter in memory, the done-task read, project notes unlabelled on the person page.

## Run 8 (2026-11-24 to 25)

Run 8, "Campaigns, step 1". Plan: `docs/superpowers/plans/2026-11-24-run8-campaigns.md`. Design:
`docs/superpowers/specs/2026-11-24-campaigns-design.md`. Decision 0053. PRs: A (#76, core, data and the AI door,
migration 0019), B (#77, the board pages), C (#78, sending, unsubscribe and delivery results), D (#79, closing docs and
acceptance sentences 31 to 34).

| PR | Wall-clock | Commits | Time in checks | Waiting on CI |
|---|---|---|---|---|
| A (#76) | about 38 min to open, merged 17:21 | 12 | about 4 min | 12.5 min (full audits: the seed changed) |
| B (#77) | about 35 min to open, merged 17:58 | 7 | about 3 min | 13.5 min |
| C (#78) | about 33 min to open, one more commit at 18:27 for a CodeQL false positive in a test | 13 | about 4 min | about 25 min |
| D (#79) | about 15 min to open, built while C was in CI | 5 | about 2 min | see the PR |

Judgment calls: a second cron trigger sends the campaign batches; the unsubscribe token is stored, not signed; a
campaign email never counts as reaching a person; an unsubscribe or a complaint follows the person, a bounce blocks only
its address; a valid unsubscribe link is never rate limited; test sends write no audit row; the daily limit counts UTC
days, default 90; the Lighthouse slot moved to the campaign review page; `copies:update` now brings each copy's cron
triggers in step with the template.

## Run 7 (2026-11-24)

Run 7, "Speed" (2026-11-24). Plan: `docs/superpowers/plans/2026-11-24-run7-speed.md`. Decision 0052. Goal: make every later run faster and cheaper without lowering the bar.

Built:

- PR A (#73, merged): `npm run check:fast` (only the unit tests a change can reach; all of them when unsure), one shared e2e Worker with a fresh database copy per file, `scripts/board-changed.mjs` for CI, the baseline timings.
- PR B (this PR, auto-merge queued): docs/PROCESS.md, `npm run check:process` and its tests, STATUS.md under 150 lines (history moved unchanged), the decisions index, CLAUDE.md and AGENTS.md with each rule once and one merge rule, the short "Autonomous runs".
- Owner-only proposals (hook, ci.yml, three agents) with one batch script: Needs Grant 1.

Timings: full check 82.3 s to 29.9 s here; e2e 66.6 s to 15.7 s; check:fast 3 to 5 s; CI `check` job 3 min 18 s to 1 min 56 s. Details: docs/PROCESS.md "Timings".

| PR | Wall-clock | Commits | Time in checks | Waiting on CI |
|---|---|---|---|---|
| A (#73) | about 21 min to open (12:56 to 13:17), merged 13:30 | 6 | about 3.5 min (the old hook ran the full check on each commit, plus two timing runs) | 12.5 min (Lighthouse about 12 min; the PR changed package files, so a full audit) |
| B (this PR) | about 40 min to open, built while A was in CI | 5 | about 3 min | see the PR; it still runs the full audits until the owner's ci.yml lands |

Judgment calls (one line each):

- "Execute unattended" was treated as an autonomous run: auto-merge after review.
- `check:process` runs on its own until the owner batch wires it in, because it checks the hook file and would block every commit before then (0052).
- `check:fast` checks what is not committed yet (against HEAD); `-- --branch` checks the whole branch.
- Unit tests stay one process per file: one shared process was slower (18.0 s against 9.5 s).
- The e2e Worker uses wrangler's unstable `unstable_startWorker`; wrangler is pinned, and a break fails loudly.
- `src/mcp/` is not a board path for the audits; a push to main audits everything anyway.
- Branch B was built on A's tip and rebased onto main after A merged, before its first push (no force push).
- The proposed ci.yml adds a "Process rules" step to `check`, so CI also runs `check:process`.
- Not changed: CLAUDE.md still says both "Plan first and wait for my approval" and "plan, decide and build without asking me" (outside autonomous runs); your call.

Queued: nothing beyond Needs Grant 1 to 3.

## Run 6 (2026-11-23 to 2026-11-24)

Daily work (docs/PLAN.md, "Run 6"; plan `docs/superpowers/plans/2026-11-24-run6-daily-work.md`): approve before
change, to-dos like a list, capture through the AI app, timer and time entries with billing rates. Every task had an
independent review before its PR (A1 also a security review; B4, D7 and D8 an accessibility review), findings were fixed
and re-reviewed, and a final review of the whole run found one Critical item (D1 calls) that the fix PR closed.

| # | Task | PR | State |
| --- | --- | --- | --- |
| - | Plan | [#61](https://github.com/huston-logic/pipeline/pull/61) | merged |
| A1 | Proposals: `propose_changes`, `apply_changes` (0044, migration 0014) | [#62](https://github.com/huston-logic/pipeline/pull/62) | merged |
| A2 | The "AI edits" setting (0045, migration 0015) | [#63](https://github.com/huston-logic/pipeline/pull/63) | merged |
| B3 | Standalone tasks (0046, migration 0016) | [#64](https://github.com/huston-logic/pipeline/pull/64) | merged |
| B4 | Today works like a list (0047) | [#65](https://github.com/huston-logic/pipeline/pull/65) | merged |
| C5 | Capture and `list_tasks` (0048, migration 0017) | [#66](https://github.com/huston-logic/pipeline/pull/66) | merged |
| D6 | Time and rates: data and MCP (0049, migration 0018) | [#67](https://github.com/huston-logic/pipeline/pull/67) | merged |
| D7 | The timer on the board (0050) | [#68](https://github.com/huston-logic/pipeline/pull/68) | merged |
| D8 | Time pages and CSV (0051) | [#69](https://github.com/huston-logic/pipeline/pull/69) | merged |
| - | Final-review fixes (D1 calls, Today in SQL, list shows every column) | [#70](https://github.com/huston-logic/pipeline/pull/70) | open, auto-merge queued |
| E9 | Closing docs and status | #71 (this PR) | open, ready for auto-merge |

CI on the way: #69's `a11y` job hit Playwright's 5-minute limit (the suite grew to about 284 tests), then failed two
pages at 375 px because the screen-reader-only "Edit" text in the new tables escaped the table's scroll box and widened
the page to 797 px; fixed with one CSS line (`.table-scroll` gets `position: relative`) and the limit raised to 12
minutes.

### Run 6 rulings (cost if wrong)

- 1. The brief ("run it unattended start to finish ... merge") is treated as an autonomous run under CLAUDE.md:
  auto-merge after review, no questions. Cost: none.
- 2. A proposal expires 2 hours after it is made, holds at most 25 actions, and at most 10 wait at once (the same
  window and cap as import drafts). Cost: a yes given later than 2 hours needs a fresh list.
- 3. `apply_changes` plans the actions again at apply time and refuses unless every record it reads has the same
  version it had when proposed, so "changed since" is exact and the dates and times are the apply's. Cost: none.
- 4. The proposal list is rendered from the rows the change would write, not from the AI's request, so it shows
  side effects too (a lead becoming Contacted, a stage move's note). Cost: a slightly longer list.
- 5. A record added in a proposal can be named by later actions (`@1`) only as the subject of a note, a task or time;
  editing it in a later action is refused ("put those details in action 1"). Cost: the AI folds details into the add.
- 6. "Apply small changes" applies at once only a logged call or note on an existing record, a ticked task, and (D6)
  starting a timer or stopping one without a next-step date. Cost: other one-record edits still need a yes.
- 7. Proposals are not shown on the board; the owner approves in the AI app. Cost: a board page later if wanted.
- 8. A per-client rate is per person (a contact), not per company. Cost: a rate per person at the same company.
- 9. Time tracking is off by default; the demo seed turns it on so the time pages are tested. Cost: none.
- 10. Making a proposal also tries it on the database and rolls the try back, so a stored list is one that can be
  applied. Cost: one extra D1 batch per proposal.
- 11. Apply refuses if the list, drawn again, reads differently from the one you were shown; a long list is stored as
  a bulk change by its size in bytes. Cost: a list that changed in wording needs a fresh proposal.
- 12. There is no second owner confirmation inside `apply_changes`: the AI app must ask you. Proposals add a step, not
  access, since the record tools already wrote directly. Cost: an AI acting on injected text could still propose and apply.
- 13. At 10 open proposals, a new one drops the oldest instead of being refused. Cost: a list still waiting for a yes
  must be proposed again.
- 14. A name that matches only outside text, or more than 10 people, becomes a question to you; any outside-only match
  turns every candidate into a question. Cost: more "Which Dana?" questions.
- 15. A small change applied at once names records by the services' exact-name lookup, not the proposal's outside-name
  protection (0045). Cost: a rare exact-name match on an outside-made record goes straight in.
- 16. The "AI edits" setting has no board control; you set it by asking the AI app. Cost: a board setting later if wanted.
- 17. Migration 0016 saves and restores `rule_firings.task_id` around the table rebuild, because `DROP TABLE` runs
  `ON DELETE SET NULL` even with deferred checks (now a warning in AGENTS.md). Cost: none.
- 18. The tasks import's board lede now says "or on no one when its line names no one" (it would be false otherwise).
  Cost: one sentence to reword.
- 19. Today shows at most 50 to-dos per list after sorting, with "Showing 50 of N", and no show-all. Cost: the 51st is
  reachable only after others are done. A date-only due date is midnight in your timezone. Cost: a task due today
  sorts before 9 AM ones.
- 20. Today's sort, filter and 50-cut run in the database (one batch), not in the Worker. Cost: person sort uses
  ASCII-only `lower()`, so names differing only by an accented capital may sort apart.
- 21. Capture's acceptance sentence is number 26 (21 to 25 were taken in run 5), and the demo seed stays as it was.
  Cost: a rename if you prefer 21.
- 22. A read-only `list_tasks` tool was added so undated to-dos are visible to the AI app. Cost: one small tool.
- 23. A proposed `stop_timer` ends at the time the list was made; the note is logged at the time you say yes. Cost: a
  yes an hour later still ends the entry at the proposal time (the owner can edit it).
- 24. A timer started in a list cannot be stopped in the same list (use `add_time_entry`). Cost: two steps.
- 25. No work type means not billable; billable with no rate stores no rate and $0. Cost: none.
- 26. Before the final fix, a list was checked as a whole for "shows something"; now every column a row writes must be
  shown, with a table-driven test over every action. Cost: a stricter list drawing.
- 27. Over MCP, `stop_timer` cannot clear a work type; the AI app uses `update_time_entry`. The board's stop form can.
  Cost: one extra call in a rare case.
- 28. The three time CSV links are hidden on the Export page while time tracking is off (the data stays in the JSON
  export). Cost: none.
- 29. Add time's "Billable" is a three-way choice (follow the work type, billable, not billable); the Stop form keeps a
  checkbox. Cost: the two forms differ.
- 30. The person and deal pickers on the time forms list the first 300 records. Cost: a very large copy can't pick
  someone past 300.
- 31. Final fix: a 25-action list was cut from 158 to 31 D1 calls (and apply from 88 to 30) with a once-per-request
  memo of settings-like tables and name matching in one batch; `PROPOSAL_MAX_ACTIONS` stays 25. Cost: the 40-call bound
  is proven only for the test's action mixes.
- 32. The a11y suite's Playwright `globalTimeout` went from 5 to 12 minutes in #69, by the run controller, without
  asking you. Confirmed by you on 2026-11-24 (keep 12 minutes).
- 33. One CSS line (`.table-scroll { position: relative }`) fixed the 797 px width bug on the table pages, checked at
  375 px on four routes but without a subagent review. Cost: CI's required a11y job was the test.
- 34. The "capture" rulebook document is a short, editable text added by migration 0017, so a fifth document sits after
  "leads" on new copies and last on old ones. Cost: the order differs between copies (harmless).
- 35. The demo seed's time entries are anchored to this week's Monday (they sat in the past, so "This week" was empty
  on a Monday), and one fixed entry (2026-11-17) keeps `/time?week=2026-11-16` populated. Cost: none.

### Run 6 minor findings (none blocks use)

- Proposals: `withShownIds` does not rewrite bound extra or leading statements (safe today); the wording of the `@n`
  task refusal and of a bind message; an unknown trial failure gives the generic server message; an apply after a
  concurrent replace says "changed since", not "replaced by"; the layering test misses a dynamic `import()`; outside-made
  records can be named only by id (more questions); no test for two applies racing beyond the one written; the 40-call
  bound is proven only for the tested mixes, and it is unknown whether D1 counts each statement in a batch.
- AI edits: `get_settings`' description is long; a small `log_activity` skips the name-match outside-name protection (as
  before, written in 0045).
- To-dos and Today: no positive test that a snoozed task wakes; "overdue" is defined in two places; the 50 cap can hide
  an overdue task under "Newest first" (by design); Today's person sort is ASCII-case only.
- Time: no daylight-saving test of a week boundary (right by construction); the stop form draws the box from the work
  type default while an untouched box falls back to the running timer's value (differs only after an explicit override
  at start); the done page may show an archived task; no Stop bar on the generic refusal and 404 pages; a lone
  "(optional)" on the Next step date.
- Time pages: the 300-entry limit on the pickers; a fixed `?week=` route drifts empty over time (one fixed seed entry
  keeps the demo populated); the edit form pre-fills both End and Minutes; week links have no dates in their names;
  Archive has no confirm (Undo is on the banner, as elsewhere); the `/companies` swap in Lighthouse's page list is weaker
  than first claimed (the Time pages replace it).

## Run 5 (2026-11-22 to 2026-11-23)

Import and people (docs/PLAN.md, "Run 5"; plan `docs/superpowers/plans/2026-11-22-run5-import-and-people.md`). Every
task had an independent review before its PR (I3, I5 and I6 also a security review); findings were fixed and
re-reviewed. From P9 on, at your request, every subagent ran on Sonnet.

| # | Task | PR | State |
| --- | --- | --- | --- |
| - | Plan | [#46](https://github.com/huston-logic/pipeline/pull/46) | merged |
| I1 | One import engine (0034) | [#47](https://github.com/huston-logic/pipeline/pull/47) | merged |
| I2 | One change at any size (0035, migration 0009) | [#48](https://github.com/huston-logic/pipeline/pull/48) | merged |
| I3 | Board import for People (0036, migration 0010) | [#49](https://github.com/huston-logic/pipeline/pull/49) | merged |
| I4 | Deals and tasks (0037) | [#50](https://github.com/huston-logic/pipeline/pull/50) | merged |
| I5 | "This is my own list" (0038) | [#51](https://github.com/huston-logic/pipeline/pull/51) | merged |
| I6 | Import over MCP (0039) | [#52](https://github.com/huston-logic/pipeline/pull/52) | merged |
| P7 | Person status (0040, migration 0011) | [#53](https://github.com/huston-logic/pipeline/pull/53) | merged |
| P8 | Tools, Add contact, form fields (0041, migration 0012) | [#54](https://github.com/huston-logic/pipeline/pull/54) | merged |
| P9 | Saved views (0042, migration 0013) | [#55](https://github.com/huston-logic/pipeline/pull/55) | merged |
| P10 | Table layout (0043) | [#57](https://github.com/huston-logic/pipeline/pull/57) | merged |
| - | CLAUDE.md: no local Lighthouse | [#56](https://github.com/huston-logic/pipeline/pull/56) | merged |
| C11 | Closing docs and status | [#58](https://github.com/huston-logic/pipeline/pull/58) | merged |
| - | Lighthouse: 20 pages, 3 runs, retry crashed runs | [#59](https://github.com/huston-logic/pipeline/pull/59) | merged |

CI on the way: `lighthouse` grew to 38 pages × 5 runs (#56 hit the 35-minute limit) and failed twice on Chrome's
`NO_NAVSTART` (#57, #59), which led to #59. CodeQL flagged a High alert (`js/incomplete-multi-character-sanitization`)
in a test helper that stripped HTML tags in #57; fixed in code by splitting on tags instead.

### Run 5 rulings (cost if wrong)

- 1. The per-task subagent review is the code review CLAUDE.md asks for before each merge. Cost: none.
- 2. A 2,000-row board import stays one request (about 11 ms of CPU, over the free plan's 10 ms), because splitting it
  would break all-or-nothing. Cost: a big import on a free copy may fail until the file is split or the copy upgraded.
- 3. A "New field" label starts empty on the board, so a header from a file never becomes a trusted label in one tap.
  Cost: one box to type.
- 4. Rows marked archived in an imported file are skipped and counted, never created archived. Cost: archived history
  stays only in the JSON export when moving between copies.
- 5. "This is my own list" is on the board only, never in the CLI or MCP; a draft the AI app started or added rows to
  never offers it. Cost: re-upload on the board to confirm names.
- 6. At most 10 imports can wait at once (board and AI app together). Cost: an 11th waits up to 2 hours.
- 7. Later tasks were built on a local branch stacked on the previous PR while its CI ran, then rebased onto `main`
  before pushing; no Part 2 PR opened before Part 1 had merged. Cost: none.
- 8. There is no board page to manage Person statuses; the owner does it by talking. Cost: a later task if wanted.
- 9. Default views exist for every status except Lead and Contact (the built-in Leads and Contacts views show them).
  Cost: none.
- 10. The Pipeline List defaults to a table; people lists to cards unless the view says table; `?layout=` changes it
  for one visit without writing. Cost: none.

### Run 5 minor findings (none blocks use)

- Import: the preview refusal answers 200; the upload's 413 doesn't give the size; a re-map in another window just
  before apply says "Someone in this file was changed"; a task whose deal and person disagree follows the deal; an AI
  app can fill all 10 import slots for 2 hours (no discard); look-alike letters (fullwidth, mathematical) pass "my own
  list" (visible, owner's choice).
- People: on the edit form a stale sub-status is dropped when the status changes; the custom-field filter's number
  parsing accepts forms like `0x10`.
- Views: undo doesn't guard a sub-status or field a view filters by (the view then shows nobody, with the raw key);
  undoing an archive can bring back a duplicate view name; a people view over 2,000 people spends about 93 ms in D1.
- Table: the scroll region's focus ring corner doesn't match its rounded corner; the layout switch also shows on an
  empty list; the 375 and 1280 px screenshots of the table pages were not taken locally (CI's a11y job covers them).

## Run 4 (2026-11-20)

People and leads, then the "it comes to you" items (docs/PLAN.md, "Run 4"; decision 0022; plan
`docs/superpowers/plans/2026-11-20-run4-leads.md`).

| # | Task | PR | State |
| --- | --- | --- | --- |
| T0 | Record the design (0022) | [#28](https://github.com/huston-logic/pipeline/pull/28) | merged |
| E1 | Install lessons | [#29](https://github.com/huston-logic/pipeline/pull/29) | merged |
| L1 | Leads migration 0006 (lead status on contacts; rules and firings rebuilt) | [#30](https://github.com/huston-logic/pipeline/pull/30) | merged |
| L2 | `add_lead` for people to approach, `add_deal` for inquiries, auto-advance (0023) | [#31](https://github.com/huston-logic/pipeline/pull/31) | merged |
| L3 | `qualify_lead` and `return_to_lead` (0024) | [#33](https://github.com/huston-logic/pipeline/pull/33) | merged |
| L4 | `list_leads`, lead status in search, leads line in the summary and brief (0025) | [#34](https://github.com/huston-logic/pipeline/pull/34) | merged |
| L5 | `lead_followup` rule (0026) | [#35](https://github.com/huston-logic/pipeline/pull/35) | merged |
| L6 | People tab: Contacts, Leads, Companies; the Leads list (0027) | [#36](https://github.com/huston-logic/pipeline/pull/36) | merged |
| L7 | Lead pages on the board: status, Qualify, Add a lead or a deal, Back to leads (0028) | [#41](https://github.com/huston-logic/pipeline/pull/41) | merged |
| L8 | Leads in the import, export and demo seed (0029) | [#38](https://github.com/huston-logic/pipeline/pull/38) | merged |
| L9 | Acceptance sentences 13 to 20, CPU on 2,000 leads | [#40](https://github.com/huston-logic/pipeline/pull/40) | merged |
| B1 | What it caught, a monthly report (0032) | [#39](https://github.com/huston-logic/pipeline/pull/39) | merged |
| C1 | Email logging by BCC (0031, migration 0008) | [#37](https://github.com/huston-logic/pipeline/pull/37) | merged |
| D1 | Phone notification when the brief is ready (0030, migration 0007) | [#32](https://github.com/huston-logic/pipeline/pull/32) | merged |
| E2 | After you update, closing status, CPU re-measure | [#42](https://github.com/huston-logic/pipeline/pull/42) | merged |
| F1 | Final-review fixes (undo guard, archived refusals, brief count, Contacts search hint 0033) | [#43](https://github.com/huston-logic/pipeline/pull/43) | merged |

Every task went through an independent review; fixes were made before merge. CI flakes on the way: `lighthouse`
`NO_NAVSTART` (re-ran the failed job) on #32 and #36.

Code scanning on the way, each fixed in code (never dismissed):
- #32 had two High alerts: a URL substring check in a test, and a regular expression in `src/push/vapid.ts` that could
  run very slowly on some inputs.
- #37 had High alert 12, `js/incomplete-multi-character-sanitization`, in `src/email/parse.ts`. The HTML-to-text step
  for an HTML-only email removed one tag at a time with `/<[^<>]*>/g`, so `<scr<b>ipt>` became `<script>`.
  - The fix: tags are now removed in one forward walk. A `<` before a letter, `/`, `!` or `?` starts a tag that runs to
    the next `>`. Any other `<` stays as text with the character after it. Entities are decoded once, afterwards.
  - Tests: nested-tag cases and a seeded fuzz test over 5,000 inputs prove that no `<` left in the text can start a tag.

### Run 4 rulings (cost if wrong)

- 1. `contactedIfNew` in `src/services/lead-change.ts` is the one definition of auto-advance (New to Contacted);
  `log_activity` and email logging both use it. Cost: a small rename.
- 2. Web push sends an encrypted fixed payload, never record text (research note for C1 and D1). Cost: a notification
  says less.
- 3. Email logging trusts only Cloudflare's own `Authentication-Results` (authserv-id `mx.cloudflare.net`) and needs
  dmarc=pass (or spf and dkim pass when dmarc is absent). Cost: some genuine owner mail is not logged, silently.
- 4. Decision numbers reserved up front (L tasks 0023 to 0029, D1 0030, C1 0031, B1 0032); 0028 is the lead pages;
  0033 (Contacts search hint) came in F1. Cost: a gap in the numbering.
- 5. Worktree implementers write reports only to the controller's scratchpad. Cost: none.
- 6. D1 ran in parallel with the L tasks in its own worktree. Cost: merge conflicts, which happened and were resolved
  (`src/brief/run.ts`, `tools-read.ts`, `layout.test.ts`).
- 7. Undo refuses, in plain English, when it would reopen a deal whose person is now an unqualified lead (it points to
  `update_deal`). Cost: one extra step in a rare case.
- 8. The brief counts accepted emails with no matched person ("N logged emails matched no one"); F1 narrowed it to
  emails that had an unmatched recipient. Cost: the count's meaning shifts slightly.
- 9. The last test-only fix on D1 was checked by the run controller directly, not by a fifth reviewer. Cost: a flaky
  test CI would catch.
- 10. The empty Leads view says "No open leads. Choose Closed out under Status to see the rest." when closed-out leads
  exist (new copy, no change of existing meaning). Cost: one sentence to reword.
- 11. Email logging reads authentication from the headers Cloudflare builds, not the raw message; every result of a
  method must pass; no header means drop. Cost: all mail dropped until fixed (the safe direction).
- 12. Only Cloudflare's first header segment counts (cut at the first comma outside comments and quotes). Cost: re-tune
  after the first live test email.
- 13. Cloudflare's header is isolated by subtracting the raw message's own values; if it does not end that way, the
  mail is dropped; several dmarc results must all pass. Cost: owner mail dropped until adjusted.
- 14. "Back to leads" shows on open, lost and not-now deals for every owner, so existing outreach deals can be moved.
  Cost: hide it behind "this person has a lead" later.
- 15. In an email's HTML read as text, a `<` starts a tag only before a letter, `/`, `!` or `?`, as in a browser. Any
  other `<` is kept with the character after it ("I am < 5 min away"), except one before another `<` or at the end.
  Cost: a stray character or two lost or kept in odd HTML.

### Minor findings from run 4 and earlier (none blocks use)

Not built: replies from leads are not logged (they reach your own inbox, not the log address), so email logging
covers only mail you send with the Bcc; forwarded mail is not parsed for the original sender.

**Fixed on 2026-11-21 (branch `fix/run4-minor-findings`), each with a test written first:**

- `list_leads` and the leads page left a snoozed task with no due date out of a person's next task; it now counts from
  the day it wakes (an undated task that is not snoozed still shows none).
- Posting the same Not now with a check-back date twice added two identical "Check back" tasks; the second is now
  refused with "Nothing to change ... every value you gave is already set" (a different date, or a done task, still adds one).
- `src/db/db.ts` imported the `LeadStatus` type from `src/services/`; the status definitions now live in
  `src/db/lead-status.ts` (re-exported from `src/services/lead-status.ts`, so no other import moved), and a test fails
  if anything in `src/db` imports from `src/services`.
- The deal page read the contact twice (a join, then `SELECT *`); `getDealBrief` now reads it once.
- A failure other than a refusal while turning a gone device off lost the push counts (and could fail the brief step);
  the counts now stand, the device stays on to be tried next time, and one log line names the device by id.
- The 20-device notification cap was checked before the write, so two devices turning on together could pass the
  check; a guard inside the same batch now refuses the loser with the usual message.
- `ReachContact.untrusted_fields` in `src/board/reach.ts` was unused; removed (the test fixture no longer carries it).

**Left because fixing it changes wording users see (your call, nothing changed):**

- The summary says "Moved ... back to leads (Contacted)" when the person is already Contacted.
- The nbsp phone refusal note doesn't say why (hidden character).
- Docs: ACCESS-SETUP's "worked on the first live copy" history note; the Access item "Add public hostname" is not
  flagged "check in the dashboard".
- `/companies` has no row cap (a cap needs a "showing the first N" line; fast at 300 companies).

**Left on purpose or because it needs your call (not wording):**

- A paused deal rule still shows its 30-day look-back in a preview (`paused: true`). The code comment says this is
  meant; a paused lead rule shows nothing. Say if you want them to match.
- Ask Claude's "Prep me for this call" also shows on closed deals (hiding it is a product call; decision 0021 says
  nothing either way).
- A bad custom field value skips the whole import merge row, as it does on create (a row-level choice).
- A quoted local part containing `;` in Cloudflare's header is dropped. This fails closed on purpose (ruling 12 and 13);
  loosening it would weaken the sender check.
- The fire-key read in a lead preview covers all the rule's keys (bounded); the rulebook order differs between a fresh
  and an upgraded copy (harmless; a fix would rewrite stored data).
- `wrangler dev` may echo the throwaway keys in the local terminal (they exist only in memory and for local runs;
  hiding them would mean writing them to a file).
- The end-to-end email test covers only the drop path: locally nothing prepends Cloudflare's header, so the logged path
  stays unit-tested.
- board.js's focus move and Copy prompt are only text-checked (a browser test needs the Chromium install in Needs
  Grant 8); a double tap on a Log button logs twice (decision 0021 accepts this).
- The company sort on /contacts (SQLite NOCASE) and the grouping on /companies (a collator) treat tabs and accents
  slightly differently; the Contacts search echoes the query in the page (escaped, as intended); the CSV export of a
  very large copy still needs `copies:export`.
- **Performance:** narrow the contact read in the brief and in the deal reads to the people the request needs, if the
  CPU items in Needs Grant 10 bite on a real copy.

## Run 3 (2026-11-19)

Short run: land run 2's last two PRs once the owner merged the CI timeout fix and the owner-only proposals
([#26](https://github.com/huston-logic/pipeline/pull/26)).

| Task | PR | State |
| --- | --- | --- |
| R4 Editing, updated from main | [#22](https://github.com/huston-logic/pipeline/pull/22) | merged (squash); all checks passed, lighthouse within the new timeout |
| R5 Phone actions, updated from main and marked ready | [#24](https://github.com/huston-logic/pipeline/pull/24) | merged (squash); reviewed (no critical or important findings), all checks passed |
| Status | [#27](https://github.com/huston-logic/pipeline/pull/27) | merged |

Ruling: #24 was stacked on #22, so after #22's squash merge the update from main conflicted in five files where R5
had edited R4's lines. R5's side was kept (it already held all of #22); the merged tree was checked to differ from
R5's tip by exactly main's other changes (#23, #25, #26), and `npm run check` passed (735 unit, 32 e2e).

## Run 2 (2026-11-18 to 2026-11-19)

The board becomes the owner's daily screen (docs/PLAN.md, "Run 2"; decision 0014).

| # | Task | PR | State |
| --- | --- | --- | --- |
| 0 | Spec change: editable board (decision 0014) | [#15](https://github.com/huston-logic/pipeline/pull/15) | merged |
| R1 | Look and navigation (0015) | [#17](https://github.com/huston-logic/pipeline/pull/17) | merged |
| R2 | Contacts and companies, realistic seed (0016) | [#19](https://github.com/huston-logic/pipeline/pull/19) | merged |
| R3 | Pipeline kanban and the board write path (0017) | [#20](https://github.com/huston-logic/pipeline/pull/20) | merged |
| R4 | Editing (0018) | [#22](https://github.com/huston-logic/pipeline/pull/22) | merged in run 3 |
| R5 | Phone actions and Ask Claude (0021) | [#24](https://github.com/huston-logic/pipeline/pull/24) | merged in run 3 |
| R6 | Home-screen app (0019) | [#21](https://github.com/huston-logic/pipeline/pull/21) | merged |
| R7 | CPU check (0020, docs/PAID-PLAN.md) | [#23](https://github.com/huston-logic/pipeline/pull/23) | merged |
| R8 | Deferred minor findings | [#18](https://github.com/huston-logic/pipeline/pull/18) | merged |
| R9 | Decision wording (0004, 0010) | [#16](https://github.com/huston-logic/pipeline/pull/16) | merged |
| R10 | Owner-only proposals | [#26](https://github.com/huston-logic/pipeline/pull/26) (copied in by the owner) | merged |
| - | Closing status | [#25](https://github.com/huston-logic/pipeline/pull/25) | merged |

### Run 2 rulings (cost if wrong)

- Huston Logic v3 is the board's design system (docs/STYLE-GUIDE.md), with system fonts instead of v3's web fonts
  because AGENTS.md allows no web fonts (0015). Cost: headings look less like the website.
- Business name and accent colour are settings (migration 0004); an accent is refused unless it keeps 4.5:1 on white,
  silver and the page glow; served as `/theme.css` from the Worker (0015).
- CSRF cookie is `SameSite=Lax`, not Strict as 0014 first said: Strict broke open tabs after every Access sign-in.
  The origin check and token still stop cross-site posts (0014, 0017).
- An undo that would remove records (an intake lead, an import, a new lead) asks first; value-restoring undos stay one
  click (0017). MCP `undo_change` is unchanged.
- Edits send only the fields the owner changed, so re-saving a form never turns outside text into the owner's (0018).
  Record forms read up to 128 KB; other posts 16 KB (0014, 0018).
- `add_lead` takes an optional existing `contact`, and `name` is optional when it is given (0018).
- `tel:`, `sms:` and `mailto:` may use outside phone numbers and emails after strict normalisation, a narrow exception
  to 0013; a text is logged as a note (0021). Ask Claude prompts carry only the deal id.
- The kanban shows the 50 deals longest in each stage, with "Show all N" (0020). The full JSON export stays over the
  free plan's CPU on a large copy; `npm run copies:export` is the free route (0020, docs/PAID-PLAN.md).
- The seed is a fake engineering firm ("Fernbrook Engineering (demo)", 18 contacts, 20 deals) with 13 change-log rows;
  unit tests use the old seed copied to `tests/helpers/fixture-seed.ts` (0016).

Dependencies added in run 2: none.

Screenshots of every board page at 375 and 1280 px: `.owner-review/screenshots/` (git-ignored, this Mac only;
`npm run build` then `npm run screenshots` to refresh).

## Run 1 tasks (2026-11-18)

| # | Task | PR | State |
| --- | --- | --- | --- |
| 0 | Spec, plan, status | [#1](https://github.com/huston-logic/pipeline/pull/1) | merged |
| 1 | M1 repo identity and engine skeleton | [#2](https://github.com/huston-logic/pipeline/pull/2) | merged |
| 2 | M2 D1 schema, migrations, seed, data access | [#3](https://github.com/huston-logic/pipeline/pull/3) | merged |
| 3 | M3 service layer, audit, undo | [#4](https://github.com/huston-logic/pipeline/pull/4) | merged |
| 4 | M4 MCP endpoint | [#5](https://github.com/huston-logic/pipeline/pull/5) | merged |
| 5 | M5 building blocks | [#6](https://github.com/huston-logic/pipeline/pull/6) | merged (a11y needed one re-run: CI runner apt mirror glitch) |
| 6 | M6 rules engine | [#7](https://github.com/huston-logic/pipeline/pull/7) | merged |
| 7 | M7 daily brief | [#8](https://github.com/huston-logic/pipeline/pull/8) | merged |
| 8 | M8 `/intake` | [#9](https://github.com/huston-logic/pipeline/pull/9) | merged |
| 9 | M9 board | [#10](https://github.com/huston-logic/pipeline/pull/10) | merged |
| 10 | M10 production auth | [#11](https://github.com/huston-logic/pipeline/pull/11) | merged |
| 11 | M11 many copies | [#12](https://github.com/huston-logic/pipeline/pull/12) | merged |
| 12 | M12 acceptance | [#13](https://github.com/huston-logic/pipeline/pull/13) | merged |
| - | Whole-run review fixes | [#14](https://github.com/huston-logic/pipeline/pull/14) | merged |

Run 1 finished on 2026-11-18: every milestone in the spec is built, reviewed and merged.

## Decisions

Files in `docs/decisions/`. Rulings made while running the plan:

- Work happens in the main checkout, one branch and PR per task, each from a fresh `main` (no worktrees).
- Task 4 used the MCP SDK v2 packages (`@modelcontextprotocol/server` 2.4.0) instead of `@modelcontextprotocol/sdk`
  1.x: the current Cloudflare docs say `createMcpHandler` (`agents/mcp/server`) serves an SDK v2 server built by a
  factory per request, and `agents` 0.33.0 requires server 2.4.0 exactly.
- Decision numbers 0004 to 0007 were reserved for tasks 4, 5, 10 and 11 (see PLAN.md); task 2 used 0008, task 3 0009.
- Outside text never reaches a summary, headline or error message: records whose text came from outside are named by
  id ("contact ct_..."). Deals and tasks gained `untrusted_fields` (migration 0002). Plan task 7's briefs migration
  became 0003.
- Unit tests never load the `agents` package; the Worker loads the MCP handler lazily. `/mcp` is tested end to end
  against `wrangler dev --local`.
- Undo of a lead is refused once a rule has fired on its deal (rule firings are kept so the rule does not fire twice).
- Owner emails (who may sign in) cannot be changed through MCP (decision 0005); they are set at install time.
- A call or email logged against just a contact counts as activity on all of that contact's open deals.
- The last stage of each kind (open, won, lost, not now) cannot be archived, so a deal can always be closed.
- Rules count "N days" as 24-hour periods from the moment a deal entered its stage (decision 0010). Rules on closed
  stages (Won, Lost, Not now) are refused because they could never fire. A resumed or retargeted rule does not catch
  up on stage entries from before it was resumed or retargeted.
- The daily brief is composed and stored every day, whatever the "brief on/off" setting says; that setting (plus a
  deploy flag and secrets) only controls emailing it (decision 0011). Briefs are a system log, not audited or undoable.
- `/intake` is server-to-server only (no CORS; the secret must never be in browser code). A form never overwrites an
  existing contact's details; it adds a new deal and a form activity. Repeats within 10 minutes are ignored
  (decision 0012).
- The board is HTML rendered by the Worker; run 2 made it editable (decision 0014), with outside text labelled "From
  outside". CSV export guards spreadsheet formulas by prefixing `'` (decision 0013).
- Production sign-in (decision 0006): Cloudflare Access protects the board and `/api` (the Worker also verifies the
  Access JWT); `/mcp` uses OAuth in the same Worker with Access for SaaS as the identity provider, and asks the owner
  to approve each new AI app on a consent page. `/intake` and the OAuth paths bypass Access. A copy on a custom
  domain must set `MCP_ALLOWED_HOSTNAMES`, or `/mcp` answers 403.
- The intake rate limit is 30 per minute, because it counts the website server's requests, not visitors'.
- End-to-end test files run one at a time after a single build (they raced when run in parallel).
- Copies are updated by one command the owner runs (`npm run copies:update`) with a Cloudflare login that is a member
  of each client account; no client ids or tokens live in the repo or in GitHub (decision 0007). This repo is not
  connected to Workers Builds. `/register` and `/authorize` are rate-limited (20 per minute) so anonymous traffic
  cannot use up the free plan's KV writes.
- A CSV import is one audited, undoable change; it only fills empty fields on existing contacts and marks imported text
  as outside text. Very large CSVs are refused with "split the CSV" (D1 statement size limit).
- An update never deploys a copy whose migrations did not apply (for example if the confirm prompt is answered no).
- Whole-run review fixes (PR #14): undo refuses to remove a field whose values are in use, a choice that is in use, or
  a stage a rule watches; the brief address must be an owner email (checked on save and again before sending); the
  server instructions say configuration (rulebook, settings, rules, stages, fields) changes only when the owner asks
  in the conversation; one hourly run creates at most 25 rule tasks (the rest follow next hour); update tools are
  marked destructive so AI apps ask before using them; version preview URLs are off for copies.

## Dependencies added, by PR

- `typescript-eslint` 8.72.2 (dev). PR #2. Removed there: `next`, `react`, `react-dom`, `tailwindcss`,
  `@tailwindcss/turbopack`, `eslint-config-next`, `@types/react`, `@types/react-dom`.
- `agents` 0.33.0, `@modelcontextprotocol/server` 2.4.0, `zod` 4.6.7 (runtime); `@modelcontextprotocol/client` 2.4.0
  (dev; also a peer of `agents`). PR #5. Worker bundle about 0.24 MB gzip (free plan limit 3 MB).
- `@cloudflare/workers-oauth-provider` 1.2.4 (runtime, no runtime dependencies of its own). PR #11.
- `postal-mime` 4.2.1 (runtime; MIT-0 licence, no dependencies of its own, published 2026-11-10, 10 days old at the
  time). Parses the raw email for email logging. PR #37.
- Every version was at least 7 days old; lockfiles written with npm 10.9.9.

## How to resume

1. `git switch main && git pull --ff-only`
2. Read `docs/SPEC.md`, `docs/PLAN.md` and this file; start from "Needs Grant" and "Minor findings left".
3. Run 2's shared brief for implementers and the owner's proposals and screenshots are in `.owner-review/`
   (git-ignored, this Mac only).
