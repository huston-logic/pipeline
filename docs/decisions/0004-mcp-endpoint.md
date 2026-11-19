# 0004: The MCP endpoint

## Context

The spec says `/mcp` works with any MCP client over Streamable HTTP, follows the current Cloudflare Agents docs
(`createMcpHandler`, not the deprecated `McpAgent`), validates every input with a schema and answers in plain English.
It left open which SDK line to use, how the server is built per request, how answers are shaped, how sign-in works
before production OAuth (task 10), and how a copy on a custom domain is protected against Host-header tricks.

What was followed (Cloudflare docs read 2026-11-18: the `createMcpHandler` API reference, the remote MCP server guide
and the authorization page; plus the installed `agents` 0.33.0 types in `dist/mcp/server/` and the
`@modelcontextprotocol/server` 2.4.0 README and types):

- `createMcpHandler` from `agents/mcp/server` serves an **MCP SDK v2** server (`@modelcontextprotocol/server`).
  `agents` 0.33.0 pins its peer `@modelcontextprotocol/server` and `@modelcontextprotocol/client` at exactly 2.4.0.
- Pass a **factory**, not a server: the handler builds a fresh server for every request. The handler is
  **stateless**: no Durable Object, session or WebSocket, so it runs on the free plan. GET and DELETE answer 405.
- The Worker calls the handler as `handler(request, env, ctx)`; the callable is not the default export.
- `authContext: { props }` is what tools read through `getMcpAuthContext()`. The handler does not check tokens:
  the Worker signs the request in first.
- `allowedHostnames` defaults to localhost names on a local endpoint and to the request's own host on
  `*.workers.dev`; on a custom domain no Host check runs unless it is set.

## Decision

- **Packages:** `agents` 0.33.0, `@modelcontextprotocol/server` 2.4.0 and `zod` 4.6.7 (runtime), and
  `@modelcontextprotocol/client` 2.4.0 (dev, for the tests; `agents` also lists it as a peer). Exact pins.
- **`nodejs_compat`** is on in `wrangler.jsonc`: `agents/mcp/server` imports `node:async_hooks` (AsyncLocalStorage
  for the auth context) and the SDK imports `node:process`. Without the flag the Worker does not load.
- **Wiring:** `src/mcp/handler.ts` creates `createMcpHandler(() => createMcpServer({ db: env.DB, now }), { route:
  "/mcp", authContext: { props: { email } } })` for each request, with the signed-in email, and the Worker adds its
  security headers to the answer. `src/index.ts` loads `handler.ts` with a dynamic `import()` only for a signed-in
  `/mcp` request (the path lives in the import-free `src/mcp/route.ts`), so the board and the Node unit tests
  (`src/index.test.ts`, which covers the 401 and 500 answers) never load `agents`; `/mcp` itself is tested in
  `tests/e2e/mcp.test.ts`.
- **Custom domains:** a copy served on its own domain sets the `MCP_ALLOWED_HOSTNAMES` variable (comma-separated
  hostnames, for example `pipeline.example.com`); the handler then passes it as `allowedHostnames`. Unset, the
  defaults above apply. Task 11's provisioning writes it into the copy's git-ignored config.
- **Sign-in until task 10:** `src/auth/dev.ts`. `AUTH_MODE=dev` signs in a fake owner (`owner@example.test`) only when
  `ENVIRONMENT=development` and the host is `localhost`, `127.0.0.1` or `[::1]`. `AUTH_MODE=dev` anywhere else, or any
  other `AUTH_MODE` value, is a misconfiguration: every route answers 500 (fail closed). Without `AUTH_MODE`, `/mcp`
  answers 401 with a plain message; the board is unaffected (Access protects it in production).
- **Answers:** one text block: a one-line plain-English headline, a blank line, then pretty JSON (`src/mcp/format.ts`).
  A write's headline is the service's summary, ending "(change chg_…)". Read headlines use counts, ids, dates and
  owner-set labels only. Empty results say so ("Your pipeline is empty: ..."). No headline, summary or error message
  carries outside text: the services name records through the safe labels in `src/services/labels.ts` (see the 0009
  addendum), for example "Updated contact ct_…: phone and business (change chg_…)".
- **Labels in read JSON:** every item that carries outside text lists the keys in its own `untrusted_fields`: deal
  items (`title`, `contactName`), task items (`title`, `dealTitle`, `contactName`), timeline items (`summary` when the
  owner or the AI did not write it), a contact's deals in `search_contacts` (`title`); contacts keep their stored
  `untrusted_fields` and activities their `untrusted_text`. Items with nothing from outside carry `[]`. Change
  summaries in `recent_changes` need no label: they are built from safe labels.
- **Validation:** each tool's zod schema is advertised in `tools/list`, but `src/mcp/tool.ts` parses the arguments
  itself so a bad request gets "Fix the add_lead request: "name" is missing; it needs text (the person's name)."
  instead of the SDK's "Input validation error: ..." text. Objects are strict (unknown fields are named). A
  `UserError` comes back as its message; anything else is "Something went wrong on the server. Nothing was changed."
  and logs only `{"event":"mcp_tool_failed","tool":"<name>"}`.
- **Annotations:** every read tool `readOnlyHint: true`; every write `readOnlyHint: false`, `openWorldHint: false`.
  `destructiveHint` is false except on `undo_change` (undoing an add removes records). `idempotentHint` is true for
  `update_contact`, `update_deal` and `undo_change` (repeating the call changes nothing more; it is refused) and false
  for the adds and `log_activity`.
- **Activity types:** `log_activity` takes `email`, `call`, `meeting` or `note`; `form` only comes in through
  `/intake`.
- **End-to-end:** `tests/e2e/harness.ts` runs `wrangler dev --local --test-scheduled` on a free port with a new temp
  state folder set up by `setupLocalDatabase` from `scripts/dev.mjs` (migrations, defaults, fake seed), in its own
  process group so `stop()` ends wrangler and workerd together. `tests/e2e/d1-errors.test.ts` checks against real
  local D1 (wrangler's `getPlatformProxy`) that a stale write and a foreign-key failure are recognized. Real D1 reports
  them as `D1_ERROR: CHECK constraint failed: ok = 1: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)` and
  `D1_ERROR: FOREIGN KEY constraint failed: ...`, which the existing patterns match, so `src/services` is unchanged.

## Why

The factory-per-request, stateless handler is what the current docs prescribe and the only form that needs no Durable
Object. Parsing arguments in our own wrapper is the one way to give plain-English validation errors while still
advertising real JSON Schemas. Keeping outside text out of headlines means an AI app that only reads the first line
never sees it unlabelled.

## Consequences

- A copy on a custom domain without `MCP_ALLOWED_HOSTNAMES` relies on Cloudflare routing for Host checks; task 11's
  install docs must set it.
- `nodejs_compat` brings Node built-ins into the bundle's reach; the ESLint rule still keeps our own Worker code from
  importing `node:*`.
- Task 8 (intake) and task 11 (import) must set `untrusted_fields` on the deals they create (`["title"]` when the
  title comes from the form) and task 6 on rule tasks whose title template pulls in an outside name.
- Later tasks add their tools in `tools-read.ts` / `tools-write.ts` and their names to the tool-list tests
  (`src/mcp/server.test.ts`, `tests/e2e/mcp.test.ts`).
