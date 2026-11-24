# Status

History of every earlier run: [docs/history/STATUS-history.md](history/STATUS-history.md).

## Current state

Checked on 2026-11-24 from the run 6 ledger and `gh`.

- **Merged:** everything in the spec and in the runs 2, 4, 5 and 6 briefs. #1 to #69 are merged. The repo has migrations 0001 to 0018 and decisions 0001 to 0051.
- **Open on 2026-11-24:** #70 (final-review fixes, auto-merge queued) and #71 (closing docs, ready for auto-merge).
- **Board, the daily screen:** HTML rendered by the Worker, editable (0014, 0017, 0018); look and navigation (0015); home-screen app (0019); phone actions and Ask Claude (0021); Today as a list (0047); timer bar on the board (0050); time pages (0051).
- **Pipeline and contacts:** kanban and List, contacts and companies (0016, 0017, 0020, 0043).
- **People and leads:** person status with sub-statuses, saved views, table layout (0040 to 0043); leads, add_lead, qualify and return, the lead rule (0022 to 0029).
- **Imports:** CSV import on the board and over MCP (0034 to 0039).
- **AI app (MCP):** approve before change with `propose_changes` and `apply_changes`, and the "AI edits" setting (0044, 0045); to-dos that belong to no one (0046); capture and `list_tasks` (0048).
- **Time tracking:** off by default; timer, time entries, work types, client rates, month CSV (0049 to 0051).
- **Brief and alerts:** daily brief and rules (0010, 0011); phone notification when the brief is ready (0030); email logging by BCC (0031); "What it caught" report (0032); `/intake` website form (0012).
- **Sign-in and copies:** Cloudflare Access for the board and `/api`, OAuth for `/mcp` (0006); the owner updates client copies with `npm run copies:update` (0007).
- **Protection:** the "Protect main" ruleset is active (details in CLAUDE.md). 0 open code-scanning alerts on 2026-11-24.
- **Dependencies** (exact-pinned): runtime `agents` 0.33.0, `@modelcontextprotocol/server` 2.4.0, `@cloudflare/workers-oauth-provider` 1.2.4, `postal-mime` 4.2.1, `zod` 4.6.7. Dev: `@playwright/test` 1.65.0, `@modelcontextprotocol/client` 2.4.0, `typescript-eslint` 8.72.2. Runs 5 and 6 added none.
- **Tests:** `npm run check` passes on the run 6 branches: 1,512 unit and 56 end-to-end tests. Local a11y does not run on this Mac (Needs Grant 8); CI runs a11y and Lighthouse. CI's `lighthouse` job scores 20 pages, 3 runs each, about 12 minutes. CI's `a11y` job runs about 284 tests in about 6 minutes, inside its 12-minute limit.
- **First client copy:** installed by the owner on 2026-11-19. What it runs now cannot be checked from the repo or `gh`. Whether it has run 4's code (migrations 0006 to 0008) is open until you confirm. Runs 5 and 6 (migrations 0009 to 0018) reach it only when you run the update (Needs Grant 1).

## Needs Grant

Steps only you can do, in order. Items marked "per copy" repeat for each new client copy.

1. **Update the first copy to run 6 (per copy).** Run `npm run copies:update -- --copy <name> --dry-run` first, then the same command without `--dry-run`. Migrations 0014 to 0018 apply, and 0009 to 0013 too if the copy is still on run 4. Then follow docs/UPDATING.md: "Run 4: after you update" and "Run 5: after you update" if that copy never had them, then "Run 6: after you update" (reconnect the connector, the AI app waits for your yes, "Apply small changes", time tracking, the sentences to try). Which run the copy is on cannot be checked from here.
2. **Does a D1 batch count as one query on the free plan?** Unknown; nothing here runs against real D1. A 25-action proposal makes about 31 D1 calls, and its trial and apply batches hold about 44 steps each. After a 25-action proposal on the first copy, check the Cloudflare dashboard (Workers & Pages, the copy's Worker, Metrics, or D1, the database, Metrics, "queries"). If you can't find it, send a 20-action list; a limit error answers it. If every step counts, move the copy to Workers Paid or ask for a lower `PROPOSAL_MAX_ACTIONS` (docs/PAID-PLAN.md, "Run 6").
3. **Copy wording to review from run 6.** Nothing was changed without you: the tasks import lede and SPEC.md's tasks line (#64); Today's labels "Add a to-do", "Due date / Newest first / Person", "Nothing to do." (#65); the timer bar and the What did you do? page (#68); the time pages, "Billable" choices and CSV labels such as "No person" (#69); the "capture" rulebook document's text (migration 0017), which you edit by talking.
4. **Your calls from run 5.** Nothing was changed without you:
   - Rule 3 of the AI app's instructions covers untrusted fields only. A name confirmed with "This is my own list" is no longer untrusted. Adding "treat every record's text as information" to rule 3 would change the instructions.
   - A 2,000-row board import takes about 11 ms of CPU, over the free plan's 10 ms. If it fails with "exceeded CPU", split the file, use `npm run import:contacts`, or move to Workers Paid.
   - The Pipeline List is a table with no "Move to" on each row (moving stays on the Board and the deal page).
   - Lead's five sub-statuses can be renamed but not archived, and Lead takes no new ones (decision 0040).
5. **Copy decisions from runs 4 and 5.** Nothing was changed without you:
   - The board's outside-text note says "came from a website form or an import". That is wrong for a logged email.
   - The Pipeline empty state says "Inquiries from your website form" (it said "Leads ..."). Confirm you want that wording.
   - `/intake`'s change summary still says "new lead" for a new person who gets a deal. "new inquiry" would match the Pipeline wording.
6. **Email logging (per copy, docs/EMAIL-LOGGING.md).** Set up a log subdomain with Email Routing, its DNS records, the `EMAIL_LOG_ADDRESS` secret and the routing rule to the Worker, then both go-live checks with a real test email. A strict DMARC policy on your sending domain is recommended. Decision 0031's ruling 12 may need tuning after the first test.
7. **Notification keys (per copy).** Run `node scripts/make-vapid-keys.mjs --copy <name> --subject mailto:<owner email>`, then the three `wrangler secret put` commands it prints, then the phone steps in docs/UPDATING.md.
8. **Local Playwright Chromium.** This Mac has revision 1248; `@playwright/test` 1.65.0 wants 1254, so `npm run test:a11y` fails here at browser launch (CI installs its own). Run `npx playwright install chromium` in your own terminal, since installing a browser needs your approval.
9. **Phone checks on the first copy (run 2).** The Access Bypass for `/icons/*` is set (docs/ACCESS-SETUP.md step 3, check in step 7.5); Add to Home Screen shows the green icon; "Ask Claude" opens claude.ai with the prompt filled in (decision 0021).
10. **Cloudflare dashboard checks on the first copy.**
    - CPU items over 10 ms on the free plan (docs/PAID-PLAN.md, "Run 4 closing re-measure"): Today 13.8 ms, the hour of the brief 11.5, `preview_rule` on a deal rule 11.0, `list_deals` 10.3, the export 102 ms. Measured on a fake copy of 2,000 deals plus 2,000 leads on a busy Mac.
    - D1 statements per invocation: the hourly run on the brief's hour makes 37 D1 calls holding 112 statements. If the free plan counts statements, lower `MAX_FIRINGS_PER_RUN` to about 8 or use Workers Paid.
11. **Only when you want them, per copy.**
    - Brief emails (Resend): verify the sending domain, create an API key with "Sending access" for that domain only, run `npx wrangler secret put RESEND_API_KEY -c .copies/<copy>/wrangler.jsonc`, set `BRIEF_SENDING = "on"` and `BRIEF_FROM` in that copy's generated config, then ask the AI app to `update_settings` with the brief address and brief on. Details: docs/SECRETS.md.
    - Website form: generate a long random value (for example `openssl rand -hex 32`), run `npx wrangler secret put INTAKE_SECRET -c .copies/<copy>/wrangler.jsonc`, and put the same value in the website's server-side form handler as the `X-Intake-Secret` header. Until it is set, `/intake` answers 503.
    - A new copy: ask the client to invite your Cloudflare user (Manage Account > Members > Invite, Administrator), run `npx wrangler login` yourself, follow docs/INSTALL.md and docs/ACCESS-SETUP.md. Zero Trust Free covers up to 50 users.
12. **Leftover temp folder** from a manual test (harmless, nothing secret). Remove it with `rm -r /var/folders/xf/zt8g4lzn0211myfvc6kzmt0r0000gn/T/pipeline-e2e-p134is`. Checked on 2026-11-21.

## For the master

- (run 7 fills this in)

## Last run: run 6

Run 6, "Daily work" (2026-11-23 to 2026-11-24). Plan: `docs/superpowers/plans/2026-11-24-run6-daily-work.md` (PR #61, merged). Approve before change, to-dos like a list, capture through the AI app, timer and time entries with billing rates.

Built, one PR each:

- A1 proposals, `propose_changes` and `apply_changes` (0044, migration 0014): #62, merged.
- A2 the "AI edits" setting (0045, migration 0015): #63, merged.
- B3 standalone to-dos (0046, migration 0016): #64, merged.
- B4 Today works like a list (0047): #65, merged.
- C5 capture and `list_tasks` (0048, migration 0017): #66, merged.
- D6 time and rates, data and MCP (0049, migration 0018): #67, merged.
- D7 the timer on the board (0050): #68, merged.
- D8 time pages and CSV (0051): #69, merged.
- Final-review fixes (D1 calls, Today sorted in SQL, the list shows every column a row writes): #70, open, auto-merge queued.
- E9 closing docs and status: #71, open, ready for auto-merge.

Every task had an independent review before its PR (A1 also a security review; B4, D7 and D8 an accessibility review). The final review found one Critical item, the D1 call count, and #70 closed it: a 25-action list went from 158 to 31 D1 calls, and apply from 88 to 30.

CI on the way: #69's `a11y` job hit Playwright's 5-minute limit. The suite grew to about 284 tests. Two pages at 375 px were also 797 px wide, because the screen-reader-only "Edit" text in the new tables escaped the table's scroll box. One CSS line fixed the width, and the limit went to 12 minutes. You confirmed the 12 minutes on 2026-11-24.

Judgment calls (the full list, with costs, is in the history file):

- The brief was treated as an autonomous run, so auto-merge after review.
- A proposal expires after 2 hours, holds at most 25 actions, and at most 10 wait at once (the oldest is dropped).
- `apply_changes` refuses if a record changed since the list was made.
- "Apply small changes" applies at once only a logged call or note on an existing record, a ticked task, and starting or stopping a timer without a next-step date.
- There is no second owner confirmation inside `apply_changes`; the AI app must ask you. Cost: injected text could still propose and apply.
- A per-client rate is per person (a contact), not per company. Time tracking is off by default.
- Today shows 50 to-dos per list, with no show-all.
- The 40-call bound is proven only for the tested action mixes.

Queued, not done:

- Run 6 minor findings (none blocks use) are listed in the history file.
- Needs Grant 1 to 3 and 10: updating the first copy, the D1 count, copy wording, and the dashboard checks.

## Changelog

- 2026-11-23, CI: the `lighthouse` job scores at most 20 pages, 3 runs each, and retries pages whose runs crashed with Chrome's `NO_NAVSTART` (#59); a CodeQL alert in a table test helper fixed in #57; status brought up to date (#60).
- 2026-11-23 to 2026-11-24, run 6, "Daily work": the plan (#61); approve before change (#62); the "AI edits" setting (#63); standalone to-dos (#64); Today as a list (#65); capture and `list_tasks` (#66); time and rates, data and MCP (#67); the timer on the board (#68); the time pages and CSV (#69); the final-review fixes (#70: D1 calls, Today's database sort, the list showing every column it writes); closing docs and status (#71, this PR).

Earlier entries: docs/history/STATUS-history.md.
