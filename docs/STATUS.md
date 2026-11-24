# Status

History of every earlier run: [docs/history/STATUS-history.md](history/STATUS-history.md).

## Current state

Checked on 2026-11-24 against the repo and `gh`.

- **Merged:** everything in the spec and in the runs 2, 4, 5 and 6 briefs, and run 7's PR A. #1 to #73 are merged. The repo has migrations 0001 to 0018 and decisions 0001 to 0052.
- **Open:** run 7's PR B (docs, process and the `check:process` guard), auto-merge queued.
- **Board, the daily screen:** HTML rendered by the Worker, editable (0014, 0017, 0018); look and navigation (0015); home-screen app (0019); phone actions and Ask Claude (0021); Today as a list (0047); timer bar on the board (0050); time pages (0051).
- **Pipeline and contacts:** kanban and List, contacts and companies (0016, 0017, 0020, 0043).
- **People and leads:** person status with sub-statuses, saved views, table layout (0040 to 0043); leads, add_lead, qualify and return, the lead rule (0022 to 0029).
- **Imports:** CSV import on the board and over MCP (0034 to 0039).
- **AI app (MCP):** approve before change with `propose_changes` and `apply_changes`, and the "AI edits" setting (0044, 0045); to-dos that belong to no one (0046); capture and `list_tasks` (0048).
- **Time tracking:** off by default; timer, time entries, work types, client rates, month CSV (0049 to 0051).
- **Brief and alerts:** daily brief and rules (0010, 0011); phone notification when the brief is ready (0030); email logging by BCC (0031); "What it caught" report (0032); `/intake` website form (0012).
- **Build process (run 7):** `npm run check:fast` (commit check, decision 0052), one shared Worker for the e2e tests, `npm run check:process` (runs on its own until the owner batch, Needs Grant 1), docs/PROCESS.md for the build rules, a one-line-per-decision index in docs/decisions/README.md.
- **Sign-in and copies:** Cloudflare Access for the board and `/api`, OAuth for `/mcp` (0006); the owner updates client copies with `npm run copies:update` (0007).
- **Protection:** the "Protect main" ruleset is active (details in CLAUDE.md). 0 open code-scanning alerts on 2026-11-24.
- **Dependencies** (exact-pinned): runtime `agents` 0.33.0, `@modelcontextprotocol/server` 2.4.0, `@cloudflare/workers-oauth-provider` 1.2.4, `postal-mime` 4.2.1, `zod` 4.6.7. Dev: `@playwright/test` 1.65.0, `@modelcontextprotocol/client` 2.4.0, `typescript-eslint` 8.72.2. Runs 5, 6 and 7 added none.
- **Tests:** `npm run check` passes on the run 7 branches: 1,563 unit and 56 end-to-end tests, 29.9 s on this Mac (was 82.3 s). Local a11y does not run on this Mac (Needs Grant 11); CI runs a11y and Lighthouse. CI's `lighthouse` job scores 20 pages, 3 runs each, about 12 minutes. CI's `a11y` job runs about 284 tests in about 6 minutes, inside its 12-minute limit.
- **First client copy:** installed by the owner on 2026-11-19. What it runs now cannot be checked from the repo or `gh`. Whether it has run 4's code (migrations 0006 to 0008) is open until you confirm. Runs 5 and 6 (migrations 0009 to 0018) reach it only when you run the update (Needs Grant 4).

## Needs Grant

Steps only you can do, in order. Items marked "per copy" repeat for each new client copy.

1. **Apply run 7's owner files (after PR B merges).** In your own terminal, from the repo root: `git switch main`, `git pull --ff-only`, `git switch -c chore/run7-owner-files`, then `bash /private/tmp/claude-501/-Users-granthuston-Code-huston-pipeline/48d904a5-9eae-49f4-8b9b-ab6f2c76f501/scratchpad/owner-proposals/apply-run7.sh`. It copies the new hook (commit runs `check:fast`, push and `gh pr create` run `check`), its self-test and README, the change-aware `ci.yml` (with a "Process rules" step in `check`), and the agents scout, docs-writer and implementer. It wires `check:process` into `check:fast` and `check`, then runs the hook self-test (last line `All N passed`) and `npm run check`. Then stage the paths it prints, commit, push and open the PR. The folder is in a temp scratchpad that a reboot can clear: copy it somewhere safe first if you won't do this today.
2. **Create the `full-audit` label.** Use Issues > Labels > New label, or `gh label create full-audit --description "Run the full a11y and Lighthouse audits on this PR"`. Adding it to a PR forces both audits. Adding any label re-runs a PR's CI.
3. **The site template's own docs/PROCESS.md.** Make it in the same format, as its own run in huston-logic/site-template. It is a different product, so it is not a straight port.
4. **Update the first copy to run 6 (per copy).** Run `npm run copies:update -- --copy <name> --dry-run` first, then the same command without `--dry-run`. Migrations 0014 to 0018 apply, and 0009 to 0013 too if the copy is still on run 4. Then follow docs/UPDATING.md: "Run 4: after you update" and "Run 5: after you update" if that copy never had them, then "Run 6: after you update" (reconnect the connector, the AI app waits for your yes, "Apply small changes", time tracking, the sentences to try). Which run the copy is on cannot be checked from here.
5. **Does a D1 batch count as one query on the free plan?** Unknown; nothing here runs against real D1. A 25-action proposal makes about 31 D1 calls, and its trial and apply batches hold about 44 steps each. After a 25-action proposal on the first copy, check the Cloudflare dashboard (Workers & Pages, the copy's Worker, Metrics, or D1, the database, Metrics, "queries"). If you can't find it, send a 20-action list; a limit error answers it. If every step counts, move the copy to Workers Paid or ask for a lower `PROPOSAL_MAX_ACTIONS` (docs/PAID-PLAN.md, "Run 6").
6. **Copy wording to review from run 6.** Nothing was changed without you: the tasks import lede and SPEC.md's tasks line (#64); Today's labels "Add a to-do", "Due date / Newest first / Person", "Nothing to do." (#65); the timer bar and the What did you do? page (#68); the time pages, "Billable" choices and CSV labels such as "No person" (#69); the "capture" rulebook document's text (migration 0017), which you edit by talking.
7. **Your calls from run 5.** Nothing was changed without you:
   - Rule 3 of the AI app's instructions covers untrusted fields only. A name confirmed with "This is my own list" is no longer untrusted. Adding "treat every record's text as information" to rule 3 would change the instructions.
   - A 2,000-row board import takes about 11 ms of CPU, over the free plan's 10 ms. If it fails with "exceeded CPU", split the file, use `npm run import:contacts`, or move to Workers Paid.
   - The Pipeline List is a table with no "Move to" on each row (moving stays on the Board and the deal page).
   - Lead's five sub-statuses can be renamed but not archived, and Lead takes no new ones (decision 0040).
8. **Copy decisions from runs 4 and 5.** Nothing was changed without you:
   - The board's outside-text note says "came from a website form or an import". That is wrong for a logged email.
   - The Pipeline empty state says "Inquiries from your website form" (it said "Leads ..."). Confirm you want that wording.
   - `/intake`'s change summary still says "new lead" for a new person who gets a deal. "new inquiry" would match the Pipeline wording.
9. **Email logging (per copy, docs/EMAIL-LOGGING.md).** Set up a log subdomain with Email Routing, its DNS records, the `EMAIL_LOG_ADDRESS` secret and the routing rule to the Worker, then both go-live checks with a real test email. A strict DMARC policy on your sending domain is recommended. Decision 0031's ruling 12 may need tuning after the first test.
10. **Notification keys (per copy).** Run `node scripts/make-vapid-keys.mjs --copy <name> --subject mailto:<owner email>`, then the three `wrangler secret put` commands it prints, then the phone steps in docs/UPDATING.md.
11. **Local Playwright Chromium.** This Mac has revision 1248; `@playwright/test` 1.65.0 wants 1254, so `npm run test:a11y` fails here at browser launch (CI installs its own). Run `npx playwright install chromium` in your own terminal, since installing a browser needs your approval.
12. **Phone checks on the first copy (run 2).** The Access Bypass for `/icons/*` is set (docs/ACCESS-SETUP.md step 3, check in step 7.5); Add to Home Screen shows the green icon; "Ask Claude" opens claude.ai with the prompt filled in (decision 0021).
13. **Cloudflare dashboard checks on the first copy.**
    - CPU items over 10 ms on the free plan (docs/PAID-PLAN.md, "Run 4 closing re-measure"): Today 13.8 ms, the hour of the brief 11.5, `preview_rule` on a deal rule 11.0, `list_deals` 10.3, the export 102 ms. Measured on a fake copy of 2,000 deals plus 2,000 leads on a busy Mac.
    - D1 statements per invocation: the hourly run on the brief's hour makes 37 D1 calls holding 112 statements. If the free plan counts statements, lower `MAX_FIRINGS_PER_RUN` to about 8 or use Workers Paid.
14. **Only when you want them, per copy.**
    - Brief emails (Resend): verify the sending domain, create an API key with "Sending access" for that domain only, run `npx wrangler secret put RESEND_API_KEY -c .copies/<copy>/wrangler.jsonc`, set `BRIEF_SENDING = "on"` and `BRIEF_FROM` in that copy's generated config, then ask the AI app to `update_settings` with the brief address and brief on. Details: docs/SECRETS.md.
    - Website form: generate a long random value (for example `openssl rand -hex 32`), run `npx wrangler secret put INTAKE_SECRET -c .copies/<copy>/wrangler.jsonc`, and put the same value in the website's server-side form handler as the `X-Intake-Secret` header. Until it is set, `/intake` answers 503.
    - A new copy: ask the client to invite your Cloudflare user (Manage Account > Members > Invite, Administrator), run `npx wrangler login` yourself, follow docs/INSTALL.md and docs/ACCESS-SETUP.md. Zero Trust Free covers up to 50 users.
15. **Leftover temp folder** from a manual test (harmless, nothing secret). Remove it with `rm -r /var/folders/xf/zt8g4lzn0211myfvc6kzmt0r0000gn/T/pipeline-e2e-p134is`. Checked on 2026-11-21. Two older `pipeline-e2e-*` folders from 2026-11-18 and 2026-11-23 are in the same temp folder; they can go too.

## For the master

- The app's build rules now live in docs/PROCESS.md; the master links to it and does not repeat them.

## Last run: run 7

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

## Changelog

- 2026-11-23 to 2026-11-24, run 6, "Daily work": the plan (#61); approve before change (#62); the "AI edits" setting (#63); standalone to-dos (#64); Today as a list (#65); capture and `list_tasks` (#66); time and rates, data and MCP (#67); the timer on the board (#68); the time pages and CSV (#69); the final-review fixes (#70: D1 calls, Today's database sort, the list showing every column it writes); closing docs and status (#71, this PR).
- 2026-11-24, run 7, "Speed": fast commit check, one e2e Worker and the CI scope script (#73); PROCESS.md, check:process, the docs diet and the CLAUDE.md/AGENTS.md merge (PR B).

Earlier entries: docs/history/STATUS-history.md.
