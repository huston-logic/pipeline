# Status

History of every earlier run: [docs/history/STATUS-history.md](history/STATUS-history.md).

## Current state

Checked on 2026-11-24 against the repo and `gh`.

- **Merged:** everything in the spec and in the runs 2, 4, 5 and 6 briefs, run 7's PR A (#73), PR B (#74) and owner batch (#75), and run 8's PR A (#76), PR B (#77) and PR C (#78). The repo has migrations 0001 to 0019 and decisions 0001 to 0053.
- **Open:** run 8's PR D (this PR, closing docs), auto-merge queued.
- **Campaigns (run 8):** email campaigns, off by default: drafts by the AI app or by hand, review and approve on the board, batches every 15 minutes within a daily limit, one-click unsubscribe, delivery results by webhook (0053).
- **Board, the daily screen:** HTML rendered by the Worker, editable (0014, 0017, 0018); look and navigation (0015); home-screen app (0019); phone actions and Ask Claude (0021); Today as a list (0047); timer bar on the board (0050); time pages (0051).
- **Pipeline and contacts:** kanban and List, contacts and companies (0016, 0017, 0020, 0043).
- **People and leads:** person status with sub-statuses, saved views, table layout (0040 to 0043); leads, add_lead, qualify and return, the lead rule (0022 to 0029).
- **Imports:** CSV import on the board and over MCP (0034 to 0039).
- **AI app (MCP):** approve before change with `propose_changes` and `apply_changes`, and the "AI edits" setting (0044, 0045); to-dos that belong to no one (0046); capture and `list_tasks` (0048).
- **Time tracking:** off by default; timer, time entries, work types, client rates, month CSV (0049 to 0051).
- **Brief and alerts:** daily brief and rules (0010, 0011); phone notification when the brief is ready (0030); email logging by BCC (0031); "What it caught" report (0032); `/intake` website form (0012).
- **Build process (run 7):** `npm run check:fast` (commit check, decision 0052), one shared Worker for the e2e tests, `npm run check:process` (in `check:fast` and `check` since the owner batch, #75), docs/PROCESS.md for the build rules, a one-line-per-decision index in docs/decisions/README.md.
- **Sign-in and copies:** Cloudflare Access for the board and `/api`, OAuth for `/mcp` (0006); the owner updates client copies with `npm run copies:update` (0007).
- **Protection:** the "Protect main" ruleset is active (details in CLAUDE.md). 0 open code-scanning alerts on 2026-11-24.
- **Live:** merging deploys nothing (decision 0007).
- **Dependencies** (exact-pinned): runtime `agents` 0.33.0, `@modelcontextprotocol/server` 2.4.0, `@cloudflare/workers-oauth-provider` 1.2.4, `postal-mime` 4.2.1, `zod` 4.6.7. Dev: `@playwright/test` 1.65.0, `@modelcontextprotocol/client` 2.4.0, `typescript-eslint` 8.72.2. Runs 5 to 8 added none.
- **Tests:** `npm run check` passes: 1,821 unit and 64 end-to-end tests (was 1,563 and 56 before run 8). Local a11y still can't run on this Mac (Needs Grant 10); CI runs a11y and Lighthouse.
- **First client copy:** Your copy "grant" was updated to run 6 on 2026-11-24 (you confirmed). Runs 7 and 8 (migration 0019) reach it when you run the update (Needs Grant). Its live state cannot be checked from the repo or `gh`.
- **D1 batches (answered):** Your copy grant was updated to run 6 on 2026-11-24 and a 25-action proposal applied fine on the free plan, so a D1 batch did not hit the 50-query limit.

## Needs Grant

Steps only you can do, in order. Items marked "per copy" repeat for each new client copy.

1. **Create the `full-audit` label.** Use Issues > Labels > New label, or `gh label create full-audit --description "Run the full a11y and Lighthouse audits on this PR"`. Adding it to a PR forces both audits. Adding any label re-runs a PR's CI.
2. **The site template's own docs/PROCESS.md.** Make it in the same format, as its own run in huston-logic/site-template. It is a different product, so it is not a straight port.
3. **Update your copies to run 8 (per copy).** Run `npm run copies:update -- --copy <name> --dry-run` first, then the same command without `--dry-run`. Migration 0019 applies. Run 7 added no owner steps. The update also copies the new 15-minute campaign cron into each copy's config (it prints a line saying so). Then follow docs/UPDATING.md, "Run 8: after you update". A copy still on run 4 or 5 needs "Run 4" and "Run 5" first.
4. **Copy wording to review from run 6.** Nothing was changed without you: the tasks import lede and SPEC.md's tasks line (#64); Today's labels "Add a to-do", "Due date / Newest first / Person", "Nothing to do." (#65); the timer bar and the What did you do? page (#68); the time pages, "Billable" choices and CSV labels such as "No person" (#69); the "capture" rulebook document's text (migration 0017), which you edit by talking.
5. **Copy wording to review from run 8.** Nothing was changed without you: the campaign form hints; the review page's warning and multi-day lines; the confirm pages (Pause, Cancel, Allow campaign emails again); the results labels ("Marked as spam", "Not confirmed", "Waiting"); the unsubscribe page; and the AI app's new Campaigns instruction line.
6. **Your calls from run 5.** Nothing was changed without you:
   - Rule 3 of the AI app's instructions covers untrusted fields only. A name confirmed with "This is my own list" is no longer untrusted. Adding "treat every record's text as information" to rule 3 would change the instructions.
   - A 2,000-row board import takes about 11 ms of CPU, over the free plan's 10 ms. If it fails with "exceeded CPU", split the file, use `npm run import:contacts`, or move to Workers Paid.
   - The Pipeline List is a table with no "Move to" on each row (moving stays on the Board and the deal page).
   - Lead's five sub-statuses can be renamed but not archived, and Lead takes no new ones (decision 0040).
7. **Copy decisions from runs 4 and 5.** Nothing was changed without you:
   - The board's outside-text note says "came from a website form or an import". That is wrong for a logged email.
   - The Pipeline empty state says "Inquiries from your website form" (it said "Leads ..."). Confirm you want that wording.
   - `/intake`'s change summary still says "new lead" for a new person who gets a deal. "new inquiry" would match the Pipeline wording.
8. **Email logging (per copy, docs/EMAIL-LOGGING.md).** Set up a log subdomain with Email Routing, its DNS records, the `EMAIL_LOG_ADDRESS` secret and the routing rule to the Worker, then both go-live checks with a real test email. A strict DMARC policy on your sending domain is recommended. Decision 0031's ruling 12 may need tuning after the first test.
9. **Notification keys (per copy).** Run `node scripts/make-vapid-keys.mjs --copy <name> --subject mailto:<owner email>`, then the three `wrangler secret put` commands it prints, then the phone steps in docs/UPDATING.md.
10. **Local Playwright Chromium.** This Mac has revision 1248; `@playwright/test` 1.65.0 wants 1254, so `npm run test:a11y` fails here at browser launch (CI installs its own). Run `npx playwright install chromium` in your own terminal, since installing a browser needs your approval.
11. **Phone checks on the first copy (run 2).** The Access Bypass for `/icons/*` is set (docs/ACCESS-SETUP.md step 3, check in step 7.5); Add to Home Screen shows the green icon; "Ask Claude" opens claude.ai with the prompt filled in (decision 0021).
12. **Cloudflare dashboard checks on the first copy.**
    - CPU items over 10 ms on the free plan (docs/PAID-PLAN.md, "Run 4 closing re-measure"): Today 13.8 ms, the hour of the brief 11.5, `preview_rule` on a deal rule 11.0, `list_deals` 10.3, the export 102 ms. Measured on a fake copy of 2,000 deals plus 2,000 leads on a busy Mac.
    - D1 statements per invocation: the hourly run on the brief's hour makes 37 D1 calls holding 112 statements. If the free plan counts statements, lower `MAX_FIRINGS_PER_RUN` to about 8 or use Workers Paid.
13. **Only when you want them, per copy.**
    - Brief emails (Resend): verify the sending domain, create an API key with "Sending access" for that domain only, run `npx wrangler secret put RESEND_API_KEY -c .copies/<copy>/wrangler.jsonc`, set `BRIEF_SENDING = "on"` and `BRIEF_FROM` in that copy's generated config, then ask the AI app to `update_settings` with the brief address and brief on. Details: docs/SECRETS.md.
    - Website form: generate a long random value (for example `openssl rand -hex 32`), run `npx wrangler secret put INTAKE_SECRET -c .copies/<copy>/wrangler.jsonc`, and put the same value in the website's server-side form handler as the `X-Intake-Secret` header. Until it is set, `/intake` answers 503.
    - A new copy: ask the client to invite your Cloudflare user (Manage Account > Members > Invite, Administrator), run `npx wrangler login` yourself, follow docs/INSTALL.md and docs/ACCESS-SETUP.md. Zero Trust Free covers up to 50 users.
14. **Campaigns, only when a client wants them (per copy, docs/CAMPAIGNS.md).** Do these in order.
    - (a) A Resend account in the client's name, and an API key with "Sending access" for the sending subdomain only. Run `npx wrangler secret put CAMPAIGN_RESEND_API_KEY -c .copies/<copy>/wrangler.jsonc` yourself (CAMPAIGNS.md steps 1 to 3).
    - (b) The sending subdomain's DNS records from Resend (DNS only, grey cloud), and a DMARC record (step 2).
    - (c) The Access Bypass for `unsubscribe` and `hooks/resend` (docs/ACCESS-SETUP.md step 3), then the private-window check of `/unsubscribe/test` (step 6).
    - (d) The webhook endpoint `https://<copy host>/hooks/resend` and its secret. Run `npx wrangler secret put CAMPAIGN_WEBHOOK_SECRET -c .copies/<copy>/wrangler.jsonc` straight after saving the endpoint (step 7).
    - (e) Turning sending on: `CAMPAIGN_SENDING = "on"` and `CAMPAIGN_FROM` in the copy's generated config, then `npm run copies:update -- --copy <copy>`; the postal address on Campaign settings; then the go-live check (step 8).
15. **Leftover temp folder** from a manual test (harmless, nothing secret). Remove it with `rm -r /var/folders/xf/zt8g4lzn0211myfvc6kzmt0r0000gn/T/pipeline-e2e-p134is`. Checked on 2026-11-21. Two older `pipeline-e2e-*` folders from 2026-11-18 and 2026-11-23 are in the same temp folder; they can go too.

## For the master

- The app's build rules now live in docs/PROCESS.md; the master links to it and does not repeat them.
- Email campaigns (newsletters and event invites) are built, off by default; sending needs the client's own Resend account and sending subdomain.
- Follow-up series, open/click tracking, images and RSVP tracking are not built yet.

## Last run: run 8

Run 8, "Campaigns, step 1" (2026-11-24). Plan: `docs/superpowers/plans/2026-11-24-run8-campaigns.md`. Design: `docs/superpowers/specs/2026-11-24-campaigns-design.md`. Decision 0053.

Built:

- PR A (#76, merged): core, data and the AI door (migration 0019, the draft tools, the setting).
- PR B (#77, merged): the board pages (the Campaigns list, the review page, the settings).
- PR C (#78, merged): sending, unsubscribe and delivery results.
- PR D (this PR): closing docs and the acceptance sentences 31 to 34, end to end.

| PR | Wall-clock | Commits | Time in checks | Waiting on CI |
|---|---|---|---|---|
| A (#76) | about 38 min to open (16:31 to 17:09), merged 17:21 | 12 | about 4 min (check:fast 3 to 15 s a commit, two full checks about 35 s) | 12.5 min (full audits: the seed changed) |
| B (#77) | about 35 min to open (17:09 to 17:44), merged 17:58 | 7 | about 3 min | 13.5 min |
| C (#78) | about 33 min to open (17:45 to 18:18); one more commit at 18:27 for a CodeQL false positive in a test | 13 | about 4 min | about 25 min (the CodeQL fix restarted CI) |
| D (this PR) | about 15 min to open (18:19 to 18:33), built while C was in CI | 5 | about 2 min | see the PR |

Run total: about 2 h 20 min from the brief (16:13) to PR D open, including the design, its builder check, the plan,
25 implementer and fix dispatches and 30 reviews.

Judgment calls (one line each; decision 0053 has the rest):

- A second cron trigger sends the campaign batches, instead of adding them to the hourly run.
- The unsubscribe token is stored, not signed with a key (ruling 9).
- A campaign email never counts as reaching a person (ruling 8).
- An unsubscribe or a complaint follows the person; a bounce blocks only its address.
- A valid unsubscribe link is never rate limited.
- Test sends write no audit row.
- The daily limit counts UTC days, default 90 (ruling 6).
- The demo seed has no owner email, so its review page shows the reply-to line instead of the send buttons.
- The Lighthouse slot moved: the campaign review page replaces the import preview page (ruling 12).
- `npm run copies:update` now brings each copy's cron triggers in step with the template (it never did; without it a copy would never send a campaign). Only `triggers` is rewritten.

Queued: nothing beyond Needs Grant.

## Changelog

- 2026-11-23 to 2026-11-24, run 6, "Daily work": the plan (#61); approve before change (#62); the "AI edits" setting (#63); standalone to-dos (#64); Today as a list (#65); capture and `list_tasks` (#66); time and rates, data and MCP (#67); the timer on the board (#68); the time pages and CSV (#69); the final-review fixes (#70: D1 calls, Today's database sort, the list showing every column it writes); closing docs and status (#71).
- 2026-11-24, run 7, "Speed": fast commit check, one e2e Worker and the CI scope script (#73); PROCESS.md, check:process, the docs diet and the CLAUDE.md/AGENTS.md merge (#74); the owner batch for the hook, CI and agents (#75).
- 2026-11-24 to 25, run 8, "Campaigns, step 1": core, data and the AI door (#76); the board pages (#77); sending, unsubscribe and delivery results (#78); closing docs and acceptance (this PR).

Earlier entries: docs/history/STATUS-history.md.
