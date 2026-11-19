import assert from "node:assert/strict";
import { test } from "node:test";
import { jwksServer, makeKey, signJwt } from "../../tests/helpers/jwt.ts";
import { createTestDb } from "../db/sqlite-d1.ts";
import type { Env } from "../env.ts";
import { accessSignIn } from "./access.ts";
import { isOwnerEmail, parseOwnerEmailsVar } from "./owners.ts";

const TEAM = "example-team.cloudflareaccess.com";
const AUD = "aud-tag-0123456789abcdef";
const NOW = Date.parse("2026-11-19T18:00:00.000Z");

async function setup(env: Partial<Env> = {}, ownersInSettings: string[] = []) {
  const db = await createTestDb();
  await db.prepare("UPDATE settings SET owner_emails = ? WHERE id = 1").bind(JSON.stringify(ownersInSettings)).run();
  const key = await makeKey("kid-1");
  const server = jwksServer(() => [key]);
  const fullEnv = {
    ENVIRONMENT: "production",
    DB: db,
    ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    OWNER_EMAILS: "owner@example.com",
    ...env,
  } as Env;
  const token = (claims: Record<string, unknown> = {}) =>
    signJwt(key, { iss: `https://${TEAM}`, aud: [AUD], email: "owner@example.com", exp: NOW / 1000 + 600, ...claims });
  const signIn = (request: Request) => accessSignIn(request, fullEnv, { fetchJwks: server.fetchJwks, now: () => NOW });
  return { db, env: fullEnv, token, signIn, server };
}

const board = (headers: Record<string, string> = {}) => new Request("https://pipeline.example.com/", { headers });

test("OWNER_EMAILS is comma-separated and case-insensitive; settings.owner_emails counts too", async () => {
  assert.deepEqual(parseOwnerEmailsVar(" A@Example.com, ,b@example.com "), ["a@example.com", "b@example.com"]);
  const { db, env } = await setup({ OWNER_EMAILS: "first@example.com" }, ["Second@Example.com"]);
  assert.equal(await isOwnerEmail(db, env, "FIRST@example.com"), true);
  assert.equal(await isOwnerEmail(db, env, "second@example.com"), true);
  assert.equal(await isOwnerEmail(db, env, "third@example.com"), false);
});

test("a valid Access token from the header or the CF_Authorization cookie signs the owner in", async () => {
  const { token, signIn } = await setup();
  assert.deepEqual(await signIn(board({ "Cf-Access-Jwt-Assertion": await token() })), { ok: true, email: "owner@example.com" });
  assert.deepEqual(await signIn(board({ Cookie: `theme=dark; CF_Authorization=${await token()}` })), {
    ok: true,
    email: "owner@example.com",
  });
});

test("no token, or a bad one, is 401 with no details", async () => {
  const { token, signIn } = await setup();
  const cases: Record<string, string>[] = [{}, { "Cf-Access-Jwt-Assertion": "junk" }, { "Cf-Access-Jwt-Assertion": await token({ aud: ["other"] }) }];
  for (const headers of cases) {
    const result = await signIn(board(headers));
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.status, 401);
    assert.doesNotMatch(result.message, /aud|signature|kid|expired|token isn't valid/i);
  }
});

test("a valid token for an email that isn't an owner is 403", async () => {
  const { token, signIn } = await setup();
  const result = await signIn(board({ "Cf-Access-Jwt-Assertion": await token({ email: "stranger@example.com" }) }));
  assert.deepEqual(result, { ok: false, status: 403, message: "This account isn't allowed to open this board." });
});

test("missing ACCESS_TEAM_DOMAIN, ACCESS_AUD or any owner email fails closed with 500", async () => {
  for (const env of [{ ACCESS_TEAM_DOMAIN: undefined }, { ACCESS_AUD: undefined }, { ACCESS_AUD: " " }, { ACCESS_TEAM_DOMAIN: "example.com" }, { OWNER_EMAILS: undefined }]) {
    const { token, signIn, server } = await setup(env);
    const result = await signIn(board({ "Cf-Access-Jwt-Assertion": await token() }));
    assert.deepEqual(result, { ok: false, status: 500, message: "Sign-in isn't set up yet." }, JSON.stringify(env));
    assert.equal(server.calls.length, 0);
  }
});

test("keys that can't be fetched are 503, not a sign-in", async (t) => {
  const failed = t.mock.method(console, "error", () => {});
  const { env, token } = await setup();
  const result = await accessSignIn(board({ "Cf-Access-Jwt-Assertion": await token() }), env, {
    fetchJwks: async () => {
      throw new Error("down");
    },
    now: () => NOW,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 503);
  assert.deepEqual(failed.mock.calls.map((c) => c.arguments[0]), [JSON.stringify({ event: "access_keys_unavailable" })]);
});
