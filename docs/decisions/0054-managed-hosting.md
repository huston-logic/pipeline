# 0054: Managed hosting: every copy lives in Huston Logic's Cloudflare account

## Context

Decision 0007 and the install docs assumed each client had their own Cloudflare account and invited the repo owner into
it. In practice a small-business owner does not want a Cloudflare account, a Zero Trust organisation, DNS records for a
Worker or secrets to look after. The owners want it handled. The code, the data layout and the update command do not
need to change for that; only whose account a copy lives in does.

## Decision

- **Huston Logic hosts every client copy in its own Cloudflare account**, for a monthly or yearly hosting fee. The fee
  itself is a business fact and lives in the master ("00 Huston Logic: Source of Truth"), not in this public repo
  (docs/PROCESS.md, "Where facts live").
- **The client's data stays the client's.** They can take a full export at any time (the board's Export page, or
  `npm run copies:export`). They pay for their own AI app; hosting does not include it.
- **Sign-in:** the owner signs in through Cloudflare Access as an allowed email in Huston Logic's one Zero Trust
  organisation. Each copy still has its own Access applications (the AI app's sign-in, the board, the bypass paths) and
  its own owner emails (decision 0005). The team domain is shared by every copy.
- **Email** (brief and campaigns) is sent from the client's own domain through Huston Logic's one Resend account, with
  the client's sending subdomain added as a sending domain and one API key per client limited to it (docs/INSTALL.md,
  "Sending email from the client's domain").
- **Where a copy answers:** a hostname on a Huston Logic domain in that same Cloudflare account, or `workers.dev`. A
  Worker's custom domain and its Access application must be in the account that owns the Worker, so the client's own
  domain is used for sending email only. Email logging's log subdomain is also on the hosting domain.
- **Offboarding on request** (docs/OFFBOARDING.md): the copy, its data and the current code move to the client's own
  Cloudflare and GitHub accounts. Huston Logic's responsibility for the copy ends at handover, and the handover date is
  recorded in the master's client record, never in this repo.
- **What stays the same:** identical code for every copy, per-copy config only in D1, bindings, secrets and the
  git-ignored `/.copies/<name>/` (decision 0002); the owner's own wrangler login does every provision, update and export
  (decision 0007); no client token is stored. Only the account in `copy.json` changes: it is the same account for every
  copy.

## Why

- The clients want it handled, and a person who never opens Cloudflare cannot misconfigure it.
- Hosting costs Huston Logic about $25 a month in total, whatever the number of copies: Workers Paid ($5) and Resend Pro
  ($20), at the vendors' list prices on 2026-11-24. Everything else a copy uses (D1, KV, Access) is inside those plans or free.
- Workers Paid is needed anyway. The free plan's 10 ms CPU limit trips on big imports and exports (docs/PAID-PLAN.md),
  and the free plan allows only 5 Cron Triggers and 10 D1 databases per account, while each copy uses 2 of each, so
  one account on the free plan could hold at most 2 copies. Paid lifts these (Cloudflare's Workers and D1 limits pages,
  read 2026-11-24).
- One account makes updates simpler: one login, one `account_id`, no invitation to ask for or lose.

## Consequences

- **Replaces** the "client's own Cloudflare account" model. Decision 0007 is partly replaced: its invitation and
  membership steps (a client invites the owner; "isn't a member of account" means the client removed you) no longer
  apply; its commands, checks and file layout stay. The "This is for the owner of one copy ... in their own account"
  wording in the docs is replaced the same way.
- **Zero Trust Free allows 50 users**
  ([Cloudflare plans](https://www.cloudflare.com/plans/sase-zero-trust.md), checked 2026-11-24; the developers
  "account limits" page does not state a user cap). One organisation serves every copy, so every owner of every copy,
  plus Huston Logic, counts against it. Pay-as-you-go has no limit at $7 per user a month on that page. Plan to move
  before about 40 users, and check the current page first.
- **Resend Pro allows 10 sending domains**; each client's sending subdomain is one. An add-on adds 100 more
  (resend.com/pricing, 2026-11-24; check the page, since it lists two Pro tiers). One key per client, limited to that
  client's domain, keeps one client's key from sending as another.
- **One account is one blast radius.** A mistake in Huston Logic's Cloudflare or Resend account reaches every client.
  Keep its login on a hardware key or passkey. Copies are still separate Workers with separate databases, secrets and
  Access applications.
- **Handover is a real job.** It is not rehearsed yet (docs/OFFBOARDING.md says so). Rehearse it once on a fake copy
  before the first client asks.
- **Existing copies:** the only copy so far is Grant's own ("grant"). No client copy exists yet, so nothing moves.
- Per-copy Access applications are 3 each; the Access limit is 500 applications per account (Cloudflare account-limits
  page), so that is not the limit that binds.
