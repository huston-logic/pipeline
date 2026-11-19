import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createTestDb, SqliteD1 } from "./db/sqlite-d1.ts";
import type { Env } from "./env.ts";
import worker from "./index.ts";

type AssetCall = { url: string };

function fakeEnv(calls: AssetCall[] = []): Env {
  return {
    ENVIRONMENT: "development",
    DB: new SqliteD1(),
    ASSETS: {
      async fetch(request: Request) {
        calls.push({ url: request.url });
        const path = new URL(request.url).pathname;
        if (path === "/board.css") return new Response("body{}", { headers: { "Content-Type": "text/css" } });
        if (path === "/robots.txt") return new Response("User-agent: *\nAllow: /\n");
        return new Response("Not found", { status: 404 });
      },
    },
  };
}

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

function get(path: string, env: Env = fakeEnv(), init?: RequestInit) {
  return worker.fetch(new Request(`http://localhost:4821${path}`, init), env, ctx);
}

function assertSecurityHeaders(res: Response) {
  const csp = res.headers.get("Content-Security-Policy") ?? "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.ok(res.headers.get("Referrer-Policy"));
  assert.ok(res.headers.get("Permissions-Policy"));
  assert.match(res.headers.get("Strict-Transport-Security") ?? "", /max-age=\d+/);
  assert.equal(res.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
  assert.equal(res.headers.get("Cross-Origin-Resource-Policy"), "same-origin");
}

test("GET / returns the board as HTML with one <h1>, lang and a meta description", async () => {
  const res = await get("/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type") ?? "", /^text\/html; charset=utf-8/);
  const body = await res.text();
  assert.equal(body.match(/<h1[\s>]/g)?.length, 1);
  assert.match(body, /<html lang="en">/);
  assert.match(body, /<meta name="description" content="[^"]+">/);
  assert.match(body, /<title>Pipeline<\/title>/);
  assert.doesNotMatch(body, /<script/i);
  assertSecurityHeaders(res);
});

test("board pages are not cached and not handed to ASSETS", async () => {
  const calls: AssetCall[] = [];
  const res = await get("/", fakeEnv(calls));
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(calls, []);
});

test("GET /nope returns a 404 HTML page with one <h1> and security headers", async () => {
  const res = await get("/nope");
  assert.equal(res.status, 404);
  assert.match(res.headers.get("Content-Type") ?? "", /^text\/html/);
  const body = await res.text();
  assert.equal(body.match(/<h1[\s>]/g)?.length, 1);
  assert.match(body, /<meta name="description" content="[^"]+">/);
  assertSecurityHeaders(res);
});

test("static files are passed to env.ASSETS.fetch and keep the security headers", async () => {
  for (const path of ["/board.css", "/robots.txt"]) {
    const calls: AssetCall[] = [];
    const res = await get(path, fakeEnv(calls));
    assert.equal(res.status, 200, path);
    assert.deepEqual(calls, [{ url: `http://localhost:4821${path}` }], path);
    assertSecurityHeaders(res);
  }
  assert.equal(await (await get("/board.css")).text(), "body{}");
});

test("a missing static file gets the HTML 404 page", async () => {
  const res = await get("/missing.css");
  assert.equal(res.status, 404);
  assert.match(await res.text(), /<h1[\s>]/);
});

test("the read-only board refuses POST with 405 and an Allow header", async () => {
  const res = await get("/", fakeEnv(), { method: "POST", body: "x" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("Allow"), "GET, HEAD");
  assertSecurityHeaders(res);
});

test("scheduled() runs without throwing", async () => {
  const controller = { cron: "0 * * * *", scheduledTime: Date.now(), noRetry() {} } as unknown as ScheduledController;
  await worker.scheduled(controller, fakeEnv(), ctx);
});

const mcpBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

function mcpPost(env: Env, host = "localhost:4821") {
  return worker.fetch(
    new Request(`http://${host}/mcp`, {
      method: "POST",
      headers: { host, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: mcpBody,
    }),
    env,
    ctx,
  );
}

test("/mcp without a sign-in mode answers 401 with a plain message", async () => {
  for (const ENVIRONMENT of ["production", "development"]) {
    const res = await mcpPost({ ...fakeEnv(), ENVIRONMENT });
    assert.equal(res.status, 401, ENVIRONMENT);
    assert.match(res.headers.get("Content-Type") ?? "", /^text\/plain/);
    assert.match(await res.text(), /Sign-in for \/mcp isn't set up/);
    assertSecurityHeaders(res);
  }
});

test("AUTH_MODE=dev in production fails closed with 500 on every route", async () => {
  const env: Env = { ...fakeEnv(), ENVIRONMENT: "production", AUTH_MODE: "dev" };
  const responses = [await get("/", env), await get("/board.css", env), await get("/nope", env), await mcpPost(env)];
  for (const res of responses) {
    assert.equal(res.status, 500);
    assert.match(await res.text(), /misconfigured/);
    assertSecurityHeaders(res);
  }
});

test("/mcp in local dev mode serves the MCP tools to an SDK client", async () => {
  const env: Env = { ...fakeEnv(), DB: await createTestDb(), AUTH_MODE: "dev" };
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost:4821/mcp"), {
    fetch: (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      request.headers.set("host", new URL(request.url).host);
      return worker.fetch(request, env, ctx);
    },
  });
  const client = new Client({ name: "index-test", version: "1.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === "pipeline_summary"));
  const result = await client.callTool({ name: "pipeline_summary", arguments: {} });
  assert.match(JSON.stringify(result.content), /Your pipeline is empty/);
  await client.close();
});

test("/mcp in dev mode on a host that is not loopback fails closed", async () => {
  const res = await mcpPost({ ...fakeEnv(), AUTH_MODE: "dev" }, "pipeline.example.com");
  assert.equal(res.status, 500);
});

test("GET /mcp is refused: the endpoint is stateless and takes POST", async () => {
  const res = await get("/mcp", { ...fakeEnv(), AUTH_MODE: "dev" }, { headers: { host: "localhost:4821", accept: "text/event-stream" } });
  assert.equal(res.status, 405);
});
