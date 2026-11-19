// Production /mcp sign-in through the real workers-oauth-provider (decision 0006), with an in-memory KV, a test RSA
// key standing in for Cloudflare Access's signing key, and Access's token endpoint mocked. No network.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { FakeKv } from "../../tests/helpers/fake-kv.ts";
import { jwksServer, makeKey, signJwt, type TestKey } from "../../tests/helpers/jwt.ts";
import { createTestDb } from "../db/sqlite-d1.ts";
import type { Env } from "../env.ts";
import { handleOAuth, type McpHandler } from "./oauth-provider.ts";
import { pkceChallenge } from "./oauth.ts";

const HOST = "pipeline-dev.example.workers.dev";
const ORIGIN = `https://${HOST}`;
const TEAM = "https://example-team.cloudflareaccess.com";
const CLIENT_REDIRECT = "https://client.example.com/callback";
const OWNER = "owner@example.com";

let appCount = 0;

interface Setup {
  env: Env;
  kv: FakeKv;
  key: TestKey;
  oidc: string;
  clientId: string;
  mcpCalls: string[];
  logs: string[];
  tokenRequests: URLSearchParams[];
  /** What Access's token endpoint answers; `nonce` is the one /authorize sent. */
  accessAnswer: (nonce: string) => Promise<Response>;
  send(path: string, init?: RequestInit & { host?: string }): Promise<Response>;
}

async function setup(t: TestContext, overrides: Partial<Env> = {}): Promise<Setup> {
  const db = await createTestDb();
  const kv = new FakeKv(() => Date.now());
  const key = await makeKey("kid-1");
  // A new Access application per test, so no JWKS cache is shared between tests.
  const accessClientId = `access-client-${++appCount}`;
  const oidc = `${TEAM}/cdn-cgi/access/sso/oidc/${accessClientId}`;
  const logs: string[] = [];
  t.mock.method(console, "log", (line: string) => logs.push(line));
  t.mock.method(console, "warn", (line: string) => logs.push(`warn ${line}`));
  const env = {
    ENVIRONMENT: "production",
    DB: db,
    ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
    OAUTH_KV: kv as unknown as KVNamespace,
    OWNER_EMAILS: OWNER,
    ACCESS_CLIENT_ID: accessClientId,
    ACCESS_CLIENT_SECRET: "test-client-secret",
    ACCESS_TOKEN_URL: `${oidc}/token`,
    ACCESS_AUTHORIZATION_URL: `${oidc}/authorization`,
    ACCESS_JWKS_URL: `${oidc}/jwks`,
    ...overrides,
  } as Env;
  const mcpCalls: string[] = [];
  const mcp: McpHandler = async (_request, _env, _ctx, email) => {
    mcpCalls.push(email);
    return new Response("mcp ok");
  };
  const tokenRequests: URLSearchParams[] = [];
  const state: Setup = {
    env,
    kv,
    key,
    oidc,
    clientId: "",
    mcpCalls,
    logs,
    tokenRequests,
    accessAnswer: async (nonce) =>
      Response.json({
        token_type: "Bearer",
        access_token: "access-side-token",
        id_token: await signJwt(key, { iss: oidc, aud: accessClientId, email: OWNER, nonce, exp: Math.floor(Date.now() / 1000) + 300 }),
      }),
    send: (path, init = {}) => {
      const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
      const request = new Request(`https://${init.host ?? HOST}${path}`, init);
      return handleOAuth(request, env, ctx, mcp, {
        fetchJwks: jwksServer(() => [key]).fetchJwks,
        fetch: async (input, requestInit) => {
          assert.equal(String(input), `${oidc}/token`, "the only outbound call is Access's token endpoint");
          const body = new URLSearchParams(String(requestInit?.body));
          tokenRequests.push(body);
          return state.accessAnswer(lastNonce);
        },
      });
    },
  };
  let lastNonce = "";
  const register = await state.send("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CLIENT_REDIRECT], client_name: "<b>Test App</b>", token_endpoint_auth_method: "none" }),
  });
  assert.equal(register.status, 201, await register.clone().text());
  state.clientId = ((await register.json()) as { client_id: string }).client_id;
  // The nonce /authorize sends to Access, captured from its redirect so the fake id token can echo it.
  const send = state.send;
  state.send = async (path, init) => {
    const res = await send(path, init);
    const location = res.headers.get("Location");
    if (location?.startsWith(oidc)) lastNonce = new URL(location).searchParams.get("nonce") ?? "";
    return res;
  };
  return state;
}

/** A minimal cookie jar: the library binds its consent and sign-in state to the browser with __Host- cookies. */
class Jar {
  readonly cookies = new Map<string, string>();
  take(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";");
      const [name = "", value = ""] = pair.split("=");
      if (attributes.some((a) => a.trim() === "Max-Age=0")) this.cookies.delete(name.trim());
      else this.cookies.set(name.trim(), value.trim());
    }
    return res;
  }
  get header() {
    return [...this.cookies].map(([n, v]) => `${n}=${v}`).join("; ");
  }
}

/** A page's text with the HTML apostrophe escape undone, for matching messages. */
const pageText = async (res: Response) => (await res.text()).replaceAll("&#39;", "'");

const VERIFIER = "client-side-pkce-verifier-0123456789-abcdefghijklmnop";

async function authorizeUrl(clientId: string) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    state: "client-state",
    code_challenge: await pkceChallenge(VERIFIER),
    code_challenge_method: "S256",
    resource: `${ORIGIN}/mcp`,
  });
  return `/authorize?${params}`;
}

/** Consent page, Allow, and the redirect to Access. Returns the redirect's query and the cookie jar. */
async function toAccess(s: Setup) {
  const jar = new Jar();
  const consent = jar.take(await s.send(await authorizeUrl(s.clientId)));
  assert.equal(consent.status, 200);
  const handle = /name="handle" value="([^"]+)"/.exec(await consent.text())?.[1] ?? "";
  const allow = jar.take(
    await s.send("/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: jar.header },
      body: new URLSearchParams({ handle, decision: "approve" }),
    }),
  );
  assert.equal(allow.status, 302);
  const location = new URL(allow.headers.get("Location") ?? "");
  return { jar, location };
}

async function callback(s: Setup, jar: Jar, query: Record<string, string>) {
  return jar.take(await s.send(`/callback?${new URLSearchParams(query)}`, { headers: { Cookie: jar.header } }));
}

test("/mcp without a token is 401 with the library's challenge, and the metadata names our endpoints", async (t) => {
  const s = await setup(t);
  const res = await s.send("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("WWW-Authenticate") ?? "", /^Bearer realm="OAuth", resource_metadata="https:\/\/pipeline-dev\.example\.workers\.dev\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.match(res.headers.get("Content-Security-Policy") ?? "", /default-src 'self'/);
  assert.deepEqual(s.mcpCalls, []);

  const bad = await s.send("/mcp", { method: "POST", headers: { Authorization: "Bearer a:b:c" }, body: "{}" });
  assert.equal(bad.status, 401);

  const resource = (await (await s.send("/.well-known/oauth-protected-resource/mcp")).json()) as Record<string, unknown>;
  assert.equal(resource.resource, `${ORIGIN}/mcp`);
  const server = (await (await s.send("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
  assert.equal(server.authorization_endpoint, `${ORIGIN}/authorize`);
  assert.equal(server.token_endpoint, `${ORIGIN}/token`);
  assert.equal(server.registration_endpoint, `${ORIGIN}/register`);
  assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);
});

test("the consent page escapes the app's name, shows where access goes, and allows the Access and client origins as form targets", async (t) => {
  const s = await setup(t);
  const res = await s.send(await authorizeUrl(s.clientId));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<h1>Allow &lt;b&gt;Test App&lt;\/b&gt; to use your pipeline\?<\/h1>/);
  assert.doesNotMatch(body, /<b>Test App/);
  assert.match(body, /the access goes to <strong>client\.example\.com<\/strong>/);
  assert.match(body, /isn't verified/);
  const csp = res.headers.get("Content-Security-Policy") ?? "";
  assert.match(csp, /form-action 'self' https:\/\/example-team\.cloudflareaccess\.com https:\/\/client\.example\.com;/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.ok(res.headers.getSetCookie().some((c) => c.startsWith("__Host-oauth-consent-")));
});

test("Allow redirects to Access with our client id, the /callback URL, state, nonce and a PKCE S256 challenge", async (t) => {
  const s = await setup(t);
  const { location, jar } = await toAccess(s);
  assert.equal(`${location.origin}${location.pathname}`, `${s.oidc}/authorization`);
  const q = location.searchParams;
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("client_id"), s.env.ACCESS_CLIENT_ID);
  assert.equal(q.get("redirect_uri"), `${ORIGIN}/callback`);
  assert.equal(q.get("scope"), "openid email profile");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.match(q.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.match(q.get("state") ?? "", /^[A-Za-z0-9_-]{40,}$/);
  assert.match(q.get("nonce") ?? "", /^[A-Za-z0-9_-]{40,}$/);
  assert.ok([...jar.cookies.keys()].some((name) => name.startsWith("__Host-oauth-upstream-")), "the state is bound to this browser");
  // The state is stored in OAUTH_KV with a 10-minute TTL (by hash; the value is encrypted).
  const stored = [...s.kv.entries].filter(([name]) => name.startsWith("transaction:"));
  assert.equal(stored.length, 1);
  assert.ok(stored[0] && Math.abs((stored[0][1].expiresAt ?? 0) - Date.now() - 600_000) < 5_000);
  assert.deepEqual(s.kv.keysContaining(q.get("state") ?? "-"), []);
});

test("the whole sign-in: callback, token, then /mcp gets the owner's email; nothing secret is stored or logged in plain text", async (t) => {
  const s = await setup(t);
  const { location, jar } = await toAccess(s);
  const res = await callback(s, jar, { code: "access-code-1", state: location.searchParams.get("state") ?? "" });
  assert.equal(res.status, 302);
  const back = new URL(res.headers.get("Location") ?? "");
  assert.equal(`${back.origin}${back.pathname}`, CLIENT_REDIRECT);
  assert.equal(back.searchParams.get("state"), "client-state");
  assert.equal(back.searchParams.get("iss"), ORIGIN);
  const code = back.searchParams.get("code") ?? "";
  assert.ok(code);

  // The code exchange at Access: our client id and secret, the same redirect URI, and the PKCE verifier.
  assert.equal(s.tokenRequests.length, 1);
  const sent = s.tokenRequests[0] ?? new URLSearchParams();
  assert.equal(sent.get("grant_type"), "authorization_code");
  assert.equal(sent.get("code"), "access-code-1");
  assert.equal(sent.get("redirect_uri"), `${ORIGIN}/callback`);
  assert.equal(sent.get("client_id"), s.env.ACCESS_CLIENT_ID);
  assert.equal(sent.get("client_secret"), "test-client-secret");
  assert.equal(await pkceChallenge(sent.get("code_verifier") ?? ""), location.searchParams.get("code_challenge"));

  const token = await s.send("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CLIENT_REDIRECT, client_id: s.clientId, code_verifier: VERIFIER }),
  });
  assert.equal(token.status, 200);
  const { access_token: accessToken, refresh_token: refreshToken } = (await token.json()) as Record<string, string>;
  assert.ok(accessToken && refreshToken);
  assert.ok(!accessToken.includes(OWNER) && !accessToken.includes(encodeURIComponent(OWNER)), "the token doesn't carry the email");

  const mcp = await s.send("/mcp", { method: "POST", headers: { Authorization: `Bearer ${accessToken}` }, body: "{}" });
  assert.equal(mcp.status, 200);
  assert.equal(await mcp.text(), "mcp ok");
  assert.deepEqual(s.mcpCalls, [OWNER]);

  assert.deepEqual(s.kv.keysContaining(OWNER), [], "props are encrypted and the user id is a hash");
  for (const secret of [accessToken, refreshToken, code, "access-code-1", "test-client-secret", OWNER]) {
    assert.ok(!s.logs.some((line) => line.includes(secret)), "logs hold no tokens, codes, secrets or emails");
  }
  assert.ok(s.logs.includes(JSON.stringify({ event: "oauth_authorized" })));
});

test("a token issued to an owner stops working on /mcp once the email is no longer an owner", async (t) => {
  const s = await setup(t);
  const { location, jar } = await toAccess(s);
  const back = new URL((await callback(s, jar, { code: "c", state: location.searchParams.get("state") ?? "" })).headers.get("Location") ?? "");
  const token = await s.send("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code") ?? "", redirect_uri: CLIENT_REDIRECT, client_id: s.clientId, code_verifier: VERIFIER }),
  });
  const { access_token: accessToken } = (await token.json()) as Record<string, string>;
  s.env.OWNER_EMAILS = "someone-else@example.com";
  const mcp = await s.send("/mcp", { method: "POST", headers: { Authorization: `Bearer ${accessToken}` }, body: "{}" });
  assert.equal(mcp.status, 403);
  assert.deepEqual(s.mcpCalls, []);
});

test("/callback refuses a missing, tampered, reused or expired state, or one from another browser", async (t) => {
  const s = await setup(t);
  const { location, jar } = await toAccess(s);
  const state = location.searchParams.get("state") ?? "";
  const queries: Record<string, string>[] = [{ code: "c" }, { code: "c", state: `${state}x` }];
  for (const query of queries) {
    const res = await callback(s, jar, query);
    assert.equal(res.status, 400, JSON.stringify(query));
    assert.match(await res.text(), /expired or was already used/);
  }
  const otherBrowser = await s.send(`/callback?${new URLSearchParams({ code: "c", state })}`);
  assert.equal(otherBrowser.status, 400);
  assert.equal(s.tokenRequests.length, 0);

  const cookies = jar.header;
  const ok = await callback(s, jar, { code: "c", state });
  assert.equal(ok.status, 302);
  const reused = await s.send(`/callback?${new URLSearchParams({ code: "c", state })}`, { headers: { Cookie: cookies } });
  assert.equal(reused.status, 400);

  const later = await setup(t);
  const second = await toAccess(later);
  const realNow = Date.now;
  later.kv.now = () => realNow() + 601_000;
  const expired = await callback(later, second.jar, { code: "c", state: second.location.searchParams.get("state") ?? "" });
  assert.equal(expired.status, 400);
  assert.equal(later.tokenRequests.length, 0);
});

test("a failed code exchange at Access is a 502 page, and nothing is authorized", async (t) => {
  const s = await setup(t);
  s.accessAnswer = async () => Response.json({ error: "invalid_grant" }, { status: 400 });
  const { location, jar } = await toAccess(s);
  const res = await callback(s, jar, { code: "c", state: location.searchParams.get("state") ?? "" });
  assert.equal(res.status, 502);
  assert.match(await pageText(res), /didn't finish the sign-in/);
  assert.ok(s.logs.includes(JSON.stringify({ event: "oauth_token_exchange_failed", status: 400 })));
  assert.equal([...s.kv.entries.keys()].filter((k) => k.startsWith("grant:")).length, 0);
});

test("an id token signed by another key, for another app, or with the wrong nonce is refused", async (t) => {
  const s = await setup(t);
  const stranger = await makeKey("kid-1");
  const answers = [
    async (nonce: string) =>
      Response.json({ id_token: await signJwt(stranger, { iss: s.oidc, aud: s.env.ACCESS_CLIENT_ID, email: OWNER, nonce, exp: Date.now() / 1000 + 300 }) }),
    async (nonce: string) =>
      Response.json({ id_token: await signJwt(s.key, { iss: s.oidc, aud: "another-app", email: OWNER, nonce, exp: Date.now() / 1000 + 300 }) }),
    async () => Response.json({ id_token: await signJwt(s.key, { iss: s.oidc, aud: s.env.ACCESS_CLIENT_ID, email: OWNER, nonce: "replayed", exp: Date.now() / 1000 + 300 }) }),
    async (nonce: string) =>
      Response.json({ id_token: await signJwt(s.key, { iss: "https://other-team.cloudflareaccess.com", aud: s.env.ACCESS_CLIENT_ID, email: OWNER, nonce, exp: Date.now() / 1000 + 300 }) }),
  ];
  for (const answer of answers) {
    s.accessAnswer = answer;
    const { location, jar } = await toAccess(s);
    const res = await callback(s, jar, { code: "c", state: location.searchParams.get("state") ?? "" });
    assert.equal(res.status, 401);
    assert.match(await pageText(res), /couldn't be verified/);
  }
  assert.equal([...s.kv.entries.keys()].filter((k) => k.startsWith("grant:")).length, 0);
});

test("an Access account whose email isn't an owner gets 403 and no authorization", async (t) => {
  const s = await setup(t);
  s.accessAnswer = async (nonce) =>
    Response.json({ id_token: await signJwt(s.key, { iss: s.oidc, aud: s.env.ACCESS_CLIENT_ID, email: "stranger@example.com", nonce, exp: Date.now() / 1000 + 300 }) });
  const { location, jar } = await toAccess(s);
  const res = await callback(s, jar, { code: "c", state: location.searchParams.get("state") ?? "" });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("Location"), null);
  assert.match(await pageText(res), /isn't allowed to use this pipeline/);
  assert.equal([...s.kv.entries.keys()].filter((k) => k.startsWith("grant:")).length, 0);
});

test("Deny, or Access answering with an error, sends the client access_denied with its state", async (t) => {
  const s = await setup(t);
  const jar = new Jar();
  const consent = jar.take(await s.send(await authorizeUrl(s.clientId)));
  const handle = /name="handle" value="([^"]+)"/.exec(await consent.text())?.[1] ?? "";
  const denied = await s.send("/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: jar.header },
    body: new URLSearchParams({ handle, decision: "deny" }),
  });
  assert.equal(denied.status, 302);
  const deniedTo = new URL(denied.headers.get("Location") ?? "");
  assert.equal(deniedTo.searchParams.get("error"), "access_denied");
  assert.equal(deniedTo.searchParams.get("state"), "client-state");

  const { location, jar: jar2 } = await toAccess(s);
  const res = await callback(s, jar2, { error: "access_denied", state: location.searchParams.get("state") ?? "" });
  assert.equal(res.status, 302);
  assert.equal(new URL(res.headers.get("Location") ?? "").searchParams.get("error"), "access_denied");
  assert.equal(s.tokenRequests.length, 0);
});

test("an unknown client or redirect URI is shown an error page, never redirected", async (t) => {
  const s = await setup(t);
  const unknown = await s.send(`/authorize?${new URLSearchParams({ response_type: "code", client_id: "nope", redirect_uri: "https://evil.example.com/cb", state: "x" })}`);
  assert.equal(unknown.status, 400);
  assert.equal(unknown.headers.get("Location"), null);
  const wrongRedirect = (await authorizeUrl(s.clientId)).replace(encodeURIComponent(CLIENT_REDIRECT), encodeURIComponent("https://evil.example.com/cb"));
  const res = await s.send(wrongRedirect);
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("Location"), null);
});

test("missing Access settings or OAUTH_KV fail closed with 500", async (t) => {
  for (const missing of ["ACCESS_CLIENT_ID", "ACCESS_CLIENT_SECRET", "ACCESS_TOKEN_URL", "ACCESS_AUTHORIZATION_URL", "ACCESS_JWKS_URL"] as const) {
    const s = await setup(t);
    s.env[missing] = undefined;
    const res = await s.send(await authorizeUrl(s.clientId));
    assert.equal(res.status, 500, missing);
    assert.match(await pageText(res), /Sign-in isn't set up yet\./);
  }
  const s = await setup(t);
  s.env.ACCESS_TOKEN_URL = "http://example-team.cloudflareaccess.com/token";
  assert.equal((await s.send(await authorizeUrl(s.clientId))).status, 500, "only https Access URLs");
  s.env.OAUTH_KV = undefined;
  const res = await s.send("/mcp", { method: "POST", body: "{}" });
  assert.equal(res.status, 500);
  assert.match(await res.text(), /Sign-in isn't set up yet\./);
});

test("a custom domain answers only when MCP_ALLOWED_HOSTNAMES lists it", async (t) => {
  const s = await setup(t);
  const custom = await s.send("/.well-known/oauth-authorization-server", { host: "pipeline.example.com" });
  assert.equal(custom.status, 403);
  assert.match(await custom.text(), /MCP_ALLOWED_HOSTNAMES/);
  s.env.MCP_ALLOWED_HOSTNAMES = "pipeline.example.com";
  const listed = await s.send("/.well-known/oauth-authorization-server", { host: "pipeline.example.com" });
  assert.equal(listed.status, 200);
  assert.equal(((await listed.json()) as { issuer: string }).issuer, "https://pipeline.example.com");
  assert.equal((await s.send("/.well-known/oauth-authorization-server")).status, 403, "only the listed hosts");
});

/** A Rate Limiting binding that allows `allowed` calls per key, recording each key. */
function limiter(allowed: number) {
  const keys: string[] = [];
  const counts = new Map<string, number>();
  return {
    keys,
    binding: {
      async limit({ key }: { key: string }) {
        keys.push(key);
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return { success: n <= allowed };
      },
    },
  };
}

test("/register and /authorize are rate limited per client IP with a plain 429; /token and /mcp are not", async (t) => {
  const s = await setup(t);
  const { keys, binding } = limiter(1);
  s.env.OAUTH_RATE_LIMIT = binding;
  const ip = (address: string) => ({ "CF-Connecting-IP": address });
  const register = (address: string) =>
    s.send("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ip(address) },
      body: JSON.stringify({ redirect_uris: [CLIENT_REDIRECT], client_name: "Another App", token_endpoint_auth_method: "none" }),
    });

  assert.equal((await register("192.0.2.1")).status, 201);
  const limited = await register("192.0.2.1");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "60");
  assert.match(limited.headers.get("Content-Type") ?? "", /^text\/plain/);
  assert.match(await limited.text(), /Too many requests/);
  assert.match(limited.headers.get("Content-Security-Policy") ?? "", /default-src 'self'/);
  assert.equal((await register("192.0.2.2")).status, 201, "another IP has its own count");

  const url = await authorizeUrl(s.clientId);
  assert.equal((await s.send(url, { headers: ip("192.0.2.3") })).status, 200);
  assert.equal((await s.send(url, { headers: ip("192.0.2.3") })).status, 429);

  const before = keys.length;
  await s.send("/token", { method: "POST", headers: ip("192.0.2.1"), body: "grant_type=authorization_code" });
  await s.send("/mcp", { method: "POST", headers: ip("192.0.2.1"), body: "{}" });
  await s.send("/.well-known/oauth-authorization-server", { headers: ip("192.0.2.1") });
  assert.equal(keys.length, before, "only /register and /authorize count");
});

test("without the rate limit binding the sign-in still works and a fixed log line says so", async (t) => {
  const s = await setup(t);
  assert.equal((await s.send(await authorizeUrl(s.clientId))).status, 200);
  assert.ok(s.logs.some((line) => line === JSON.stringify({ event: "oauth_rate_limit_missing" })));
});

test("HEAD /authorize checks the request but starts no consent: no cookie and nothing written to KV", async (t) => {
  const s = await setup(t);
  const stored = s.kv.entries.size;
  const res = await s.send(await authorizeUrl(s.clientId), { method: "HEAD" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.headers.getSetCookie(), []);
  assert.equal(s.kv.entries.size, stored);
  assert.equal(await res.text(), "");

  const bad = await s.send("/authorize?client_id=nope&response_type=code", { method: "HEAD" });
  assert.equal(bad.status, 400);
});
