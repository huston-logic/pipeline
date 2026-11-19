# 0014: The board becomes editable, with a little browser JavaScript

Replaces, in part, 0001 (no client JavaScript) and the read-only parts of 0013. Run 2, 2026-11-18.

## Context

The owner looked at the board and found it hard to use: it could not show contacts or companies and could not change
anything. The board is the demo and the owner's daily screen. The run 2 brief changed the spec: the board becomes
editable, small amounts of browser JavaScript are allowed as progressive enhancement, and board writes need
protection against cross-site form posts. It left open how a board edit reaches the database, how cross-site posts
are refused, what JavaScript may do, and how a closing move (Won, Lost, Not now) is confirmed.

## Decision

- **One write path.** A board form post calls the same service function the matching MCP tool calls
  (`src/services/*`: `addLead`, `updateContact`, `updateDeal`, `logActivity`, `addTask`, `completeTask`,
  `snoozeTask`, `undoChange`). The board never writes SQL itself. Each edit is one audited change (actor `owner`, tool
  = the MCP tool's name, for example `update_deal`), shows in the change log, and can be undone with the existing
  `undoChange`. There is still no delete anywhere: archive or close instead.
- **Routes and answers.** Board writes are `POST` to paths under the record they change (for example
  `/deals/<id>/move`, `/tasks/<id>/complete`, `/changes/<id>/undo`). After a write the Worker answers
  `303 See Other` to the page the form came from (a same-origin path, checked), with `?change=<chg_…>`, and that page
  shows the change's one-line summary and an Undo button (Post/Redirect/Get, so a reload never repeats a write). A
  refused write (a `UserError`) shows the form again with the plain-English message. Bodies are
  `application/x-www-form-urlencoded` only, at most 16 KB.
- **Cross-site protection, two checks, both required:**
  1. Same origin: the `Origin` header must equal the request's own origin; when a browser sends no `Origin`,
     `Sec-Fetch-Site` must be `same-origin`. Otherwise 403.
  2. CSRF token (double submit): a random 32-byte value in a cookie (`__Host-pipeline-csrf`: `Secure`, `HttpOnly`,
     `SameSite=Lax`, `Path=/`), set on board pages when missing, and the same value in a hidden `csrf` field in
     every form, compared in constant time. Local dev over `http://localhost` uses the name `pipeline-csrf` without
     `Secure`, because `__Host-` cookies need HTTPS; that name is accepted only in the dev sign-in mode.
     *Amended in R3 (2026-11-19, decision 0017): `SameSite=Lax` for both names, was `Strict`.* With Strict, a board
     page reached from another site (the return from the Access sign-in, a link in an email or the AI app) arrives
     without the cookie, makes a new token and breaks every other open board tab. Lax still withholds the cookie on
     cross-site posts, and the same-origin check runs in front of the token anyway.
  Details: a page that finds no cookie generates one value and puts it in both its `Set-Cookie` and its hidden
  fields; a POST with no cookie is refused (the page must be loaded first). `Origin: null` (sandboxed or redirected
  requests) is refused, not treated as a missing header. A script that posts with `fetch` reads the token from the
  page's hidden field, because the cookie is `HttpOnly`.
  The sign-in checks from run 1 stay in front of both: Cloudflare Access's token and the owner-email list in
  production, the loopback-only dev mode locally.
- **JavaScript.** One first-party file, `/board.js` (from `public/`), loaded with `defer`. The CSP changes from
  `script-src 'none'` to `script-src 'self'`, in `src/security.ts` and `public/_headers` together; still no inline
  script, no `'unsafe-inline'`, no `'unsafe-eval'`. It is progressive enhancement only: every action is a plain HTML
  form that works with JavaScript off, and the script only adds conveniences (drag a deal card to another stage,
  copy a prompt to the clipboard). No framework, no build step, no third-party code, at most 3 KB gzipped. The CSP
  change lands with the first PR that ships the file.
- **Closing a deal asks first.** Moving a deal to a Won, Lost or Not now stage shows a confirmation step ("Mark … as
  Won?") unless the form already carries the confirmation, the same rule the AI follows (server instructions).
  The confirmation is a server-rendered page or panel whose form carries a hidden `confirm=yes` field and the CSRF
  token like any other board form, so it works without JavaScript; dragging a card to a closed stage goes through the
  same step. *Added in R3 (decision 0017):* an Undo that would remove records (the change added contacts, deals, tasks
  or activities) asks first in the same way.
- **Static files stay first-party.** `script-src 'self'` lets any same-origin file run as script, so `public/` holds
  only scripts written in this repo. The web app manifest (task R6) is fetched by browsers without credentials unless
  its `<link>` says `crossorigin="use-credentials"`; behind Access it must say so.

## Why

- One write path keeps the spec's promise that every write is audited and undoable, whoever makes it. A second path
  would drift from the MCP tools' checks and summaries.
- The origin check stops a form on another site from posting with the owner's Access cookie; the token covers a
  browser or proxy that drops `Origin`. Neither needs a new secret, so no copy needs setup for it.
- Progressive enhancement keeps the board working on a slow phone or with a script error, and keeps the accessibility
  and Lighthouse checks easy to pass.

## Consequences

- The board is no longer read-only. `/api/*` stays read-only JSON (405 for other methods); a POST to a path that is
  not a board write route keeps today's 405 answer.
- `docs/SPEC.md` no longer lists "editing data from the board" as out of scope.
- Every board form must render the hidden `csrf` field; a test checks each POST route refuses a missing or wrong
  token and a cross-site `Origin`.
- A tab left open past a cookie reset gets "This page is out of date. Reload it and try again." instead of a write.
