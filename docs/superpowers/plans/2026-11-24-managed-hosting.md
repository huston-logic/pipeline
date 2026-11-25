# Plan: Managed hosting (docs only)

Brief: Grant, 2026-11-24 (the "Docs run: Managed hosting", item H1 of the 09 doc, the pipeline half). One branch
(`docs/managed-hosting`), one PR. Docs only. Code is touched only if a doc would otherwise be wrong; none is expected.

## The decision

Huston Logic hosts every client's Pipeline copy in its own Cloudflare account, for a monthly or yearly fee. The client's
data stays theirs (full export any time) and they pay for their own AI app. On request Huston Logic offboards the client:
the copy, its data and the current code move to the client's own Cloudflare and GitHub, and Huston Logic's responsibility
ends at handover. This replaces the "client's own Cloudflare account" model (decision 0007's membership and invitation
steps, and the same assumption in the install, access, secrets, campaign and email-logging docs).

## Facts checked on 2026-11-24 (sources go in the docs)

- Zero Trust Free: "50 users" (cloudflare.com/plans/sase-zero-trust.md). The developers "account limits" page does not
  state a user cap, so the plans page is the source. One organisation for every copy, so every owner counts.
- Workers Free vs Paid: Cron Triggers per account 5 vs 1,000 (a copy uses 2); CPU per request 10 ms vs 30 s default;
  D1 databases per account 10 vs 1,000,000 (a copy uses 2). Workers Paid is $5 a month.
- Resend: Pro 10 sending domains (the Free plan 3); an add-on gives 100 more. The price table on the page is unclear
  (it lists two Pro tiers), so the docs say "check resend.com/pricing".

## Tasks (one commit each, check:fast runs on every commit)

1. **Plan and decision.** This file; `docs/decisions/0054-managed-hosting.md`; its line in the decisions index; note
   "partly replaced by 0054" on 0007's line. Why: owners want it handled; about $25 a month in total (Workers Paid
   $5, Resend Pro $20) whatever the number of copies; Workers Paid is needed anyway (10 ms CPU on big imports). The
   client price stays out of the repo (PROCESS.md "Where facts live"): the decision says "the hosting fee, set in the master".
2. **Account docs.** INSTALL.md (steps 1 to 3, troubleshooting), UPDATING.md, ACCESS-SETUP.md (one Zero Trust
   organisation; owner emails as allowed emails; the 50-user limit with its source), SECRETS.md, SPEC.md, README.md,
   and the same assumption in CAMPAIGNS.md, EMAIL-LOGGING.md and PAID-PLAN.md.
3. **Email.** A "Sending email from the client's domain" section in INSTALL.md (the one place), linked from
   CAMPAIGNS.md and SECRETS.md: one Resend account (Grant's), the client's sending subdomain added as a sending domain,
   a key limited to that domain, and the DNS records the client adds (SPF, DKIM, return path, DMARC).
4. **OFFBOARDING.md.** Runbook, marked "Not yet rehearsed": full export, the client's Cloudflare account, provision
   there, import, secrets, Access and DNS, check, remove Huston Logic's access, record the handover date.
5. **PROCESS.md.** One "Hosting" rule (what, why, decided, enforced by) linking 0054 and OFFBOARDING.md.
6. **Closing.** STATUS.md: current state, timing table, "For the master" line, Needs Grant (Cloudflare account items
   before the first client copy), changelog. Full `npm run check`, PR, auto-merge.

## Rulings so far

- The client's own domain cannot hold the Worker route or the Access application, because those must be in the same
  Cloudflare account as the Worker. So a managed copy answers on a hostname under a Huston Logic domain in that account
  (or `workers.dev`); the client's domain is used only for sending email. Email logging's log subdomain also moves to
  that domain. The docs say so; Grant picks the hosting domain (Needs Grant).
- Each copy still gets its own Access applications and secrets; only the Zero Trust organisation and team domain are shared.

## Checks

`npm run check:fast` per commit; full `npm run check` before the push and PR. No code, test, threshold or required check changes.
A docs-only PR skips the slow a11y and Lighthouse steps in CI.
