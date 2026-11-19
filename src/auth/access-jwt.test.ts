import assert from "node:assert/strict";
import { test } from "node:test";
import { hs256Jwt, jwksServer, makeKey, signJwt, unsignedJwt } from "../../tests/helpers/jwt.ts";
import { accessCertsUrl, accessIssuer, JwtError, verifyAccessJwt } from "./access-jwt.ts";

const TEAM = "example-team.cloudflareaccess.com";
const ISS = "https://example-team.cloudflareaccess.com";
const AUD = "aud-tag-0123456789abcdef";
const NOW = Date.parse("2026-11-19T18:00:00.000Z");
const nowS = NOW / 1000;

const claims = (over: Record<string, unknown> = {}) => ({
  iss: ISS,
  aud: [AUD],
  email: "Owner@Example.com",
  sub: "user-1",
  iat: nowS - 10,
  nbf: nowS - 10,
  exp: nowS + 600,
  ...over,
});

async function setup() {
  const key = await makeKey("kid-1");
  const server = jwksServer(() => [key]);
  const verify = (token: string, now = NOW) =>
    verifyAccessJwt(token, { teamDomain: TEAM, aud: AUD, fetchJwks: server.fetchJwks, now: () => now });
  return { key, server, verify };
}

test("the team domain gives the issuer and the certs URL; anything but <team>.cloudflareaccess.com is refused", () => {
  for (const domain of [TEAM, `https://${TEAM}`, `https://${TEAM}/`, "Example-Team.CloudflareAccess.com"]) {
    assert.equal(accessIssuer(domain), ISS, domain);
  }
  assert.equal(accessCertsUrl(TEAM), `${ISS}/cdn-cgi/access/certs`);
  for (const domain of ["", "example.com", "evil.example.com/.cloudflareaccess.com", "a.b.cloudflareaccess.com", "http://x.cloudflareaccess.com"]) {
    assert.equal(accessIssuer(domain), null, domain);
  }
});

test("a valid RS256 token gives its email, lowercased", async () => {
  const { key, server, verify } = await setup();
  assert.deepEqual(await verify(await signJwt(key, claims())), { email: "owner@example.com" });
  assert.deepEqual(server.calls, [`${ISS}/cdn-cgi/access/certs`]);
  // A string aud works too.
  assert.deepEqual(await verify(await signJwt(key, claims({ aud: AUD }))), { email: "owner@example.com" });
});

test("wrong aud, wrong iss, missing email are refused", async () => {
  const { key, verify } = await setup();
  for (const over of [
    { aud: ["another-app"] },
    { aud: "another-app" },
    { aud: [] },
    { iss: "https://other-team.cloudflareaccess.com" },
    { iss: `${ISS}/` },
    { email: undefined },
    { email: "" },
  ]) {
    await assert.rejects(verify(await signJwt(key, claims(over))), JwtError, JSON.stringify(over));
  }
});

test("expired and not-yet-valid tokens are refused, with at most 60 seconds of clock skew", async () => {
  const { key, verify } = await setup();
  await assert.rejects(verify(await signJwt(key, claims({ exp: nowS - 61 }))), JwtError);
  assert.ok(await verify(await signJwt(key, claims({ exp: nowS - 59 }))));
  await assert.rejects(verify(await signJwt(key, claims({ nbf: nowS + 61 }))), JwtError);
  assert.ok(await verify(await signJwt(key, claims({ nbf: nowS + 59 }))));
  await assert.rejects(verify(await signJwt(key, claims({ exp: undefined }))), JwtError, "exp is required");
});

test("alg none, HS256 and a bad signature are refused", async () => {
  const { key, verify } = await setup();
  const other = await makeKey("kid-1");
  for (const token of [
    unsignedJwt(key, claims()),
    await hs256Jwt(key, claims()),
    await signJwt(key, claims(), { alg: "RS512" }),
    await signJwt(other, claims()),
    "not-a-jwt",
    "a.b.c",
    "",
  ]) {
    await assert.rejects(verify(token), JwtError, token.slice(0, 40));
  }
});

test("an unknown kid refetches the keys once; a still-unknown kid is refused", async () => {
  const first = await makeKey("kid-1");
  const rotated = await makeKey("kid-2");
  let keys = [first];
  const server = jwksServer(() => keys);
  let now = NOW;
  const verify = (token: string) => verifyAccessJwt(token, { teamDomain: TEAM, aud: AUD, fetchJwks: server.fetchJwks, now: () => now });

  assert.ok(await verify(await signJwt(first, claims())));
  assert.ok(await verify(await signJwt(first, claims())));
  assert.equal(server.calls.length, 1, "keys are cached");

  keys = [first, rotated];
  now += 31_000;
  assert.ok(await verify(await signJwt(rotated, claims({ exp: nowS + 900 }))));
  assert.equal(server.calls.length, 2, "one refetch for the new kid");

  const stranger = await makeKey("kid-3");
  now += 31_000;
  await assert.rejects(verify(await signJwt(stranger, claims({ exp: nowS + 900 }))), JwtError);
  assert.equal(server.calls.length, 3, "one refetch, then refused");
  // Within 30 seconds of the last fetch an unknown kid does not fetch again.
  await assert.rejects(verify(await signJwt(stranger, claims({ exp: nowS + 900 }))), JwtError);
  assert.equal(server.calls.length, 3);
});

test("the cached keys expire after five minutes", async () => {
  const key = await makeKey("kid-1");
  const server = jwksServer(() => [key]);
  let now = NOW;
  const verify = (token: string) => verifyAccessJwt(token, { teamDomain: TEAM, aud: AUD, fetchJwks: server.fetchJwks, now: () => now });
  const token = await signJwt(key, claims({ exp: nowS + 3600 }));
  await verify(token);
  now += 4 * 60_000;
  await verify(token);
  assert.equal(server.calls.length, 1);
  now += 2 * 60_000;
  await verify(token);
  assert.equal(server.calls.length, 2);
});

test("a JWKS that can't be fetched is not a JwtError (the caller answers 503, not 401)", async () => {
  const key = await makeKey("kid-1");
  const failing = async () => {
    throw new Error("network down");
  };
  await assert.rejects(
    verifyAccessJwt(await signJwt(key, claims()), { teamDomain: TEAM, aud: AUD, fetchJwks: failing, now: () => NOW }),
    (error: unknown) => error instanceof Error && !(error instanceof JwtError),
  );
});

test("a bad team domain or an empty aud is a configuration error, not a pass", async () => {
  const { key, server } = await setup();
  const token = await signJwt(key, claims());
  await assert.rejects(verifyAccessJwt(token, { teamDomain: "example.com", aud: AUD, fetchJwks: server.fetchJwks }), TypeError);
  await assert.rejects(verifyAccessJwt(token, { teamDomain: TEAM, aud: "", fetchJwks: server.fetchJwks }), TypeError);
  assert.equal(server.calls.length, 0);
});
