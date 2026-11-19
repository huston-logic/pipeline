// The /authorize and /callback handlers against a recording stand-in for the library's helpers, so the exact calls
// are visible. src/auth/oauth-provider.test.ts runs the same handlers through the real library.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { AuthRequest, CompleteAuthorizationOptions, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { jwksServer, makeKey, signJwt } from "../../tests/helpers/jwt.ts";
import { createTestDb } from "../db/sqlite-d1.ts";
import type { Env } from "../env.ts";
import { accessOidcConfig, accessOidcIssuers, handleCallback, oauthUserId } from "./oauth.ts";

const OIDC = "https://example-team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/access-client";
const ORIGINAL: AuthRequest = {
  responseType: "code",
  clientId: "mcp-client",
  redirectUri: "https://client.example.com/callback",
  scope: ["mcp"],
  state: "client-state",
  codeChallenge: "challenge",
  codeChallengeMethod: "S256",
  resource: "https://pipeline-dev.example.workers.dev/mcp",
};

async function setup(t: TestContext, email = "Owner@Example.com") {
  t.mock.method(console, "log", () => {});
  const key = await makeKey("kid-1");
  const env = {
    ENVIRONMENT: "production",
    DB: await createTestDb(),
    ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
    OWNER_EMAILS: "owner@example.com",
    ACCESS_CLIENT_ID: "access-client",
    ACCESS_CLIENT_SECRET: "test-client-secret",
    ACCESS_TOKEN_URL: `${OIDC}/token`,
    ACCESS_AUTHORIZATION_URL: `${OIDC}/authorization`,
    ACCESS_JWKS_URL: `${OIDC}/jwks`,
  } as Env;
  const completed: CompleteAuthorizationOptions[] = [];
  const oauth = {
    async finishUpstream() {
      return { request: ORIGINAL, data: { verifier: "verifier", nonce: "nonce-1" }, headers: new Headers() };
    },
    async completeAuthorization(options: CompleteAuthorizationOptions) {
      completed.push(options);
      return { redirectTo: "https://client.example.com/callback?code=issued&state=client-state" };
    },
  } as unknown as OAuthHelpers;
  const idToken = await signJwt(key, { iss: OIDC, aud: "access-client", email, nonce: "nonce-1", exp: Date.now() / 1000 + 300 });
  const deps = {
    oauth,
    fetchJwks: jwksServer(() => [key]).fetchJwks,
    fetch: (async () => Response.json({ id_token: idToken })) as typeof fetch,
  };
  const call = () => handleCallback(new Request("https://pipeline-dev.example.workers.dev/callback?code=c&state=s"), env, deps);
  return { env, completed, call };
}

test("success calls completeAuthorization with props { email }, a hashed user id and the client's own request", async (t) => {
  const { completed, call } = await setup(t);
  const res = await call();
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), "https://client.example.com/callback?code=issued&state=client-state");
  assert.equal(completed.length, 1);
  const options = completed[0];
  assert.deepEqual(options?.props, { email: "owner@example.com" });
  assert.deepEqual(options?.request, ORIGINAL);
  assert.deepEqual(options?.scope, ["mcp"]);
  assert.equal(options?.userId, await oauthUserId("owner@example.com"));
  assert.match(options?.userId ?? "", /^[0-9a-f]{32}$/);
});

test("a non-owner email never reaches completeAuthorization", async (t) => {
  const { completed, call } = await setup(t, "stranger@example.com");
  assert.equal((await call()).status, 403);
  assert.deepEqual(completed, []);
});

test("Access settings: all five are needed and the URLs must be https", (t) => {
  t.mock.method(console, "log", () => {});
  const env = {
    ACCESS_CLIENT_ID: " id ",
    ACCESS_CLIENT_SECRET: "secret",
    ACCESS_TOKEN_URL: `${OIDC}/token`,
    ACCESS_AUTHORIZATION_URL: `${OIDC}/authorization`,
    ACCESS_JWKS_URL: `${OIDC}/jwks`,
  } as Env;
  const config = accessOidcConfig(env);
  assert.equal(config?.clientId, "id");
  assert.deepEqual(config && accessOidcIssuers(config), [OIDC, "https://example-team.cloudflareaccess.com"]);
  assert.equal(accessOidcConfig({ ...env, ACCESS_CLIENT_SECRET: "" }), null);
  assert.equal(accessOidcConfig({ ...env, ACCESS_JWKS_URL: "not a url" }), null);
  assert.equal(accessOidcConfig({ ...env, ACCESS_AUTHORIZATION_URL: "http://example-team.cloudflareaccess.com/a" }), null);
});
