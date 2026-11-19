# Pipeline

A small sales follow-up engine for a small-business owner who does their own selling. The owner runs it by talking to
their AI app through one MCP endpoint. Every client gets their own copy in their own Cloudflare account, and every copy
runs the identical code in this repo.

- What it does and must never do: [`docs/SPEC.md`](docs/SPEC.md).
- How it is being built, task by task: [`docs/PLAN.md`](docs/PLAN.md); progress in [`docs/STATUS.md`](docs/STATUS.md).
- Judgment calls: [`docs/decisions/`](docs/decisions/).
- Permanent rules for anyone (or any AI) changing the repo: [`AGENTS.md`](AGENTS.md).

This repo is public. It holds no client names, emails, ids or lead data; tests and seed data use fake people at
`example.com` and `example.test`.

## What is here so far

One Cloudflare Worker (`src/index.ts`) with a board rendered as plain HTML (editable from run 2, decision 0014;
decision 0001), a D1 database with an audited service layer, the MCP endpoint at `/mcp` (decision 0004) and the hourly
rules run (a Cron Trigger, `src/cron.ts`; decision 0010), the daily brief and `POST /intake` for website forms
(decision 0012), the board's JSON API and export (decision 0013), and production sign-in (decision 0006).

**Sign-in.** In production Cloudflare Access signs the owner in (a one-time code by email): the board and `/api/*`
sit behind an Access application and the Worker checks Access's token and the owner email; `/mcp` uses OAuth (the
`workers-oauth-provider` library) with Access as the sign-in step, so an AI app connects once and gets its own token.
The dashboard steps are in [`docs/ACCESS-SETUP.md`](docs/ACCESS-SETUP.md). Until a copy is set up, the board, `/api/*`
and `/mcp` answer 500 "Sign-in isn't set up yet." Locally, `npm run dev` signs you in as a fake owner.

| Route | What |
|---|---|
| `/` | The board: deals by stage, what is due today (overdue included) and the latest brief |
| `/deals/<id>` | One deal before a call: contact, deal, next step, open tasks and the timeline, newest first |
| `/brief`, `/rules`, `/changes`, `/export` | The latest daily brief, the rules, the last 30 days of changes, and the export downloads |
| `/api/pipeline`, `/api/due`, `/api/deals/<id>`, `/api/rules`, `/api/changes`, `/api/brief` | The same data as JSON |
| `/api/export.json`, `/api/export/<table>.csv` | The full export as one JSON file, or one table as CSV (decision 0013) |
| `/mcp` | The MCP endpoint (Streamable HTTP, POST). In production it needs an OAuth token (401 with the sign-in details without one); locally `npm run dev` signs you in as a fake owner |
| `/authorize`, `/callback`, `/token`, `/register`, `/.well-known/*` | Production only: the OAuth sign-in an AI app goes through to get its `/mcp` token (decision 0006) |
| `/intake` | `POST` only: a website form's server sends a new enquiry here with a shared secret (see "Connect a website form") |
| `/board.css`, `/robots.txt`, `/sitemap.xml` | Static files from `out/`, served through the `ASSETS` binding |
| anything else | A 404 page |

## Develop

Requires Node 22.19+ and npm 10 (`>=10.9.2 <11`, as in `engines`; CI uses Node 22 with npm 10.9.9). If your default npm
is 11, put `npx --yes npm@10.9.9` in front of `install` and `ci`, because a lockfile written by npm 11 can fail CI.

```bash
npx --yes npm@10.9.9 ci
npm run dev        # http://localhost:4821
```

To try the MCP tools locally, point an MCP client (for example the MCP Inspector) at `http://localhost:4821/mcp`
while `npm run dev` runs.

`npm run dev` builds `out/`, applies any local D1 migrations, then runs `wrangler dev --local` in development mode
(`ENVIRONMENT=development`, `AUTH_MODE=dev`). Its local database lives in `.wrangler/state`. Nothing touches a
Cloudflare account: there is no login, no remote resource and no deploy.

| Command | What it does |
|---|---|
| `npm run dev` | Local Worker on port 4821, local state kept between runs |
| `npm run preview` | Local Worker on port 4822 with a fresh `.wrangler/preview-<timestamp>` state folder; the accessibility and Lighthouse checks start it |
| `npm run build` | Writes `out/` (the static files the Worker serves) |
| `npm run types` | Regenerates `src/worker-configuration.d.ts` (Workers runtime types) after `wrangler.jsonc` changes; commit the result |
| `npm run check:config` | Fails if client data could be tracked (decision 0002) |
| `npm run lint` | ESLint with `typescript-eslint` |
| `npm run typecheck` | `tsc` for the Worker, then for `tests/a11y` (which needs DOM types) |
| `npm run test:worker` | `test:unit`, then `test:e2e` (what CI runs) |
| `npm run test:unit` | Unit tests (`src/**/*.test.ts`, `scripts/*.test.mjs`), Node's built-in runner, no network |
| `npm run test:e2e` | Builds `out/` once, then the end-to-end tests (`tests/e2e/*.test.ts`: the Worker under `wrangler dev --local` on a temp database, in dev sign-in mode), one file at a time, no network beyond localhost |
| `npm run check` | `check:config`, lint, typecheck, `test:worker`, build, in that order |
| `npm run test:a11y` | Playwright + axe against `npm run preview` (run `npm run build` first) |
| `npm run test:lighthouse` | Lighthouse CI against `npm run preview` (run `npm run build` first) |

## Checks and CI

Four checks must pass before a pull request can merge into `main` (the "Protect main" ruleset): `check`, `a11y` and
`lighthouse` (jobs in `.github/workflows/ci.yml`) and `dependency-review` (`.github/workflows/dependency-review.yml`).
A fifth lock, the "Require code scanning results" rule (CodeQL), blocks the merge while a new CodeQL alert of severity
High or higher is open. Never rename those jobs or filter them out; see `CLAUDE.md`.

### Accessibility check (Playwright + axe)

`playwright.config.ts` starts `npm run preview` and scans every board page in `src/board/routes.ts`, plus the 404 page,
in Chromium at desktop (1280 px) and phone (375 px) width with reduced motion. Each page is checked against axe's WCAG
2.0/2.1/2.2 A and AA rules plus its best-practice rules, twice: at the top of the page and scrolled to the bottom. No rule
is skipped. A genuine false positive may be recorded in `tests/a11y/known-issues.ts` (one rule on one selector, with a
written reason); never add one just to get green. Automated checks find only part of the problems: keyboard, screen
reader and zoom checks are still manual.

### Lighthouse CI

`npm run test:lighthouse` audits every board page (mobile preset, median of 5 runs) with the installed Google Chrome.
Accessibility and SEO must score 0.95 or higher, best practices and performance 0.9 or higher (`lighthouserc.cjs`;
never lower them). Reports go to `.lighthouseci/` (git-ignored). If CI fails with `NO_NAVSTART` (a Lighthouse
trace-recording hiccup), use "Re-run failed jobs".

`package.json` overrides `basic-ftp` (a Lighthouse CI dependency with advisories in code it never runs),
`playwright-core` (one Playwright version) and `minimatch` under `typescript-eslint`; remove each override when the
upstream package no longer needs it.

### Security scans

| Job | File | Runs on | What it does |
|---|---|---|---|
| `dependency-review` | `.github/workflows/dependency-review.yml` | Pull requests | Fails if the PR adds a dependency version with a known vulnerability (runtime and dev). The log names the package and its GHSA. |
| `codeql` | `.github/workflows/codeql.yml` | Pull requests, pushes to `main`, weekly | CodeQL scan of the JavaScript and TypeScript. New alerts show as "Code scanning results / CodeQL". |

## Connect a website form

`POST /intake` turns a contact-form submission into a lead: a contact (or the one already on file for that email), a
deal in the first open stage, and a "Form submission" activity holding the message. It is **server to server**: the
website's own backend (or a form handler) sends the request. There is no CORS, so a browser on another site can't call
it. **The secret must never be in browser code**: not in JavaScript, not in a hidden form field, not in a page's source.

The owner sets the secret once per copy: `npx wrangler secret put INTAKE_SECRET` (docs/SECRETS.md). Then the server
posts JSON (or `application/x-www-form-urlencoded`) with the secret in a header:

```bash
curl -X POST https://pipeline.example.com/intake \
  -H "Content-Type: application/json" \
  -H "X-Intake-Secret: not-a-real-secret" \
  -d '{"name": "Pat Example", "email": "pat@example.com", "phone": "555 010 0100", "business": "Sample Bakery", "message": "Hi, do you take wedding orders?"}'
```

`name`, `email` and `message` are required; `phone`, `business` and `source` (default "website form") are optional;
other fields are ignored. Limits: body 16 KB, `message` 5,000 characters. Answers: `201 {"ok":true}` when a lead was
added, `200 {"ok":true}` for a repeat (same email and message within 10 minutes), and `{"ok":false,"error":"..."}` with
400, 401, 405, 413, 415, 429 or 503 otherwise. Show your own error message to the visitor on anything but 2xx. An
existing contact's details are never overwritten. Thirty requests per minute per IP are allowed. Decision 0012 has the
reasoning.

## Security headers

The Worker sets one policy on every response (`src/security.ts`): a CSP of `default-src 'self'; script-src 'none'`
with `style-src 'self'`, `img-src 'self' data:`, `base-uri 'none'`, `form-action 'self'`, `frame-ancestors 'none'`, plus
`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS and COOP/CORP. Board pages
also send `Cache-Control: no-store`. `public/_headers` repeats the same headers for static files; a test fails if the
two differ.

## Search engines

`robots.txt` allows crawling, no page says `noindex` and the sitemap is empty: the board sits behind Cloudflare Access,
which is the real gate (decision 0003).

## Secrets

Names only, never values: [`docs/SECRETS.md`](docs/SECRETS.md). Each copy's secrets are set by its owner with wrangler,
in their own account. `.env*` and `.dev.vars*` files are git-ignored; only `.env.example` is committed.

## Client copies: install, update, import, export

This repo has no production deploy of its own: merging into `main` deploys nothing. Each client copy lives in the
client's own Cloudflare account, and the repo owner, invited into that account, creates and updates it from this repo
with their own wrangler login (decision 0007). Per-copy config is generated into the git-ignored `/.copies/<name>/`;
exports go to the git-ignored `/exports/`.

| Command | What it does |
|---|---|
| `npm run copies:provision -- --copy <name>` | Creates a copy's databases, KV and config, sets up its data and secrets ([docs/INSTALL.md](docs/INSTALL.md)) |
| `npm run copies:update [-- --copy <name>] [--dry-run]` | Builds once, then migrates and deploys every copy (or one) ([docs/UPDATING.md](docs/UPDATING.md)) |
| `npm run copies:export -- --copy <name>` (or `--local`) | Every table as JSON and CSV, plus `all.json`, into `exports/<name>-<date>/` |
| `npm run import:contacts -- --file <csv> --copy <name> [--apply]` (or `--local`) | Contact import from CSV: a dry run first, then one undoable change |

Never run `wrangler deploy` by hand.

## Project structure

```
src/index.ts              Worker entry: fetch router and scheduled handler
src/cron.ts               the hourly jobs the scheduled handler runs (the rules)
src/rules/engine.ts       the rules engine: pure functions (firing, gone quiet, preview)
src/http/intake.ts        POST /intake (website forms)
src/http/api.ts           /api/* (board JSON and export downloads); export.ts, csv.ts
src/env.ts                Env type (bindings and vars)
src/security.ts           security headers for every response
src/board/                html.ts (escaping template tag), layout.ts, parts.ts, router.ts, routes.ts, pages/*.ts
src/worker-configuration.d.ts   generated by `npm run types`
public/                   board.css, robots.txt, _headers (copied into out/ by the build)
src/import/                the CSV contact import: plan.ts (pure plan), change.ts (one audited change), sql.ts
scripts/                  build.mjs, dev.mjs, check-config.mjs, copies.mjs (provision, update, export),
                          import-csv.ts, wrangler-run.mjs (+ tests), lighthouse-summary.mjs
config/                   wrangler.copy.template.jsonc (each copy's config is generated from it)
tests/a11y/               Playwright + axe accessibility check
docs/                     SPEC, PLAN, STATUS, SECRETS, INSTALL, UPDATING, ACCESS-SETUP, decisions/, pipeline/
```
