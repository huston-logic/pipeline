# Run 8 "Campaigns, step 1" Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`. Each task:
> failing tests first, then code, `npm run check:fast` passes, one commit, one Sonnet review.

**Goal:** Email campaigns (newsletters, event invites) drafted by the AI or by hand, sent only from the board.
**Architecture:** Three feature PRs and a closing PR, in order, each branched from `main` (build the next on the
previous tip while CI runs, rebase onto `main` after the squash merge, no force push). A `feat/campaigns-core`: data,
services, rendering, MCP door, spec and decision 0053. B `feat/campaigns-board`: every board page and action except
sending. C `feat/campaigns-sending`: Resend sender, campaign cron, test send, unsubscribe, webhook, setup docs.
D `docs/run8-closing`: acceptance, UPDATING, STATUS. Tech stack: existing only; no new dependencies.
**Spec:** `docs/superpowers/specs/2026-11-24-campaigns-design.md` (binding for this run; read the section a task names).
## Global Constraints
- AGENTS.md and CLAUDE.md hold. Every write through `commitChange`; markup through `html`; no `raw()` for data.
- No MCP tool sends, schedules, approves, pauses, cancels or clears a suppression. Tests mock `fetch`; never real email.
- Off by default: `settings.campaigns = 0`; every `/campaigns*` path 404 and every campaign tool refuses while off.
- Fake people only (`example.com`/`example.test`); no client keys, addresses or domains anywhere.
- New ids `cp`, `cs`, `rc`, `cb`, `su` (in `ID_PREFIXES`). Migration `0019_campaigns.sql`, forward-only.
- Board copy plain and short, no claims the spec doesn't make; copy the design's quoted strings exactly.
## Review Focus
1. Retry after a timeout resends the same batch with the same key and byte-identical payload (test in C2).
2. Someone who unsubscribes after approval but before their batch is claimed is skipped, not sent (test in C2).
3. A campaign bigger than the daily room spreads over days, never over the limit in a UTC day (test in C2).
4. The AI edits a draft while the owner has the review page open: Approve is refused, not sent stale (A5, B3).
5. A forged or replayed webhook (bad signature, old timestamp, unknown email id) changes nothing (test in C5).
## PR A: `feat/campaigns-core`
### Task A1: Migration 0019 and the tables' plumbing
**Files:** create `migrations/0019_campaigns.sql`; modify `src/db/db.ts` (row types, `TableName`), `src/ids.ts`,
`src/services/change.ts` (`PRIMARY_KEYS`; `ROW_NOUNS` "Campaign", "Campaign email", "Campaign email block"),
`src/services/labels.ts` (`campaign cp_…`), `src/http/export.ts` (four tables, never `unsub_token`),
`src/db/migrations.test.ts` (`FAKE_ROWS`), `src/services/undo.ts` (`CAMPAIGN_FINAL_TOOLS`).
- [ ] Tests: earlier data kept; `settings` gains `campaigns` 0, `postal_address` null, `campaign_daily_limit` 90
  (CHECK 1..5000); a second non-skipped row for one `(campaign_id, step_id, email)` fails; the recipients export has no
  `unsub_token`; `undoChange` refuses each tool in the design's "Undo" list with its exact message.
- [ ] Schema exactly as the design's "Data" section (columns, CHECKs, indexes, `STRICT`). Commit `feat: campaigns tables (0019)`.
### Task A2: Settings and readiness
**Files:** modify `src/services/settings.ts`, `src/mcp/tools-write.ts` (`update_settings` `campaigns`, `postalAddress`,
`campaignDailyLimit`), `src/env.ts` (the four `CAMPAIGN_*`); create `src/campaigns/readiness.ts`.
**Produces:** `CAMPAIGNS_OFF` (design text); `requireCampaigns(src: Reader): Promise<void>`; `sendingBlocker(env: Env,
settings: SettingsRow): string | null` (design wording and order); `replyTo(env, settings): string | null`.
- [ ] Tests: each missing piece in order gives its sentence; a malformed `CAMPAIGN_FROM` blocks; all set gives null;
  `update_settings` writes and summarises the three fields; a postal address over 300 is a plain refusal.
- [ ] Commit `feat: campaign settings and readiness`.
### Task A3: Drafts service
**Files:** create `src/campaigns/drafts.ts`, `src/campaigns/body.ts`.
**Produces:** `Audience = {kind:"status",status}|{kind:"view",view}|{kind:"people",people}`; `CampaignDraftInput =
{ name?, recipients?: Audience, subject?, body?, buttonLabel?, buttonUrl?, firstNameFallback?, suggestedSendAt? }`;
`addCampaignDraft(ctx, input)`, `updateCampaignDraft(ctx, id, input)`, `duplicateCampaign(ctx, id)`,
`archiveCampaign(ctx, id)`, each `Promise<ChangeResult & { campaignId: string }>`; `parseBody(text): Block[]`.
- [ ] Tests: add writes the campaign and step 1 in one change; update refuses unless `draft` ("Only a draft can be
  edited. Duplicate it to make a new draft."); button needs both parts, https only; an unknown or deals view, an
  archived status, over 500 people or an unknown person refuses plainly; `parseBody` links `[text](https://…)` and bare
  https URLs, never `http:` or `javascript:`; undo of an add removes both rows.
- [ ] Commit `feat: campaign drafts`.
### Task A4: Rendering
**Files:** create `src/campaigns/render.ts`, `src/campaigns/first-name.ts`.
**Produces:** `renderEmail(step: CampaignStepRow, r: { firstName: string | null; token: string }, frame: { business:
string; postal: string; baseUrl: string; fallback: string }): { subject: string; html: string; text: string }`;
`firstNameOf(contact: ContactRow): string | null` (ruling 3).
- [ ] Tests: `{{first_name}}` and the fallback in subject and body; a merged value is escaped and never linked; the
  footer has business, postal address and `<baseUrl>/unsubscribe/<token>`; HTML has `lang="en"` and `<title>`; the text
  part shows "text (url)" and "Label: url"; an untrusted name gives the fallback.
- [ ] Commit `feat: render campaign emails`.
### Task A5: Audience, fingerprint, approval
**Files:** create `src/campaigns/audience.ts`, `src/campaigns/freeze.ts`; modify `src/services/view-read.ts` (export
the people `where` builder for an uncapped read).
**Produces:** `resolveAudience(db, now, audience): Promise<{ sendable: Member[]; skipped: (Member & { reason:
SkipReason })[]; newLeads: number }>` (over 2,000 is a UserError); `fingerprint(campaign, step, resolved):
Promise<string>`; `approveCampaign(ctx, id, { fingerprint, sendAfter: Date, baseUrl: string, scheduled: boolean }):
Promise<ChangeResult>` (tool `campaign_approve` or `campaign_schedule`); `pauseCampaign`, `resumeCampaign`,
`cancelCampaign(ctx, id)`.
- [ ] Tests: each skip reason (`no_email`, `bad_email`, `unsubscribed`, `bounced`, `complained`, `archived`); a changed
  draft or list refuses with the design's sentence; one row per person, a unique 43-character token on sendable rows
  only; cancel marks queued rows `cancelled`; a 2,000-person approve counted with `tests/helpers/counting-db.ts`, the
  numbers written into docs/PAID-PLAN.md "Run 8" (lower ruling 2's cap if it doesn't fit).
- [ ] Commit `feat: campaign audience and approval`.
### Task A6: MCP door, spec and decision
**Files:** create `src/mcp/tools-campaigns.ts`, `docs/decisions/0053-campaigns.md` (rulings 1 to 12) and its index
line; modify `src/mcp/server.ts`, `src/mcp/instructions.ts`, `src/mcp/server.test.ts`, `tests/e2e/mcp.test.ts`,
`docs/SPEC.md` (campaigns in scope, the rules; drop them from "Out of scope"), AGENTS.md (a Campaigns bullet).
**Produces:** read tools `list_campaigns`, `get_campaign`, `preview_campaign_recipients` (readOnlyHint); write tools
`add_campaign_draft`, `update_campaign_draft` (actor `ai`); every answer has `review_url`.
- [ ] Tests: tool lists updated; no tool name matches `/send|schedule|approve|unsubscribe/`; drafts write at once even
  under Review first; preview gives ids and labels, never an address; off refuses with `CAMPAIGNS_OFF`.
- [ ] Commit `feat: campaign tools for the AI app`. Push, PR A ("Needs your eyes": AGENTS.md).
## PR B: `feat/campaigns-board`
### Task B1: Nav, list and Campaign settings
**Files:** modify `src/board/routes.ts`, `src/board/layout.ts` (`PageFrame.campaigns`), `src/board/router.ts`,
`src/board/actions.ts`; create `src/board/pages/campaigns.ts`, `src/board/pages/campaign-settings.ts`,
`src/board/campaign-actions.ts` (`CAMPAIGN_ROUTES`).
- [ ] Tests: More lists Campaigns only when on; `/campaigns*` 404 when off; the list groups by status; settings save
  the postal address and limit through `updateSettings` as the owner and 303 with `?change=`.
- [ ] Commit `feat: Campaigns page and settings`.
### Task B2: New, edit and pick people
**Files:** create `src/board/pages/campaign-form.ts` (record-form specs), `src/board/pages/campaign-people.ts`.
- [ ] Tests: new and edit send only changed fields (`was.`); a 422 keeps values; editing a non-draft is a 404; the
  picker searches by GET, adds checked ids, removes one; nothing needs JavaScript. Commit `feat: build a campaign by hand`.
### Task B3: Review page and approval actions
**Files:** create `src/board/pages/campaign-review.ts`, `src/board/campaign-preview.ts`.
- [ ] Tests: to, from, reply-to, subject, the preview region, counts, skipped names by reason, the New-leads warning,
  the multi-day line; the first readiness blocker replaces the send buttons; Approve and Schedule (date and time in the
  owner's timezone, future, at most 90 days) carry the fingerprint; Cancel and Pause ask first; Duplicate; Archive.
- [ ] Commit `feat: review and approve a campaign`.
### Task B4: Results, person page, seed and routes
**Files:** create `src/board/pages/campaign-results.ts`, `src/campaigns/suppressions.ts` (`clearSuppression`); modify
the contact page (block line, "Allow campaign emails again" with a confirm, `POST /contacts/<id>/campaign-emails/allow`),
`scripts/seed-dev.ts` (`cp_seed01` draft to Partners; `cp_seed02` sent: delivered, bounced, unsubscribed, skipped),
`boardRoutes`, `lighthouseRoutes` (ruling 12), `src/board/banner.ts` (no Undo for final tools).
- [ ] Tests: counts and the 200-row table with `?status=`; bounced has no clear button; clear is undoable.
- [ ] Commit `feat: campaign results and blocks on a person`. `npm run test:a11y` if Chromium runs; push, PR B.
## PR C: `feat/campaigns-sending`
### Task C1: Activities and reach
**Files:** create `src/campaigns/activities.ts` (`campaignActivity(contactId, campaign, at): ActivityRow`); modify
`src/services/lead-change.ts`, `src/services/rules.ts`, `src/services/leads-read.ts`.
- [ ] Tests: `isReach` and both SQL forms skip `via: "campaign"` (extend the in-step test); a New lead stays New and no
  deal's `last_activity_at` moves. Commit `feat: campaign emails are logged, not counted as reaching`.
### Task C2: Sender and the campaign cron
**Files:** create `src/campaigns/resend.ts`, `src/campaigns/send.ts`; modify `src/cron.ts`, `src/index.ts`
(`scheduled` dispatches on `controller.cron`), `wrangler.jsonc` and `config/wrangler.copy.template.jsonc` (crons
`["0 * * * *", "5,20,35,50 * * * *"]`), then `npm run types`.
**Produces:** `runCampaigns(env, now): Promise<Record<string, number>>`; `CAMPAIGN_CRON = "5,20,35,50 * * * *"`.
- [ ] Tests (mocked fetch): every status branch of the design's step 6; over 20 h in flight becomes `uncertain`; room
  per UTC day including tests; a claim skips a new suppression; overlapping runs claim disjoint rows; at most 12 D1
  calls a run; headers `Idempotency-Key`, `User-Agent`, `List-Unsubscribe`, `List-Unsubscribe-Post`; done means `sent`.
- [ ] Measure a 100-email run (CPU, D1 calls) into PAID-PLAN.md "Run 8". Commit `feat: send campaigns in batches`.
### Task C3: Send test to me
**Files:** modify `src/board/action-kit.ts` (`email`, `origin`), `src/board/post.ts`, `src/board/campaign-actions.ts`.
- [ ] Tests: to the signed-in owner only; subject "Test: …"; `/unsubscribe/test`; the 11th in a UTC day refused; a
  `test` batch row; the readiness sentence when not ready. Commit `feat: send a test campaign email`.
### Task C4: Unsubscribe
**Files:** create `src/http/unsubscribe.ts`; modify `src/campaigns/suppressions.ts` (`suppress`), `src/index.ts`, the
a11y test (`publicRoutes`).
- [ ] Tests: GET shows only the business name and one button; POST (the form, or `List-Unsubscribe=One-Click`) is 200,
  suppresses and sets `unsubscribed_at`; a repeat is harmless; unknown is 404; `/unsubscribe/test` changes nothing; it
  works with campaigns off and no sign-in; `/unsubscribe/board.css` serves the stylesheet; rate limited.
- [ ] Commit `feat: public unsubscribe page`.
### Task C5: Webhook
**Files:** create `src/http/resend-webhook.ts`, `src/campaigns/svix.ts`; modify `src/index.ts`.
- [ ] Tests: a Svix vector (`v1,` entries, decoded `whsec_`); a timestamp over 5 min off is 401; over 64 KB is 413; no
  secret is 503; each event as designed; a later event never moves a row back; an unknown id is 200.
- [ ] Commit `feat: delivery results from Resend`.
### Task C6: Setup docs
**Files:** create `docs/CAMPAIGNS.md`; modify `docs/SECRETS.md`, `docs/ACCESS-SETUP.md` (bypass `unsubscribe`, `hooks`),
`src/brief/send.ts` (`User-Agent`). Commit `docs: campaign sending setup`; push, PR C.
## PR D: `docs/run8-closing`
- [ ] `docs/ACCEPTANCE.md` sentences 31 to 34 with e2e tests: draft a Partners newsletter with an RSVP button (gives
  the review link); "who would get it?"; "send it" (the AI says only the board sends; nothing changes); an
  unsubscribed person is skipped.
- [ ] `docs/UPDATING.md` "Run 8: after you update"; STATUS.md (state; Needs Grant with exact steps: Resend account
  and key, subdomain DNS, webhook secret, Access bypass, sending on; the copy "grant" on run 6 since 2026-11-24 and
  the 25-action answer; the timing table). PR D.
