# 0006: Production sign-in

## Context

The spec says production sign-in is Cloudflare Access (a one-time code by email) with the allowed owner email(s) from
config: `/mcp` through OAuth with `workers-oauth-provider` and Access as the upstream provider ("Secure MCP servers
with Access for SaaS" and the Agents authorization page), the board and `/api` behind an Access self-hosted
application whose `Cf-Access-Jwt-Assertion` the Worker also verifies, `/intake` outside Access, and a dev mode that
production refuses. It left open which of the library's APIs to use for one Worker, how the OAuth resource URL is set
for a copy whose hostname the repo can't know, what the consent step looks like, how tokens are checked, and what
happens before a copy is set up.

What was followed: the Cloudflare docs notes in the plan folder (read 2026-11-18) and the installed
`@cloudflare/workers-oauth-provider` 1.2.4 README, `docs/` (resource-servers, upstream-sign-in, consent-page,
authorization-server, mcp-discovery, migration-1.x) and `dist/oauth-provider.d.ts`.

## Decision

- **Package:** `@cloudflare/workers-oauth-provider` 1.2.4, exact (no runtime dependencies). It needs the `OAUTH_KV`
  KV binding; the `global_fetch_strictly_public` compatibility flag is on too (the library asks for it, and the
  Worker's outbound calls, to Resend and Access, are all public).
- **One Worker: the combined `OAuthProvider`.** The README says the split `OAuthAuthorizationServer` /
  `OAuthResourceServer` classes are the recommended shape for two Workers, and that `OAuthProvider` "remains fully
  supported for one Worker that is both the authorization server and its only resource". One Worker per copy keeps
  install simple, so `src/auth/oauth-provider.ts` uses `OAuthProvider` with `apiRoute: "/mcp"`,
  `authorizeEndpoint: "/authorize"`, `tokenEndpoint: "/token"`, `clientRegistrationEndpoint: "/register"` (dynamic
  client registration on) and `resourceMetadata.resource` = `<origin>/mcp`. The library serves `/token`, `/register`,
  `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp` and the `401` with its
  `WWW-Authenticate` challenge on `/mcp`; `/authorize` and `/callback` are ours (`src/auth/oauth.ts`). Client ID
  Metadata Documents stay off (the spec asks for registration; CIMD can be turned on later with one option).
- **The resource comes from the request's origin.** 1.x requires a fixed canonical resource, and the migration guide
  says a Worker on several hostnames "can build the provider per request with `${new URL(request.url).origin}/mcp`".
  The provider is built per request (cheap: options only). To keep that origin honest, the OAuth paths answer only on
  a host listed in `MCP_ALLOWED_HOSTNAMES` when it is set, otherwise only on `*.workers.dev` (preview URLs included)
  and loopback hosts; a custom domain that isn't listed gets 403 with a message naming the variable. The provider gets
  a copy of `env`, because the library stores its per-origin helpers on the `env` object it is given.
- **Consent page before Access.** With dynamic registration anyone can register a client with their own redirect URI,
  and an owner with a live Access session could be signed in silently. The library's docs (and MCP's security
  guidance on confused deputies) require consent per client before the upstream redirect, so `GET /authorize`
  validates the request (`parseAuthRequest`), then shows a consent page (`describeConsent`, `beginConsent`): the app's
  name (escaped, and marked unverified), where the access goes (the redirect host, with a warning for a local app), and
  Allow / Deny. `POST /authorize` is the answer: Deny is `denyConsent` (back to the client with `access_denied`), Allow
  is `approveConsent` and then `beginUpstream`. The page is a board page (no script); its CSP adds the Access
  origin and the client's redirect origin to `form-action`, because browsers apply `form-action` to the redirects
  that follow a form post.
- **Access for SaaS (OIDC) as the upstream.** `beginUpstream` creates the `state`, stores the approved request with our
  data (the PKCE verifier and an OIDC nonce) in `OAUTH_KV` for 10 minutes, encrypted, keyed by its hash, single use,
  and binds it to the browser with a `__Host-` cookie. The redirect to `ACCESS_AUTHORIZATION_URL` carries
  `response_type=code`, `client_id`, `redirect_uri=<origin>/callback`, `scope=openid email profile`, `state`, `nonce`
  and an S256 `code_challenge`. `/callback` calls `finishUpstream` (bad, reused, expired or other-browser state: a
  400 page, nothing sent anywhere), passes an Access `error` back to the client as `access_denied`, exchanges the code
  at `ACCESS_TOKEN_URL` (`client_secret_post`: client id and secret in the form body, plus `code_verifier`), and
  verifies the `id_token` (RS256 against `ACCESS_JWKS_URL`; `aud` = the client id; `iss` = the app's OIDC base URL,
  which is the token endpoint without `/token`, or the team domain; `exp`/`nbf` with 60 s skew; the nonce). The email
  must be an owner email (below), or the answer is a 403 page and no grant is written. Then `completeAuthorization`
  with `props: { email }`, the client's own scopes, and `userId` = the first 32 hex characters of SHA-256 of the
  lowercased email (the library puts `userId` in KV keys and at the start of every token, so the email itself never
  appears there; `props` are encrypted by the library).
- **/mcp.** The library checks the bearer token, then our handler re-checks that `props.email` is still an owner email
  (removing an owner cuts off tokens issued before; 403 otherwise) and calls the MCP handler with it, so tools get it
  through `getMcpAuthContext()` as before. Scopes are not used for access: the owner's token can do what the owner can.
  Token lifetimes are the library's defaults (1 hour access tokens, 30-day refresh grants).
- **The board and `/api`.** `src/auth/access.ts`: the token from `Cf-Access-Jwt-Assertion` (fallback: the
  `CF_Authorization` cookie), verified by `verifyAccessJwt` (`src/auth/access-jwt.ts` over `src/auth/jwt.ts`): RS256
  only (`none`, HS256 and everything else refused before a key is used), `iss` = `https://<team>.cloudflareaccess.com`,
  `aud` contains `ACCESS_AUD`, `exp` required, `exp`/`nbf` with at most 60 s skew, an `email` claim. Keys from
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, cached per isolate for 5 minutes; an unknown `kid`
  refetches once, at most every 30 seconds. Answers: no or bad token 401 "Sign in through Cloudflare Access to open the
  board."; not an owner 403; keys unreachable 503; never any detail of why a token failed.
- **Owner emails** are `settings.owner_emails` (decision 0005) plus the comma-separated `OWNER_EMAILS` var, compared
  trimmed and lowercased.
- **Fail closed before set-up.** Missing `ACCESS_TEAM_DOMAIN` (or one that isn't `<team>.cloudflareaccess.com`),
  `ACCESS_AUD`, or any owner email: the board and `/api` answer 500 "Sign-in isn't set up yet.". Missing `OAUTH_KV`:
  every OAuth path answers the same; any of the five `ACCESS_*` OIDC secrets missing, or a URL that isn't https:
  `/authorize` and `/callback` do.
- **Modes.** `src/auth/dev.ts` `authMode()`: no `AUTH_MODE` (or empty) is production sign-in, in any environment;
  `AUTH_MODE=dev` is the local dev sign-in exactly as before (only with `ENVIRONMENT=development` on a loopback host,
  else 500 on every route); any other value is a 500 misconfiguration. The e2e tests stay in dev mode.
- **Rate limit on the paths that write before sign-in** (task 11). `/register` stores a client record and `GET
  /authorize` starts a consent (a stored handle and a cookie), both before anyone has signed in, so anyone could make
  the copy write to `OAUTH_KV` in a loop and use up the free plan's 1,000 KV writes a day, which would stop the
  owner's own sign-ins and token refreshes until the next day. The `OAUTH_RATE_LIMIT` Rate Limiting binding (20 per
  60 s per `CF-Connecting-IP`, top level and in `previews`) answers 429 in plain text with `Retry-After: 60` on those
  two paths before the library runs; without the binding they still work and log `oauth_rate_limit_missing`. `HEAD
  /authorize` validates the request like `GET` but never calls `beginConsent`, so it writes nothing.
- **Outside both sign-ins:** `/intake` (its own secret, decision 0012) and static files and the 404 page (no data).
- **Logs** hold fixed event names, status codes and the library's error codes and reason slugs only, never a token,
  code, email, secret or `props`; the library's default error logger (which prints the error description) is
  replaced.
- **Tests.** Unit tests only, no network: a locally generated RSA key signs the Access and id tokens, an in-memory KV
  (`tests/helpers/fake-kv.ts`) backs the real library, and Access's token endpoint is mocked. Node can't load the
  library's `cloudflare:workers` import, so `npm run test:unit` preloads `tests/helpers/workers-runtime.mjs`, which
  resolves it to a stub with an empty `WorkerEntrypoint` class (the library only uses it for `instanceof`).

## Why

The combined provider is the one documented way to keep one Worker per copy. Building it from the request origin is
the documented answer for a hostname the code can't know, and the host check keeps an unknown hostname from becoming
a token audience. The consent page is what makes dynamic registration safe with an upstream sign-in. Letting the
library own state, PKCE for its own clients, code and token storage (hashed, encrypted props) leaves this repo only the
parts that are specific to Access, each tested.

## Consequences

- Each copy needs the Access setup in `docs/ACCESS-SETUP.md`: two Access applications and bypass rules, five secrets,
  four vars and a KV namespace. Task 11's provisioning writes the vars and the KV ids into the copy's config
  (decision 0007).
- The id token's `iss` is accepted as either the app's OIDC base URL or the team domain; the first live sign-in should
  confirm which one Access sends (see the report). Both belong to the owner's team, and the key and `aud` checks bind
  the token to this app.
- PKCE towards Access is sent on every sign-in; if the Access app's PKCE setting rejects confidential clients that
  send it, that shows on the first live sign-in.
- The consent page appears on every new connection (remembered consent would need another secret).
- The library's KV data expires by TTL; `purgeExpiredData()` from the cron is not wired yet (not needed for a single
  owner; revisit if `OAUTH_KV` grows).
- A copy reachable on both its workers.dev host and a custom domain issues tokens per host; set
  `MCP_ALLOWED_HOSTNAMES` to the one host clients use.
- The rate limit is per IP and per Cloudflare location, so a flood from many addresses can still spend KV writes; it
  raises the cost a lot without blocking a real owner (a connection makes about three limited requests). If KV writes
  still run out, Workers Paid lifts the KV limit (docs/PAID-PLAN.md).
- **`form-action` and redirect chains (not yet confirmed live).** Browsers apply the consent page's `form-action` to
  every redirect that follows the Allow or Deny post. The policy lists this origin, the Access authorization origin and
  the client's redirect origin, so a chain that passes through another origin (an identity provider in front of
  Access, or Access redirecting via another host) or ends at a custom-scheme client (`appname://callback`, which has
  no web origin to list) may be blocked by the browser. Confirm on the first live connection (docs/ACCESS-SETUP.md,
  "If Allow seems to do nothing"); the likely fix is to add the redirect's scheme for a non-https client.
