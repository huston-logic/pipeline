import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTENT_SECURITY_POLICY, withSecurityHeaders } from "./security.ts";

test("extra form-action origins are added only when they are plain http(s) origins", () => {
  const res = withSecurityHeaders(new Response("x"), {
    formAction: ["https://team.example.com", "http://localhost:6274", "https://a.example.com; script-src *", "javascript:alert(1)"],
  });
  const csp = res.headers.get("Content-Security-Policy") ?? "";
  assert.match(csp, /form-action 'self' https:\/\/team\.example\.com http:\/\/localhost:6274;/);
  assert.doesNotMatch(csp, /script-src \*|javascript/);
  assert.equal(withSecurityHeaders(new Response("x")).headers.get("Content-Security-Policy"), CONTENT_SECURITY_POLICY);
});

test("wrapping an already wrapped response keeps its policy", () => {
  const consent = withSecurityHeaders(new Response("x"), { formAction: ["https://team.example.com"] });
  assert.equal(withSecurityHeaders(consent), consent);
});

test("scripts may come from this site only (the board's own /board.js, decision 0014): never inline, never eval", () => {
  assert.match(CONTENT_SECURITY_POLICY, /(^|; )script-src 'self'(;|$)/);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /unsafe-inline|unsafe-eval|unsafe-hashes|strict-dynamic|nonce-|sha256-/);
  assert.match(CONTENT_SECURITY_POLICY, /object-src 'none'/);
});

test("the policy is exactly this: push.js and sw.js are 'self' and the Worker, not the page, calls the push service (decision 0030)", () => {
  assert.equal(
    CONTENT_SECURITY_POLICY,
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
      "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
  );
});
