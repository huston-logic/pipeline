# Secrets and settings

Every secret and variable the Worker reads, in one place. **Names and places only, never values.** Each client copy's
owner sets that copy's secrets personally, with their own wrangler login, in their own Cloudflare account. Claude, CI
and this repo never see them, and nothing here should be pasted into chat, a pull request, an issue or a log.

## Variables (not secrets)

| Name | Values | Where it is set |
|---|---|---|
| `ENVIRONMENT` | `production` (default) or `development` | `vars` in `wrangler.jsonc`; `npm run dev` and `npm run preview` pass `--var ENVIRONMENT:development` |
| `AUTH_MODE` | `dev`, or unset | Unset (the production default): Cloudflare Access sign-in (decision 0006). Only `npm run dev`, `npm run preview` and the e2e tests set `dev` (`--var AUTH_MODE:dev`); it works only with `ENVIRONMENT=development` on localhost. `dev` anywhere else, or any other value, makes every route answer 500. |
| `ACCESS_TEAM_DOMAIN` | `<team>.cloudflareaccess.com` | Per copy, in the copy's own config `vars` (task 11 writes it). The Zero Trust team domain; the board and `/api` check Access tokens against it. Unset: they answer 500 "Sign-in isn't set up yet." (docs/ACCESS-SETUP.md, step 4) |
| `ACCESS_AUD` | The board application's AUD tag | Per copy, in the copy's own config `vars`. Unset: the board and `/api` answer 500 (docs/ACCESS-SETUP.md, step 4) |
| `OWNER_EMAILS` | Comma-separated emails | Per copy, in the copy's own config `vars`. Who may sign in, together with `settings.owner_emails` (decision 0005); compared ignoring case. With neither, the board and `/api` answer 500 and no one can connect `/mcp` |
| `BRIEF_SENDING` | `on`, or unset | The master switch for emailing the daily brief (decision 0011). Unset (the default) or any other value keeps sending off; the brief is still composed and stored each day. Set it in the copy's own config `vars`, never in this repo's `wrangler.jsonc`. |
| `BRIEF_FROM` | An address on a domain verified in Resend, or unset | The "from" address of the brief email. Unset keeps sending off. Set it in the copy's own config `vars`. |
| `MCP_ALLOWED_HOSTNAMES` | Comma-separated hostnames, or unset | Per copy. A copy on a custom domain must set it (for example `pipeline.example.com`): `/mcp` and its OAuth sign-in answer only on the listed hosts. Unset, they answer only on `*.workers.dev` and localhost (decisions 0004 and 0006). |

## Secrets

Every secret the Worker reads, by name, with the exact `wrangler secret put` command:

| Name | For | Set with |
|---|---|---|
| `RESEND_API_KEY` | Emailing the daily brief through Resend (task 7). Read only when sending is on. | `npx wrangler secret put RESEND_API_KEY` (the owner, in their own Cloudflare account) |
| `ACCESS_CLIENT_ID` | The Client ID of the Access for SaaS (OIDC) application for `/mcp` (decision 0006; docs/ACCESS-SETUP.md, step 1) | `npx wrangler secret put ACCESS_CLIENT_ID` |
| `ACCESS_CLIENT_SECRET` | That application's Client secret | `npx wrangler secret put ACCESS_CLIENT_SECRET` |
| `ACCESS_TOKEN_URL` | That application's Token endpoint (https) | `npx wrangler secret put ACCESS_TOKEN_URL` |
| `ACCESS_AUTHORIZATION_URL` | That application's Authorization endpoint (https) | `npx wrangler secret put ACCESS_AUTHORIZATION_URL` |
| `ACCESS_JWKS_URL` | That application's Key endpoint (https) | `npx wrangler secret put ACCESS_JWKS_URL` |
| `INTAKE_SECRET` | The shared secret a website form's server sends in the `X-Intake-Secret` header to `/intake` (task 8, decision 0012). Unset, `/intake` answers 503. | `npx wrangler secret put INTAKE_SECRET` (the owner; use a long random value). Local dev and the e2e tests use the fake `dev-intake-secret` from `--var`. |

If any of the five `ACCESS_*` secrets is missing (or a URL isn't https), `/authorize` and `/callback` answer 500
"Sign-in isn't set up yet." and no AI app can connect. No `COOKIE_ENCRYPTION_KEY` is needed: the OAuth library keeps the
sign-in state in `OAUTH_KV`, encrypted, and binds it to the browser itself.

Bindings (not secrets), in `wrangler.jsonc` with placeholder ids; each copy's own config gives its real ids:

- `INTAKE_RATE_LIMIT`: Rate Limiting for `/intake`, 30 requests per 60 s per client IP (decision 0012).
- `OAUTH_KV`: the KV namespace for `/mcp`'s OAuth state (decision 0006), with its own namespace in `previews`.

Sending the brief needs all of these at once: `settings.brief_enabled` on (`update_settings`), a `brief_email` address in
the settings, `BRIEF_SENDING=on`, `BRIEF_FROM` and `RESEND_API_KEY`. If any one is missing the brief is only composed and
stored, and its `send_status` says which switch is off.

## Local development

Local development needs no secrets: `npm run dev` runs in development mode (`AUTH_MODE=dev`) with `--var` values and
fake seed data. A
git-ignored `.dev.vars` file also works for trying a secret locally. CI needs none: tests mock `fetch` and use fake
values.

## Never commit

- `.dev.vars`, `.dev.vars.*` and every `.env*` file except `.env.example` (all git-ignored). If a command would stage
  one, stop.
- Anything under `/.copies/` (per-copy wrangler configs with real account and database ids) or `/exports/` (data
  exports). Both are git-ignored, and `npm run check:config` fails if either is tracked.
- API keys, shared secrets, real database or account ids, or real values in any doc, test, comment or pull request.
- Real names, emails or lead data. Tests use fake people at `example.com` / `example.test`.
