# Status

Business priorities live in the Google Doc "00 Huston Logic: Source of Truth"; the master links to this file. This
file is the repo's status: update it in place at the end of every run (CLAUDE.md, "Status and source of truth").
Spec: `docs/SPEC.md`. Plan: `docs/PLAN.md`. Decisions: `docs/decisions/`. Dates are in the owner's timezone
(America/Los_Angeles), taken from the PR merge times in `gh`.

Last checked against the repo and `gh` on 2026-11-21, at `main` commit `a6f4dd0` (#44).

## Current state

**Merged.** Everything in the spec and in the run 2 and run 4 briefs is built and merged: 44 PRs (#1 to #44), no
other PR open, no open code-scanning alerts, and CI and CodeQL green on the latest `main` commit. Run 4 added people and
leads, email logging by BCC, phone notification for the brief, and the monthly "What it caught" report. The repo has
migrations 0001 to 0008 and decisions 0001 to 0033.

**Protection.** The "Protect main" ruleset is active (details in CLAUDE.md).

**Live.** Merging deploys nothing (decision 0007). The first client copy was installed by the owner on 2026-11-19, which
PR #29 ("install lessons from the first live copy") corroborates, and its config folder is on this Mac in the
git-ignored `.copies/`. What that copy runs now can't be checked from the repo or `gh`: whether it has been updated to
run 4's code (migrations 0006 to 0008) is open until you confirm it (Needs Grant 1).

**Open.** One PR (the minor findings, see the Changelog). What is left is in "Needs Grant" and in "Minor findings" below.

**Dependencies** (exact-pinned in `package.json`): runtime `agents` 0.33.0, `@modelcontextprotocol/server` 2.4.0,
`@cloudflare/workers-oauth-provider` 1.2.4, `postal-mime` 4.2.1, `zod` 4.6.7. Development: `@playwright/test` 1.65.0,
`@modelcontextprotocol/client` 2.4.0, `typescript-eslint` 8.72.2. Added in run 4: `postal-mime` (PR #37).

**Tests.** `npm run check` on this branch passes: 1,078 unit and 42 end-to-end tests, 0 failures. Local a11y does not
run on this Mac (Needs Grant 5); CI runs it.

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
  and "your call" in the section below. This PR.

## Needs Grant

Steps only you can do, in order. Items marked "per copy" repeat for each new client copy.

1. **Update the first copy to run 4** (per copy). `npm run copies:update -- --copy <name> --dry-run` first, then
   without `--dry-run`, then the steps in docs/UPDATING.md, "Run 4: after you update" (sections 1 to 6: update,
   reconnect the AI app's connector, the sentences to try, a lead import, email logging, notifications). Not checkable
   from here whether this is already done.
2. **Copy decisions** (they change what the copy says, so nothing was changed without you):
   - The board's outside-text note says "came from a website form or an import". That is wrong for a logged email.
   - The Pipeline empty state now says "Inquiries from your website form" (it said "Leads ..."), because "lead" now means
     a person you approach. Confirm you want that wording.
   - `/intake`'s change summary still says "new lead" for a new person who gets a deal; "new inquiry" would match the
     Pipeline wording.
3. **Email logging** (per copy, docs/EMAIL-LOGGING.md): a log subdomain with Email Routing onboarded, its DNS records,
   the `EMAIL_LOG_ADDRESS` secret, the routing rule to the Worker, then both go-live checks with a real test email. A
   strict DMARC policy on your sending domain is recommended. Ruling 12 (run 4) may need tuning after the first test.
4. **Notification keys** (per copy): `node scripts/make-vapid-keys.mjs --copy <name> --subject mailto:<owner email>`,
   then the three `wrangler secret put` commands it prints, then the phone steps in docs/UPDATING.md.
5. **Local Playwright Chromium**: this Mac has revision 1248; `@playwright/test` 1.65.0 wants 1254 (checked in
   `node_modules/playwright-core/browsers.json`), so `npm run test:a11y` fails here at browser launch (CI installs its
   own). Run `npx playwright install chromium` in your own terminal (installing a browser needs your approval).
6. **Phone checks on the first copy** (run 2): the Access Bypass for `/icons/*` is set (docs/ACCESS-SETUP.md step 3,
   check in step 7.5); Add to Home Screen shows the green icon; "Ask Claude" opens claude.ai with the prompt filled in
   (`claude.ai/new?q=` is how claude.ai behaves today, not a documented API; decision 0021).
7. **Cloudflare dashboard checks on the first copy:**
   - CPU items over 10 ms on the free plan (docs/PAID-PLAN.md, "Run 4 closing re-measure"): Today 13.8 ms, the hour of
     the brief 11.5, `preview_rule` on a deal rule 11.0, `list_deals` 10.3, the export 102 ms. All measured on a fake
     copy of 2,000 deals plus 2,000 leads on a busy Mac. `/companies` (7.7 ms) and `/leads` (2.1 ms) are fine.
   - D1 statements per invocation: the hourly run on the brief's hour makes 37 D1 calls holding 112 statements. If the
     free plan counts statements, lower `MAX_FIRINGS_PER_RUN` to about 8 or use Workers Paid.
8. **Only when you want them, per copy:**
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
9. **Leftover temp folder** from a manual test (harmless, nothing secret; the hook stops Claude deleting outside the
   repo; checked still there on 2026-11-21): `rm -r /var/folders/xf/zt8g4lzn0211myfvc6kzmt0r0000gn/T/pipeline-e2e-p134is`

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

---

# History (kept from earlier runs; facts re-checked on 2026-11-21)

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
  Grant 5); a double tap on a Log button logs twice (decision 0021 accepts this).
- The company sort on /contacts (SQLite NOCASE) and the grouping on /companies (a collator) treat tabs and accents
  slightly differently; the Contacts search echoes the query in the page (escaped, as intended); the CSV export of a
  very large copy still needs `copies:export`.
- **Performance:** narrow the contact read in the brief and in the deal reads to the people the request needs, if the
  CPU items in Needs Grant 7 bite on a real copy.

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
