# 0017: The board's write path, the change banner and the pipeline kanban

Run 2, task R3, 2026-11-19. Builds on 0014 (editable board, CSRF, a little JavaScript), 0015 (look) and 0016
(contacts). The first board writes: moving a deal and undoing a change.

## Context

Decision 0014 set the rules for board writes: one write path through the services, a same-origin check and a
double-submit CSRF token, Post/Redirect/Get with the change id, an Undo button, a confirm step for Won, Lost and Not
now, and at most 3 KB of first-party JavaScript. It left open how the routes are organised, where the banner and its
Undo live, which `return_to` values are trusted, how the kanban works on a phone, what dragging does, and how closed
stages are reached when they are not columns. Task R4 adds more edits on the same path, so the choices have to scale.

## Decision

- **One route table.** `src/board/actions.ts` lists every board write (`/deals/<id>/move`, `/changes/<id>/undo`) with
  its handler. `src/index.ts` sends a POST there only when the path matches; every other non-GET keeps the 405 answer,
  and `/api/*` stays read-only. A matched path whose id can't be a deal or change id, or names no deal, gets the 404
  page (after the checks below). Handlers get an `ActionContext` (db, now, the checked token, the form, the look) and
  call only service functions, as actor `owner` with the MCP tool's name (`update_deal`, `undo_change`).
- **Checks, in order** (`src/board/post.ts`): a misconfigured dev sign-in (500, as for every route), then the sign-in
  (Access and the owner list in production, the dev sign-in locally), then the same origin (`Origin` must equal the
  request's origin; `Origin: null` is refused; with no `Origin`, `Sec-Fetch-Site` must be `same-origin`; else 403),
  then the body (`application/x-www-form-urlencoded` only, 415; at most 16 KB by `Content-Length` and by the bytes
  read, 413), then the CSRF token. Origin and body refusals are plain text, because a browser on the owner's board
  never sees them. A missing cookie or a token that doesn't match gets the 403 page "This page is out of date. Reload
  it and try again." with a link back. The body limit and the constant-time compare moved to `src/http/limits.ts`,
  shared with `/intake`.
- **The cookie.** `__Host-pipeline-csrf` (Secure, HttpOnly, SameSite=Strict, Path=/), or `pipeline-csrf` without Secure
  in the dev sign-in mode only; each mode reads only its own name. 32 random bytes as base64url (43 characters); a
  cookie of any other shape counts as missing. It is a session cookie: a board page that finds none (or a malformed
  one) makes one token and uses it in both its `Set-Cookie` and every form on the page.
- **Page context.** Board pages take a `PageContext` (`src/board/context.ts`): db, now, the query, `here` (the page's
  path and query without `change`, used as every form's `return_to`), the CSRF token, the look and the banner. Pages
  pass it to `renderPage` as `frame`; the layout draws the banner first in `main`.
- **return_to** (`src/board/return-to.ts`). Accepted only when it starts with one `/` (not `//`), has no backslash and
  no control characters, is at most 2,000 characters, parses as a path on this site whose written path is exactly the
  parsed one (so `/./x` and `%2F` tricks fail), and is a board page by `matchBoardPage`. Otherwise the browser goes
  back to the record's own page (`/deals/<id>`; `/changes` for an undo). The fragment is dropped; `change=<id>`
  replaces any change id already there. The Location is a relative path.
- **The change banner** (`src/board/banner.ts`). Any board page opened with `?change=chg_…` (checked with
  `isChangeId`; anything else is ignored) looks the change up with `getChange` and shows its one-line summary in a
  `role="status"` panel. It has an Undo button (a POST form) unless the change is an undo itself; one that was undone
  says "This change was undone." Summaries never carry outside text (services name records through safe labels), so
  they are shown as they are. An undo answers 303 with the undo's own id, so the banner then shows "Undid …" and no
  button. A refused undo is a 422 page with the service's message.
- **The change log** says who made each change in words: "You, on the board" (owner), "You, by a CSV import" (owner,
  tool `import`), "Your AI app", "Your website form" (system, tool `intake`) and "System" (other system jobs). Every
  change that is not an undo and not undone has an Undo button; the service still refuses one that can't be undone.
- **A refused write** (`UserError`) is a 422 page with the same frame and one h1 ("The deal wasn't moved"), the
  message, the Move to form again with the owner's choice selected, and "Back to the page". Any other error is the
  existing server-error page; the Worker logs only `board_post_failed`.
- **Closed stages as targets, not columns.** The kanban has one column per open stage. Won, Lost and Not now (every
  stage that is not open and not archived) are listed as a small "Closed" summary with their deal counts, are options
  in every Move to list (grouped as "Close the deal"), and are drop areas for dragging. A move to one of them without
  `confirm=yes` renders a confirm page ("Mark "…" (Pat Example) as Won?", the deal named through `dealLabel`, so an
  outside title shows as "deal dl_…") whose form carries the stage, `confirm=yes`, the token and `return_to`, with
  Cancel back to `return_to`. Nothing is written until it is confirmed, whichever way the request came.
- **Move to form.** A real form: a labelled select of every stage (the deal's own marked "(current)") and a Move
  button, each with the deal's safe name in visually hidden text so a screen reader can tell the forms apart. On
  cards and list rows it sits inside a native `<details>` ("Move to another stage") so cards stay short; the deal page
  and the refused page show it open with a visible label.
- **Phone layout.** Under 40rem the columns stack, with a row of jump links to each stage (with its count) above them
  and the Closed summary after them. From 40rem the columns sit side by side in a `role="region"` labelled "Open
  stages" with `tabindex="0"`, which scrolls sideways on its own (the page never does); from 60rem it runs into the
  content's right padding so a cut-off column at the window's edge shows there is more. The Closed summary moves above
  the board (CSS `order`, it has nothing focusable) where a dragged card can reach it. At 1280px about three and a
  half of the five demo columns show; the rest scroll.
- **List view.** `/pipeline?view=list` (a Board / List switch like People / Companies) lists every open deal as a row
  under its stage, each with its Move to form, and loads no script. It is in `boardRoutes`, so the a11y, Lighthouse
  and screenshot checks visit it; the harness takes the query string as it is.
- **Dragging** (`public/board.js`, loaded with `defer` only by the board view). Only with `(pointer: fine)`; cards
  become draggable, the dragged card fades, every stage it can go to gets a dashed edge, and the one under the pointer
  a solid accent edge and the words "Drop here". Dropping sets the card's own select and calls `requestSubmit()`, so
  it is an ordinary form post: the same checks, the same confirm page for closed stages and the same banner. No
  animation, so reduced motion needs nothing more. The CSP changes from `script-src 'none'` to `script-src 'self'` in
  `src/security.ts` and `public/_headers` together; still no inline script and no eval.
- **Today** keeps its stage rows; the deal page gets the Move to form in its Deal card.
- **Footer**: "Move deals and undo changes here, or change anything by talking to your AI app." R4 updates it when
  more edits arrive.

## Why

- A route table and one checking function mean R4's forms add a line and a handler, and can't skip a check.
- Checking `return_to` against the board's own page list, after parsing, closes the open-redirect tricks that string
  checks alone miss, and falls back somewhere useful instead of failing the write.
- Stacked columns are what a phone reads well; a horizontal board on a 375px screen hides four of five stages.
- Closed stages as columns would fill the board with finished work; as targets they stay one tap or one drop away
  and always go through the confirm step.
- A drag that submits the same form keeps one write path and one set of rules for every way of moving a deal.

## Consequences

- The board now ships one script; Lighthouse and the a11y check run it. `tests/screenshots/writes.screens.ts` drives
  the banner, the disclosure, the confirm page, a refused move and a real mouse drag (desktop) in Chrome, with axe on
  each state. It writes only in the desktop drag test, and undoes it.
- The undo service's messages mention `recent_changes` (an MCP tool name); the board shows them as they are.
- A tab left open after the browser restarts has no cookie: its next post gets the out-of-date page.
- `SameSite=Strict` (decision 0014) means a board page opened from another site (a link in an email or the AI app, or
  the return from the Access sign-in) arrives without the cookie, so it sets a new token, and other board tabs that
  were already open get the out-of-date page on their next post. Reloading fixes it. `SameSite=Lax` would avoid this
  and stay safe (browsers still withhold it on cross-site posts, and the origin check runs first); it is left for the
  owner to decide, because 0014 names Strict.

## "AI defaults" (human-touch-design), flagged for the owner

- **Kanban columns as tinted lanes holding identical white cards** (item 4, the SaaS-card kit). Required by the brief
  ("the pipeline as a kanban"); the tint is my choice. Alternatives: no lane fill, columns divided by a 1px line; or
  cards only, with the stage name as a sticky heading.
- **Pill-shaped jump links and boxed closed-stage counts** on the phone. My choice. Alternatives: the jump links as the
  Today page's stage rows in one panel; or a single sentence of counts.
- **A tinted banner strip with a white Undo button** (a toast-like pattern, but static). My choice. Alternatives: the
  summary as a plain line under the h1 with an Undo link; or the banner as a white card with a divider.
- **The disclosure triangle on "Move to another stage"** (the browser's own marker). Alternatives: a visible Move to
  select on every card (taller cards); or a plain "Move" link to the deal page's form.
- Not used: drag handles, toasts that disappear, animation on drop, colour-only drop states, count badges on columns.
