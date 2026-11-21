# Autonomous run status

Spec: `docs/SPEC.md`. Plan: `docs/PLAN.md`. Rules: CLAUDE.md, "Autonomous runs". Run 1 started 2026-11-18.
Updated after every merge, so a fresh chat can pick up where the last one stopped.

## Run 4 (2026-11-20)

People and leads, then the "it comes to you" items (docs/PLAN.md, "Run 4"; decision 0022; plan
`docs/superpowers/plans/2026-11-20-run4-leads.md`). Updated in this first PR and in the closing PR of the run.

The live install of the first copy was done on 2026-11-19 by the owner, so a real copy now runs this code; its lessons
are task E1.

| # | Task | PR | State |
| --- | --- | --- | --- |
| T0 | Record the design | this PR | |
| E1 | Install lessons | | |
| L1 to L9 | People and leads | | |
| B1 | What it caught | | |
| C1 | Email logging | | |
| D1 | Brief notification | | |
| E2 | After you update | | |

## Run 3 (2026-11-19)

Short run: land run 2's last two PRs once the owner merged the CI timeout fix and the owner-only proposals
([#26](https://github.com/huston-logic/pipeline/pull/26), run 2 STOP 1 and 2).

| Task | PR | State |
| --- | --- | --- |
| R4 Editing, updated from main | [#22](https://github.com/huston-logic/pipeline/pull/22) | merged (squash); all checks passed, lighthouse within the new timeout |
| R5 Phone actions, updated from main and marked ready | [#24](https://github.com/huston-logic/pipeline/pull/24) | merged (squash); reviewed (no critical or important findings), all checks passed |
| Status | this PR | |

Ruling: #24 was stacked on #22, so after #22's squash merge the update from main conflicted in five files where R5
had edited R4's lines. R5's side was kept (it already held all of #22); the merged tree was checked to differ from
R5's tip by exactly main's other changes (#23, #25, #26), and `npm run check` passed (735 unit, 32 e2e).

## Run 2 (2026-11-18 to 2026-11-19)

The board becomes the owner's daily screen (docs/PLAN.md, "Run 2"; decision 0014). Updated in the first and the
closing PR of the run.

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

### Dependencies added in run 2

None.

### STOP queue added in run 2 (needs the owner)

1. ~~CI lighthouse timeout~~: done in #26 (35-minute timeout); #22 and #24 then passed.
2. ~~Owner-only proposals~~: done in #26 (reviewer agents, three skills, guard-bash message).
3. **Access bypass for `/icons/*`, per copy (dashboard).** Phones fetch home-screen icons without cookies
   (docs/ACCESS-SETUP.md step 3, check in step 7.5).
4. **Check on your phone at the first install:** Add to Home Screen shows the green icon; "Ask Claude" opens claude.ai
   with the prompt filled in (`claude.ai/new?q=` is how claude.ai behaves today, not a documented API; 0021).
5. **D1 statement count per invocation** (from run 1, still open): the hourly run on the brief's hour makes 37 D1 calls
   holding 112 statements. If the free plan counts statements, lower `MAX_FIRINGS_PER_RUN` to about 8 or use Workers
   Paid (docs/PAID-PLAN.md).
6. **Local Playwright Chromium** (run 1 STOP 2, still open): `npm run test:a11y` does not run on this Mac. The new
   `npm run screenshots` runs axe with the installed Google Chrome meanwhile.

Screenshots of every board page at 375 and 1280 px: `.owner-review/screenshots/` (git-ignored, this Mac only;
`npm run build` then `npm run screenshots` to refresh).

## Run 1 tasks

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

Run 1 finished on 2026-11-18: every milestone in the spec is built, reviewed and merged. What is left needs a real
Cloudflare account or the owner (see "STOP queue" and "What's left").

## Decisions

Files in `docs/decisions/`. Rulings made while running the plan:

- Work happens in the main checkout, one branch and PR per task, each from a fresh `main` (no worktrees).
- Task 4 will use the MCP SDK v2 packages (`@modelcontextprotocol/server` 2.4.0) instead of `@modelcontextprotocol/sdk`
  1.x: the current Cloudflare docs say `createMcpHandler` (`agents/mcp/server`) serves an SDK v2 server built by a
  factory per request, and `agents` 0.33.0 requires server 2.4.0 exactly.
- Decision numbers 0004–0007 are reserved for tasks 4, 5, 10 and 11 (see PLAN.md); task 2 used 0008, task 3 0009.
- Outside text never reaches a summary, headline or error message: records whose text came from outside are named by
  id ("contact ct_…"). Deals and tasks gained `untrusted_fields` (migration 0002) so this works for every record, not
  only contacts. Plan task 7's briefs migration becomes 0003.
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
- The board is server-rendered with no client JavaScript; outside text shows a "From outside" label. CSV export
  guards spreadsheet formulas by prefixing `'` (decision 0013, which also lists three design defaults for you to
  look at).
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

## Dependencies added

- `typescript-eslint` 8.72.2 (dev, exact; replaces `eslint-config-next`). PR #2.
- Removed: `next`, `react`, `react-dom`, `tailwindcss`, `@tailwindcss/turbopack`, `eslint-config-next`,
  `@types/react`, `@types/react-dom`. PR #2.
- `agents` 0.33.0, `@modelcontextprotocol/server` 2.4.0, `zod` 4.6.7 (runtime, exact); `@modelcontextprotocol/client`
  2.4.0 (dev, exact; also a peer of `agents`). PR #5. Worker bundle about 0.24 MB gzip (free plan limit 3 MB).
- `@cloudflare/workers-oauth-provider` 1.2.4 (runtime, exact; no runtime dependencies of its own). PR #11.
- Every version was at least 7 days old; lockfiles written with npm 10.9.9 and `--before=2026-11-11T23:59:59Z`.

## STOP queue (needs the owner)

1. **CI cleanup (owner-only file).** `.github/workflows/ci.yml` still runs `npm run check:placeholders`
   (continue-on-error), a script that no longer exists, and two comments describe the old website. The proposed file is
   in the hand-copy batch (see the end of the run summary).
2. **Local Playwright browser is one revision behind.** This Mac has Chromium revision 1248; `@playwright/test`
   1.65.0 needs 1254, so `npm run test:a11y` fails locally at browser launch (CI installs its own and is fine). To fix,
   run `npx playwright install chromium` in your own terminal (installing a browser needs your approval).
3. **Brief emails (Resend), per copy, only when you want sending on.** Sending is off by default and nothing in the
   repo sends email. To turn it on for one copy: in Resend, verify the sending domain and create an API key with
   "Sending access" for that domain only; then, with that copy's wrangler config, run
   `npx wrangler secret put RESEND_API_KEY -c .copies/<copy>/wrangler.jsonc`, set the vars `BRIEF_SENDING = "on"` and
   `BRIEF_FROM = "Pipeline <brief@<your domain>>"` in that copy's generated config, and ask the AI to
   `update_settings` with the brief address (it must be one of the owner emails) and brief on. Details:
   docs/SECRETS.md.
4. **Intake secret, per copy, when you connect a website form.** Generate a long random value (for example
   `openssl rand -hex 32`), then `npx wrangler secret put INTAKE_SECRET -c .copies/<copy>/wrangler.jsonc`, and put the
   same value in the website's server-side form handler as the `X-Intake-Secret` header. Until it is set, `/intake`
   answers 503. README, "Connect a website form".
5. **Cloudflare Access, per copy (dashboard).** Follow `docs/ACCESS-SETUP.md`: create the Access for SaaS (OIDC) app
   for MCP and copy its five values into the `ACCESS_*` secrets; create the self-hosted app for the board with an Allow
   policy for the owner email(s) and One-time PIN; add the Bypass rules for `/intake`, `/mcp`, `/authorize`,
   `/callback`, `/token`, `/register` and `/.well-known/`; put the team domain and AUD tag into the copy's generated
   config. Steps marked "check in the dashboard" there could not be confirmed from the docs alone. Also: Zero Trust
   Free covers up to 50 users, so no paid plan is needed.
6. **First real copy (yours, when ready).** Everything is tested only with a stub; nothing has touched a real account.
   For the first copy: ask the client to invite your Cloudflare user to their account (Manage Account > Members >
   Invite, role Administrator), run `npx wrangler login` yourself, then follow `docs/INSTALL.md`
   (`npm run copies:provision -- --copy <name>`, then `npm run copies:update -- --copy <name> --dry-run`, then without
   `--dry-run`). Confirm on that first run: (a) `d1 create` / `kv namespace create` accept `--update-config=false`;
   (b) whether a remote `d1 execute --file` import is all-or-nothing (decision 0007); (c) the Access items marked
   "check in the dashboard" in ACCESS-SETUP.md and the id-token issuer (decision 0006).
7. **One leftover temp folder** from a manual test (harmless, nothing secret; the hook stops me deleting outside the
   repo): `rm -r /var/folders/xf/zt8g4lzn0211myfvc6kzmt0r0000gn/T/pipeline-e2e-p134is`

## What's left

After run 3, everything in the spec and the run 2 brief is built and merged. The live install on the first copy was
done on 2026-11-19 (run 1 STOP 5 and 6). Not yet proven, because it needs a real account or the owner:

1. The phone checks in run 2 STOP 3 and 4 (Access bypass for icons, Add to Home Screen, Ask Claude), if not already
   done on the first copy.
2. CPU on real hardware: run 2 measured on this Mac (docs/PAID-PLAN.md, "CPU check"). Confirm in the Cloudflare
   dashboard on the first copy, and settle the D1 statement-count question (run 2 STOP 5).
3. Minor review findings left from run 2 (none blocks use): the `/companies` page has no row cap (it is fast at 300
   companies); the Contacts search echoes the query in the page (escaped); the company sort on /contacts and the
   grouping on /companies treat tabs and accents slightly differently; the CSV export of a very large copy still needs
   `copies:export`.
4. Minor review findings on #24 (skipped in run 3 by the owner's choice; none blocks use): `ReachContact.untrusted_fields`
   in `src/board/reach.ts` is unused; a phone with a non-breaking space is refused with a note that doesn't say why
   (hidden character); board.js's focus move and Copy prompt are only text-checked, with no browser test; Ask Claude's
   "Prep me for this call" also shows on closed deals; a double tap on a Log button logs twice (0021 accepts this).

## How to resume

1. `git switch main && git pull --ff-only`
2. Read `docs/SPEC.md`, `docs/PLAN.md` (the "Run 2" table at the end) and this file; start from "What's left".
3. Run 2's shared brief for implementers and the owner's proposals and screenshots are in `.owner-review/`
   (git-ignored, this Mac only).
