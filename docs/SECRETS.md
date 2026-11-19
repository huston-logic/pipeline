# Secrets and settings

Every secret and variable the Worker reads, in one place. **Names and places only, never values.** Each client copy's
owner sets that copy's secrets personally, with their own wrangler login, in their own Cloudflare account. Claude, CI
and this repo never see them, and nothing here should be pasted into chat, a pull request, an issue or a log.

## Variables (not secrets)

| Name | Values | Where it is set |
|---|---|---|
| `ENVIRONMENT` | `production` (default) or `development` | `vars` in `wrangler.jsonc`; `npm run dev` and `npm run preview` pass `--var ENVIRONMENT:development` |
| `AUTH_MODE` | `dev`, or unset | Only `npm run dev`, `npm run preview` and the e2e tests set it (`--var AUTH_MODE:dev`). It works only with `ENVIRONMENT=development` on localhost; anywhere else every route answers 500. Unset, `/mcp` answers 401 until task 10 (decision 0004). |
| `MCP_ALLOWED_HOSTNAMES` | Comma-separated hostnames, or unset | A copy on a custom domain sets it (for example `pipeline.example.com`) so `/mcp` refuses other Host headers. Unset, localhost and `*.workers.dev` are checked automatically (decision 0004). |

## Secrets

The Worker reads no secrets yet. Later tasks add them here, by name, with the exact `wrangler secret put` command, when
the code that reads them lands:

| Added by | For |
|---|---|
| Task 7 (daily brief) | `RESEND_API_KEY` and the sender address `BRIEF_FROM`; sending also needs `BRIEF_SENDING=on` and stays off otherwise |
| Task 8 (`/intake`) | The shared secret a website form sends in the `X-Intake-Secret` header |
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
