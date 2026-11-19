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

One Cloudflare Worker (`src/index.ts`) with a read-only board rendered as plain HTML (no client JavaScript;
decision 0001), a D1 database with an audited service layer, the MCP endpoint at `/mcp` (decision 0004) and the hourly
rules run (a Cron Trigger, `src/cron.ts`; decision 0010). Later tasks add `/intake`, `/api/*`, the daily brief and
production sign-in.

| Route | What |
|---|---|
| `/` | The board (for now a page saying it fills in once the database is set up) |
| `/mcp` | The MCP endpoint (Streamable HTTP, POST). Locally `npm run dev` signs you in as a fake owner; elsewhere it answers 401 until production sign-in exists (task 10) |
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
| `npm run test:worker` | Unit tests (`src/**/*.test.ts`, `scripts/*.test.mjs`) and the end-to-end tests (`tests/e2e/*.test.ts`: the Worker under `wrangler dev --local` on a temp database), Node's built-in runner, no network beyond localhost |
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

## Deploying

This repo has no production deploy of its own: merging into `main` deploys nothing. Each client copy is created by the
provisioning script and updated by the copy update script (task 11), run by the owner with their own wrangler login.
Never run `wrangler deploy` by hand.

## Project structure

```
src/index.ts              Worker entry: fetch router and scheduled handler
src/cron.ts               the hourly jobs the scheduled handler runs (the rules)
src/rules/engine.ts       the rules engine: pure functions (firing, gone quiet, preview)
src/env.ts                Env type (bindings and vars)
src/security.ts           security headers for every response
src/board/                html.ts (escaping template tag), layout.ts, routes.ts, pages/*.ts
src/worker-configuration.d.ts   generated by `npm run types`
public/                   board.css, robots.txt, _headers (copied into out/ by the build)
scripts/                  build.mjs, dev.mjs, check-config.mjs (+ tests), lighthouse-summary.mjs
tests/a11y/               Playwright + axe accessibility check
docs/                     SPEC, PLAN, STATUS, SECRETS, decisions/, pipeline/ (CI and hook process notes)
```
