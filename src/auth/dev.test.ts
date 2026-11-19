import assert from "node:assert/strict";
import { test } from "node:test";
import { DEV_OWNER_EMAIL, devAuth } from "./dev.ts";

type AuthEnv = Parameters<typeof devAuth>[1];

const request = (host: string) => new Request(`http://${host}/mcp`, { method: "POST" });
const dev: AuthEnv = { ENVIRONMENT: "development", AUTH_MODE: "dev" };

test("dev auth signs in the fake owner in local development on a loopback host", () => {
  for (const host of ["localhost:4821", "127.0.0.1:4821", "[::1]:4821", "localhost"]) {
    assert.deepEqual(devAuth(request(host), dev), { ok: true, email: DEV_OWNER_EMAIL }, host);
  }
  assert.match(DEV_OWNER_EMAIL, /@example\.(com|test)$/);
});

test("dev auth in production fails closed with 500 on every route", () => {
  const env: AuthEnv = { ENVIRONMENT: "production", AUTH_MODE: "dev" };
  for (const path of ["/mcp", "/", "/board.css", "/nope"]) {
    const result = devAuth(new Request(`http://localhost:4821${path}`), env);
    assert.equal(result.ok, false, path);
    if (result.ok) continue;
    assert.equal(result.status, 500, path);
    assert.match(result.message, /misconfigured/, path);
    assert.match(result.message, /AUTH_MODE/, path);
  }
});

test("dev auth on a host that is not loopback fails closed with 500", () => {
  for (const host of ["pipeline.example.com", "pipeline-dev.example.workers.dev", "192.168.1.20:4821", "localhost.example.com"]) {
    const result = devAuth(request(host), dev);
    assert.equal(result.ok, false, host);
    if (!result.ok) assert.equal(result.status, 500, host);
  }
});

test("any other environment value with AUTH_MODE=dev fails closed", () => {
  for (const ENVIRONMENT of ["", "preview", "Development", "staging"]) {
    const result = devAuth(request("localhost:4821"), { ENVIRONMENT, AUTH_MODE: "dev" });
    assert.equal(result.ok, false, ENVIRONMENT);
    if (!result.ok) assert.equal(result.status, 500, ENVIRONMENT);
  }
});

test("an unknown AUTH_MODE fails closed with 500", () => {
  for (const AUTH_MODE of ["Dev", "on", "true", " dev"]) {
    const result = devAuth(request("localhost:4821"), { ENVIRONMENT: "development", AUTH_MODE });
    assert.equal(result.ok, false, AUTH_MODE);
    if (!result.ok) assert.equal(result.status, 500, AUTH_MODE);
  }
});

test("without AUTH_MODE, /mcp answers 401 with a plain message until OAuth exists", () => {
  for (const ENVIRONMENT of ["production", "development"]) {
    const result = devAuth(request("localhost:4821"), { ENVIRONMENT });
    assert.equal(result.ok, false, ENVIRONMENT);
    if (result.ok) continue;
    assert.equal(result.status, 401);
    assert.match(result.message, /sign-in/i);
  }
});
