import assert from "node:assert/strict";
import { test } from "node:test";
import { authMode, DEV_OWNER_EMAIL } from "./dev.ts";

type AuthEnv = Parameters<typeof authMode>[1];

const request = (host: string) => new Request(`http://${host}/mcp`, { method: "POST" });
const dev: AuthEnv = { ENVIRONMENT: "development", AUTH_MODE: "dev" };

test("dev auth signs in the fake owner in local development on a loopback host", () => {
  for (const host of ["localhost:4821", "127.0.0.1:4821", "[::1]:4821", "localhost"]) {
    assert.deepEqual(authMode(request(host), dev), { kind: "dev", email: DEV_OWNER_EMAIL }, host);
  }
  assert.match(DEV_OWNER_EMAIL, /@example\.(com|test)$/);
});

test("dev auth in production fails closed with 500 on every route", () => {
  const env: AuthEnv = { ENVIRONMENT: "production", AUTH_MODE: "dev" };
  for (const path of ["/mcp", "/", "/board.css", "/nope"]) {
    const result = authMode(new Request(`http://localhost:4821${path}`), env);
    assert.equal(result.kind, "misconfigured", path);
    if (result.kind !== "misconfigured") continue;
    assert.match(result.message, /misconfigured/, path);
    assert.match(result.message, /AUTH_MODE/, path);
  }
});

test("dev auth on a host that is not loopback fails closed with 500", () => {
  for (const host of ["pipeline.example.com", "pipeline-dev.example.workers.dev", "192.168.1.20:4821", "localhost.example.com"]) {
    assert.equal(authMode(request(host), dev).kind, "misconfigured", host);
  }
});

test("any other environment value with AUTH_MODE=dev fails closed", () => {
  for (const ENVIRONMENT of ["", "preview", "Development", "staging"]) {
    assert.equal(authMode(request("localhost:4821"), { ENVIRONMENT, AUTH_MODE: "dev" }).kind, "misconfigured", ENVIRONMENT);
  }
});

test("an unknown AUTH_MODE fails closed", () => {
  for (const AUTH_MODE of ["Dev", "on", "true", " dev", "production", "access"]) {
    for (const ENVIRONMENT of ["development", "production"]) {
      const result = authMode(request("localhost:4821"), { ENVIRONMENT, AUTH_MODE });
      assert.equal(result.kind, "misconfigured", `${ENVIRONMENT} ${AUTH_MODE}`);
      if (result.kind === "misconfigured") assert.match(result.message, /AUTH_MODE/);
    }
  }
});

test("without AUTH_MODE (or with it empty) the Worker uses production sign-in, in any environment", () => {
  for (const ENVIRONMENT of ["production", "development"]) {
    assert.deepEqual(authMode(request("localhost:4821"), { ENVIRONMENT }), { kind: "production" }, ENVIRONMENT);
    assert.deepEqual(authMode(request("pipeline.example.com"), { ENVIRONMENT, AUTH_MODE: "" }), { kind: "production" });
  }
});
