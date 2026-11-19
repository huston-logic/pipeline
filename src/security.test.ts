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
