# Secrets and settings

Every secret and variable the Worker reads, in one place. **Names and places only, never values.** Each client copy's
owner sets that copy's secrets personally, with their own wrangler login, in their own Cloudflare account. Claude, CI
and this repo never see them, and nothing here should be pasted into chat, a pull request, an issue or a log.

## Variables (not secrets)

| Name | Values | Where it is set |
|---|---|---|
| `ENVIRONMENT` | `production` (default) or `development` | `vars` in `wrangler.jsonc`; `npm run dev` and `npm run preview` pass `--var ENVIRONMENT:development` |
| `AUTH_MODE` | `dev`, or unset | Only `npm run dev`, `npm run preview` and the e2e tests set it (`--var AUTH_MODE:dev`). It works only with `ENVIRONMENT=development` on localhost; anywhere else every route answers 500. Unset, `/mcp` answers 401 until task 10 (decision 0004). |
| `BRIEF_SENDING` | `on`, or unset | The master switch for emailing the daily brief (decision 0011). Unset (the default) or any other value keeps sending off; the brief is still composed and stored each day. Set it in the copy's own config `vars`, never in this repo's `wrangler.jsonc`. |
| `BRIEF_FROM` | An address on a domain verified in Resend, or unset | The "from" address of the brief email. Unset keeps sending off. Set it in the copy's own config `vars`. |
| `MCP_ALLOWED_HOSTNAMES` | Comma-separated hostnames, or unset | A copy on a custom domain sets it (for example `pipeline.example.com`) so `/mcp` refuses other Host headers. Unset, localhost and `*.workers.dev` are checked automatically (decision 0004). |

## Secrets

The only secret the Worker reads so far is `RESEND_API_KEY` (below). Later tasks add theirs here, by name, with the exact
`wrangler secret put` command, when the code that reads them lands:

| Name | For | Set with |
|---|---|---|
| `RESEND_API_KEY` | Emailing the daily brief through Resend (task 7). Read only when sending is on. | `npx wrangler secret put RESEND_API_KEY` (the owner, in their own Cloudflare account) |
| `INTAKE_SECRET` | The shared secret a website form's server sends in the `X-Intake-Secret` header to `/intake` (task 8, decision 0012). Unset, `/intake` answers 503. | `npx wrangler secret put INTAKE_SECRET` (the owner; use a long random value). Local dev and the e2e tests use the fake `dev-intake-secret` from `--var`. |

`/intake` also uses the `INTAKE_RATE_LIMIT` Rate Limiting binding (5 requests per 60 s per IP), configured in
`wrangler.jsonc` (a placeholder namespace id; each copy's own config gives its own number). It is a binding, not a
secret.

Sending the brief needs all of these at once: `settings.brief_enabled` on (`update_settings`), a `brief_email` address in
the settings, `BRIEF_SENDING=on`, `BRIEF_FROM` and `RESEND_API_KEY`. If any one is missing the brief is only composed and
stored, and its `send_status` says which switch is off.

Still to come:

| Added by | For |
|---|---|
| Task 10 (auth) | The allowed owner email(s) (`OWNER_EMAILS`), the Cloudflare Access team domain and AUD, and the OAuth settings |

## Local development

Local development needs no secrets: `npm run dev` runs in development mode with `--var` values and fake seed data. A
git-ignored `.dev.vars` file also works for trying a secret locally. CI needs none: tests mock `fetch` and use fake
values.

## Never commit

- `.dev.vars`, `.dev.vars.*` and every `.env*` file except `.env.example` (all git-ignored). If a command would stage
  one, stop.
- Anything under `/.copies/` (per-copy wrangler configs with real account and database ids) or `/exports/` (data
  exports). Both are git-ignored, and `npm run check:config` fails if either is tracked.
- API keys, shared secrets, real database or account ids, or real values in any doc, test, comment or pull request.
- Real names, emails or lead data. Tests use fake people at `example.com` / `example.test`.
