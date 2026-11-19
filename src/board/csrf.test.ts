import assert from "node:assert/strict";
import { test } from "node:test";
import { csrfCookie, csrfCookieName, csrfFromCookies, csrfMatches, isCsrfToken, newCsrfToken } from "./csrf.ts";

const withCookie = (cookie: string) => new Request("http://localhost:4821/", { headers: { Cookie: cookie } });

test("a token is 32 random bytes as base64url: 43 characters, different every time", () => {
  const a = newCsrfToken();
  const b = newCsrfToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.ok(isCsrfToken(a));
  for (const bad of ["", "short", `${a}x`, `${a.slice(0, 42)}=`, `${a.slice(0, 42)}/`]) assert.equal(isCsrfToken(bad), false, bad);
});

test("production uses the __Host- cookie (Secure, HttpOnly, SameSite=Strict, Path=/); dev uses pipeline-csrf without Secure", () => {
  const token = newCsrfToken();
  assert.equal(csrfCookieName("production"), "__Host-pipeline-csrf");
  assert.equal(csrfCookie(token, "production"), `__Host-pipeline-csrf=${token}; Path=/; Secure; HttpOnly; SameSite=Strict`);
  assert.equal(csrfCookieName("dev"), "pipeline-csrf");
  assert.equal(csrfCookie(token, "dev"), `pipeline-csrf=${token}; Path=/; HttpOnly; SameSite=Strict`);
});

test("the token is read only from the cookie name of the sign-in mode, and only when it has the right shape", () => {
  const token = newCsrfToken();
  assert.equal(csrfFromCookies(withCookie(`a=1; __Host-pipeline-csrf=${token}; b=2`), "production"), token);
  assert.equal(csrfFromCookies(withCookie(`pipeline-csrf=${token}`), "production"), null, "the dev name is not accepted in production");
  assert.equal(csrfFromCookies(withCookie(`pipeline-csrf=${token}`), "dev"), token);
  assert.equal(csrfFromCookies(withCookie(`__Host-pipeline-csrf=${token}`), "dev"), null);
  assert.equal(csrfFromCookies(withCookie("pipeline-csrf=not-a-token"), "dev"), null);
  assert.equal(csrfFromCookies(new Request("http://localhost:4821/"), "dev"), null);
});

test("the form's token must equal the cookie's", async () => {
  const token = newCsrfToken();
  assert.equal(await csrfMatches(token, token), true);
  assert.equal(await csrfMatches(token, newCsrfToken()), false);
  assert.equal(await csrfMatches(token, null), false);
  assert.equal(await csrfMatches(token, ""), false);
  assert.equal(await csrfMatches(token, `${token} `), false);
});
