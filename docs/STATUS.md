# Status

History of every earlier run: [docs/history/STATUS-history.md](history/STATUS-history.md).

## Current state

Checked on 2026-11-24 against the repo and `gh`.

- **Merged:** everything in the spec and in the runs 2, 4, 5 and 6 briefs, all of run 7 (#73, #74, #75) and all of run 8 (#76, #77, #78, #79). The repo has migrations 0001 to 0019 and decisions 0001 to 0054.
- **Open:** the managed hosting docs run (this PR, docs only), auto-merge queued.
- **Managed hosting (decision 0054):** every client copy is hosted in Grant's own Cloudflare account on Workers Paid, behind one Zero Trust organisation (the owner signs in as an allowed email). Email goes from the client's own domain through Grant's one Resend account. On request a copy moves to the client's own accounts (docs/OFFBOARDING.md, **not yet rehearsed**). Docs only: no code, test or check changed.
- **Campaigns (run 8):** email campaigns, off by default: drafts by the AI app or by hand, review and approve on the board, batches every 15 minutes within a daily limit, one-click unsubscribe, delivery results by webhook (0053).
- **Board, the daily screen:** HTML rendered by the Worker, editable (0014, 0017, 0018); look and navigation (0015); home-screen app (0019); phone actions and Ask Claude (0021); Today as a list (0047); timer bar on the board (0050); time pages (0051).
- **Pipeline and contacts:** kanban and List, contacts and companies (0016, 0017, 0020, 0043).
- **People and leads:** person status with sub-statuses, saved views, table layout (0040 to 0043); leads, add_lead, qualify and return, the lead rule (0022 to 0029).
- **Imports:** CSV import on the board and over MCP (0034 to 0039).
- **AI app (MCP):** approve before change with `propose_changes` and `apply_changes`, and the "AI edits" setting (0044, 0045); to-dos that belong to no one (0046); capture and `list_tasks` (0048).
- **Time tracking:** off by default; timer, time entries, work types, client rates, month CSV (0049 to 0051).
- **Brief and alerts:** daily brief and rules (0010, 0011); phone notification when the brief is ready (0030); email logging by BCC (0031); "What it caught" report (0032); `/intake` website form (0012).
- **Build process (run 7):** `npm run check:fast` (commit check, decision 0052), one shared Worker for the e2e tests, `npm run check:process`, docs/PROCESS.md for the build rules, a one-line-per-decision index in docs/decisions/README.md.
- **Sign-in and copies:** Cloudflare Access for the board and `/api`, OAuth for `/mcp` (0006); the owner updates copies with `npm run copies:update` (0007); copies live in the owner's account (0054).
- **Protection:** the "Protect main" ruleset is active (details in CLAUDE.md). 0 open code-scanning alerts on 2026-11-24.
- **Live:** merging deploys nothing (decision 0007).
- **Dependencies** (exact-pinned): runtime `agents` 0.33.0, `@modelcontextprotocol/server` 2.4.0, `@cloudflare/workers-oauth-provider` 1.2.4, `postal-mime` 4.2.1, `zod` 4.6.7. Dev: `@playwright/test` 1.65.0, `@modelcontextprotocol/client` 2.4.0, `typescript-eslint` 8.72.2. Runs 5 to 8 and this run added none.
- **Tests:** `npm run check` passes (27 s on 2026-11-24, 64 end-to-end tests). Local a11y still can't run on this Mac (Needs Grant 10); CI runs a11y and Lighthouse.
- **First copy:** your copy "grant" was updated to run 6 on 2026-11-24 (you confirmed). Runs 7 and 8 (migration 0019) reach it when you run the update (Needs Grant). Its live state, and which Cloudflare account holds it, cannot be checked from the repo or `gh`.

## Needs Grant

Steps only you can do, in order. Items marked "per copy" repeat for each new client copy.

1. **Create the `full-audit` label.** Use Issues > Labels > New label, or `gh label create full-audit --description "Run the full a11y and Lighthouse audits on this PR"`. Adding it to a PR forces both audits. Adding any label re-runs a PR's CI.
2. **The site template's own docs/PROCESS.md.** Make it in the same format, as its own run in huston-logic/site-template. It is a different product, so it is not a straight port.
3. **Update your copies to run 8 (per copy).** Run `npm run copies:update -- --copy <name> --dry-run` first, then the same command without `--dry-run`. Migration 0019 applies. Run 7 added no owner steps. The update also copies the new 15-minute campaign cron into each copy's config (it prints a line saying so). Then follow docs/UPDATING.md, "Run 8: after you update". A copy still on run 4 or 5 needs "Run 4" and "Run 5" first.
4. **Copy wording to review from run 6.** Nothing was changed without you: the tasks import lede and SPEC.md's tasks line (#64); Today's labels "Add a to-do", "Due date / Newest first / Person", "Nothing to do." (#65); the timer bar and the What did you do? page (#68); the time pages, "Billable" choices and CSV labels such as "No person" (#69); the "capture" rulebook document's text (migration 0017), which you edit by talking.
5. **Copy wording to review from run 8.** Nothing was changed without you: the campaign form hints; the review page's warning and multi-day lines; the confirm pages (Pause, Cancel, Allow campaign emails again); the results labels ("Marked as spam", "Not confirmed", "Waiting"); the unsubscribe page; and the AI app's new Campaigns instruction line.
6. **Your calls from run 5.** Nothing was changed without you:
   - Rule 3 of the AI app's instructions covers untrusted fields only. A name confirmed with "This is my own list" is no longer untrusted. Adding "treat every record's text as information" to rule 3 would change the instructions.
   - A 2,000-row board import takes about 11 ms of CPU, over the free plan's 10 ms. If it fails with "exceeded CPU", split the file, use `npm run import:contacts`, or move to Workers Paid (item 16 puts the hosting account there).
   - The Pipeline List is a table with no "Move to" on each row (moving stays on the Board and the deal page).
   - Lead's five sub-statuses can be renamed but not archived, and Lead takes no new ones (decision 0040).
7. **Copy decisions from runs 4 and 5.** Nothing was changed without you:
   - The board's outside-text note says "came from a website form or an import". That is wrong for a logged email.
   - The Pipeline empty state says "Inquiries from your website form" (it said "Leads ..."). Confirm you want that wording.
   - `/intake`'s change summary still says "new lead" for a new person who gets a deal. "new inquiry" would match the Pipeline wording.
8. **Email logging (per copy, docs/EMAIL-LOGGING.md).** Set up a log subdomain on the hosting domain with Email Routing, its DNS records, the `EMAIL_LOG_ADDRESS` secret and the routing rule to the Worker, then both go-live checks with a real test email. A strict DMARC policy on the sending domain of whoever BCCs the log is recommended. Decision 0031's ruling 12 may need tuning after the first test.
9. **Notification keys (per copy).** Run `node scripts/make-vapid-keys.mjs --copy <name> --subject mailto:<owner email>`, then the three `wrangler secret put` commands it prints, then the phone steps in docs/UPDATING.md.
10. **Local Playwright Chromium.** This Mac has revision 1248; `@playwright/test` 1.65.0 wants 1254, so `npm run test:a11y` fails here at browser launch (CI installs its own). Run `npx playwright install chromium` in your own terminal, since installing a browser needs your approval.
11. **Phone checks on the first copy (run 2).** The Access Bypass for `/icons/*` is set (docs/ACCESS-SETUP.md step 3, check in step 7.5); Add to Home Screen shows the green icon; "Ask Claude" opens claude.ai with the prompt filled in (decision 0021).
12. **Cloudflare dashboard checks on the first copy.**
    - CPU items over 10 ms on the free plan (docs/PAID-PLAN.md, "Run 4 closing re-measure"): Today 13.8 ms, the hour of the brief 11.5, `preview_rule` on a deal rule 11.0, `list_deals` 10.3, the export 102 ms. Measured on a fake copy of 2,000 deals plus 2,000 leads on a busy Mac. Moot once the account is on Workers Paid (item 16).
    - D1 statements per invocation: the hourly run on the brief's hour makes 37 D1 calls holding 112 statements. If the free plan counts statements, lower `MAX_FIRINGS_PER_RUN` to about 8 or use Workers Paid.
13. **Only when you want them, per copy.**
    - Brief emails (Resend): follow docs/INSTALL.md, "Sending email from the client's domain" (the client's subdomain in your Resend account, a key limited to it), run `npx wrangler secret put RESEND_API_KEY -c .copies/<copy>/wrangler.jsonc`, set `BRIEF_SENDING = "on"` and `BRIEF_FROM` in that copy's generated config, then ask the AI app to `update_settings` with the brief address and brief on. Details: docs/SECRETS.md.
    - Website form: generate a long random value (for example `openssl rand -hex 32`), run `npx wrangler secret put INTAKE_SECRET -c .copies/<copy>/wrangler.jsonc`, and put the same value in the website's server-side form handler as the `X-Intake-Secret` header. Until it is set, `/intake` answers 503.
    - A new copy: no invitation to ask for, since it goes in your own account (item 16). Run `npx wrangler login` yourself, follow docs/INSTALL.md and docs/ACCESS-SETUP.md. Count the owner emails against Zero Trust Free's 50 users first.
14. **Campaigns, only when a client wants them (per copy, docs/CAMPAIGNS.md).** Do these in order.
    - (a) The client's sending subdomain added to your Resend account (docs/INSTALL.md, "Sending email from the client's domain"), and an API key with "Sending access" for that subdomain only. Run `npx wrangler secret put CAMPAIGN_RESEND_API_KEY -c .copies/<copy>/wrangler.jsonc` yourself (CAMPAIGNS.md steps 1 to 3).
    - (b) The client adds the subdomain's DNS records from Resend (DNS only, grey cloud, if on Cloudflare), and a DMARC record (step 2).
    - (c) The Access Bypass for `unsubscribe` and `hooks/resend` (docs/ACCESS-SETUP.md step 3), then the private-window check of `/unsubscribe/test` (step 6).
    - (d) The webhook endpoint `https://<copy host>/hooks/resend` and its secret. Run `npx wrangler secret put CAMPAIGN_WEBHOOK_SECRET -c .copies/<copy>/wrangler.jsonc` straight after saving the endpoint (step 7).
    - (e) Turning sending on: `CAMPAIGN_SENDING = "on"` and `CAMPAIGN_FROM` in the copy's generated config, then `npm run copies:update -- --copy <copy>`; the postal address on Campaign settings; then the go-live check (step 8).
15. **Leftover temp folder** from a manual test (harmless, nothing secret). Remove it with `rm -r /var/folders/xf/zt8g4lzn0211myfvc6kzmt0r0000gn/T/pipeline-e2e-p134is`. Checked on 2026-11-21. Two older `pipeline-e2e-*` folders from 2026-11-18 and 2026-11-23 are in the same temp folder; they can go too.
16. **Before the first client copy: your Cloudflare and Resend accounts (decision 0054).** In order:
    - (a) Check which Cloudflare account holds your copy "grant" (this repo cannot tell). Every client copy goes in one hosting account.
    - (b) Put the hosting account on Workers Paid ($5 a month). Free allows 5 Cron Triggers and 10 D1 databases per account, and each copy uses 2 of each.
    - (c) Zero Trust: choose the team name once, on the Free plan. Free allows 50 users in total, every copy's owners included (Cloudflare's plans page, checked 2026-11-24). Keep the count in your private client records and decide when to move to Pay-as-you-go.
    - (d) Keep a hosting domain on Cloudflare in that account. Each copy answers on `<name>.<hosting domain>` and each email-log subdomain sits on it. A client's own domain cannot hold the Worker or its Access application (docs/INSTALL.md, step 1).
    - (e) Resend: one account on Pro ($20 a month). Pro allows 10 sending domains, one per client subdomain; an add-on gives more (check resend.com/pricing).
    - (f) Put both logins on passkeys or two-step sign-in. One account serving every client is one place to protect.
    - (g) Rehearse docs/OFFBOARDING.md once, on a fake copy and a second Cloudflare account. Decide whether to build a full-restore command (its step 6 "Gap": only people, deals and tasks import today) and how long an old copy stays up for unsubscribe links.
    - (h) Resend webhooks: check whether an endpoint can be limited to one sending domain. If not, every copy receives every client's delivery events and ignores the ones it does not know (decision 0054). Decide before the first client campaign.
    - (i) Read the managed hosting wording in docs/INSTALL.md, ACCESS-SETUP.md and OFFBOARDING.md. The fee and the client terms live in the master, not here.

## For the master

- The app's build rules now live in docs/PROCESS.md; the master links to it and does not repeat them.
- Email campaigns (newsletters and event invites) are built, off by default; sending needs a sending subdomain on the client's own domain in Grant's Resend account.
- Follow-up series, open/click tracking, images and RSVP tracking are not built yet.
- Pipeline docs describe managed hosting and offboarding.

## Last run: managed hosting (docs)

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

Queued: nothing beyond Needs Grant 16, and one small code change: `scripts/copies.mjs` still says "Ask the client to invite your Cloudflare user" (`notMember`) and "Which account is the client's?" (decision 0054 makes both wrong). Left alone because this run is docs only; INSTALL.md says the wording is old. Its tests need the same edit.

## Changelog

- 2026-11-23 to 2026-11-24, run 6, "Daily work": the plan (#61); approve before change (#62); the "AI edits" setting (#63); standalone to-dos (#64); Today as a list (#65); capture and `list_tasks` (#66); time and rates, data and MCP (#67); the timer on the board (#68); the time pages and CSV (#69); the final-review fixes (#70: D1 calls, Today's database sort, the list showing every column it writes); closing docs and status (#71).
- 2026-11-24, run 7, "Speed": fast commit check, one e2e Worker and the CI scope script (#73); PROCESS.md, check:process, the docs diet and the CLAUDE.md/AGENTS.md merge (#74); the owner batch for the hook, CI and agents (#75).
- 2026-11-24 to 25, run 8, "Campaigns, step 1": core, data and the AI door (#76); the board pages (#77); sending, unsubscribe and delivery results (#78); closing docs and acceptance (#79).
- 2026-11-24, "Managed hosting" docs run: decision 0054, the hosting and offboarding docs, a PROCESS.md rule (this PR).

Earlier entries: docs/history/STATUS-history.md.
