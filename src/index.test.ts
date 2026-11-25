import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb, openTestDb, SqliteD1 } from "./db/sqlite-d1.ts";
import type { Env } from "./env.ts";
import worker from "./index.ts";
import { fakeMessage, LOG_ADDRESS, OWNER, rawEmail } from "../tests/helpers/fake-email.ts";
import { FakeKv } from "../tests/helpers/fake-kv.ts";
import { makeKey, signJwt, type TestKey } from "../tests/helpers/jwt.ts";

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
        if (path === "/sw.js") return new Response("// sw", { headers: { "Content-Type": "text/javascript", "Cache-Control": "max-age=14400" } });
        return new Response("Not found", { status: 404 });
      },
    },
  };
}

/** Signed in with the local dev sign-in, on a database with the migrations and defaults. */
async function devEnv(calls: AssetCall[] = []): Promise<Env> {
  return { ...fakeEnv(calls), AUTH_MODE: "dev", DB: await createTestDb() };
}

/** Serves the test key at every Access certs URL through a mocked global fetch (the Worker's default JWKS fetcher). */
function accessKeysFetch(key: TestKey) {
  const original = globalThis.fetch;
  return {
    install() {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.endsWith("/cdn-cgi/access/certs")) return Response.json({ keys: [key.jwk] });
        throw new Error(`Unexpected fetch in a unit test: ${url}`);
      }) as typeof fetch;
    },
    restore() {
      globalThis.fetch = original;
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
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.ok(res.headers.get("Referrer-Policy"));
  assert.ok(res.headers.get("Permissions-Policy"));
  assert.match(res.headers.get("Strict-Transport-Security") ?? "", /max-age=\d+/);
  assert.equal(res.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
  assert.equal(res.headers.get("Cross-Origin-Resource-Policy"), "same-origin");
}

test("GET / returns the board as HTML with one <h1>, lang and a meta description", async () => {
  const res = await get("/", await devEnv());
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type") ?? "", /^text\/html; charset=utf-8/);
  const body = await res.text();
  assert.equal(body.match(/<h1[\s>]/g)?.length, 1);
  assert.match(body, /<html lang="en">/);
  assert.match(body, /<meta name="description" content="[^"]+">/);
  assert.match(body, /<title>Today · Pipeline<\/title>/);
  assert.doesNotMatch(body, /<script/i);
  assertSecurityHeaders(res);
});

test("board pages are not cached and not handed to ASSETS", async () => {
  const calls: AssetCall[] = [];
  const res = await get("/", await devEnv(calls));
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

test("/sw.js comes from ASSETS with Cache-Control: no-cache, so a phone checks for a new version each time (decision 0030)", async () => {
  const res = await get("/sw.js");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-cache");
  assert.equal(await res.text(), "// sw");
  assertSecurityHeaders(res);
  assert.equal((await get("/board.css")).headers.get("Cache-Control"), null, "other files keep what ASSETS says");
});

test("a missing static file gets the HTML 404 page", async () => {
  const res = await get("/missing.css");
  assert.equal(res.status, 404);
  assert.match(await res.text(), /<h1[\s>]/);
});

test("/theme.css comes from the settings: text/css, not cached, security headers, never from ASSETS", async () => {
  const calls: AssetCall[] = [];
  const env = await devEnv(calls);
  const unset = await get("/theme.css", env);
  assert.equal(unset.status, 200);
  assert.equal(unset.headers.get("Content-Type"), "text/css; charset=utf-8");
  assert.equal(unset.headers.get("Cache-Control"), "no-store");
  assertSecurityHeaders(unset);
  assert.equal(await unset.text(), "/* No accent colour is set, so the board uses its default. */\n");

  await env.DB.prepare("UPDATE settings SET accent_color = '#1e4a3d'").run();
  assert.equal(await (await get("/theme.css", env)).text(), ":root{--accent:#1e4a3d;}\n");
  // Too light for white text: written straight into the database, so only the check at output time stops it.
  await env.DB.prepare("UPDATE settings SET accent_color = '#d0e8dc'").run();
  assert.doesNotMatch(await (await get("/theme.css", env)).text(), /d0e8dc/);
  assert.deepEqual(calls, []);
  assert.equal((await get("/theme.css", env, { method: "POST" })).status, 405);
});

test("/manifest.webmanifest comes from the settings: manifest JSON, not cached, security headers, never from ASSETS", async () => {
  const calls: AssetCall[] = [];
  const env = await devEnv(calls);
  const unset = await get("/manifest.webmanifest", env);
  assert.equal(unset.status, 200);
  assert.equal(unset.headers.get("Content-Type"), "application/manifest+json");
  assert.equal(unset.headers.get("Cache-Control"), "no-store");
  assertSecurityHeaders(unset);
  const defaults = (await unset.json()) as Record<string, unknown>;
  assert.equal(defaults.name, "Pipeline");
  assert.equal(defaults.short_name, "Pipeline");
  assert.equal(defaults.theme_color, "#2b6455");
  assert.equal(defaults.display, "standalone");

  // A name that would break a hand-built JSON string comes back intact, because the body is JSON.stringify's.
  await env.DB.prepare("UPDATE settings SET business_name = ?, accent_color = '#1e4a3d'").bind(`Fern "&" Co`).run();
  const named = (await (await get("/manifest.webmanifest", env)).json()) as Record<string, unknown>;
  assert.equal(named.name, `Fern "&" Co`);
  assert.equal(named.short_name, `Fern "&" Co`);
  assert.equal(named.theme_color, "#1e4a3d");
  assert.deepEqual(calls, []);
  assert.equal((await get("/manifest.webmanifest", env, { method: "POST" })).status, 405);
});

test("a POST to a board page that is not a write path is 405 with an Allow header", async () => {
  const res = await get("/", fakeEnv(), { method: "POST", body: "x" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("Allow"), "GET, HEAD");
  assertSecurityHeaders(res);
});

test("scheduled() runs the hourly rules, then the brief, then clears expired import drafts, and logs only counts", async (t) => {
  const logged = t.mock.method(console, "log", () => {});
  const failed = t.mock.method(console, "error", () => {});
  const controller = { cron: "0 * * * *", scheduledTime: Date.parse("2026-11-19T18:00:00.000Z"), noRetry() {} } as unknown as ScheduledController;
  await worker.scheduled(controller, { ...fakeEnv(), DB: await openTestDb() }, ctx);
  assert.equal(failed.mock.callCount(), 0);
  assert.deepEqual(logged.mock.calls.map((call) => call.arguments[0]), [
    JSON.stringify({ event: "cron_rules_done", rules: 0, fired: 0, alreadyFired: 0, failed: 0, deferred: 0 }),
    JSON.stringify({ event: "cron_brief_done", composed: 1, sent: 0, failed: 0 }),
    JSON.stringify({ event: "cron_import_drafts_done", deleted: 0 }),
    JSON.stringify({ event: "cron_proposals_done", deleted: 0 }),
  ]);
});

test("scheduled() on the campaign cron runs only the campaign job, and an off copy logs one skipped count", async (t) => {
  const logged = t.mock.method(console, "log", () => {});
  const failed = t.mock.method(console, "error", () => {});
  const controller = { cron: "5,20,35,50 * * * *", scheduledTime: Date.parse("2026-11-19T18:05:00.000Z"), noRetry() {} } as unknown as ScheduledController;
  await worker.scheduled(controller, { ...fakeEnv(), DB: await openTestDb() }, ctx);
  assert.equal(failed.mock.callCount(), 0);
  assert.deepEqual(logged.mock.calls.map((call) => call.arguments[0]), [JSON.stringify({ event: "cron_campaigns_done", skipped: 1 })]);
});

test("email() logs a BCC'd email, and a failure is logged without the message and never answers the sender", async (t) => {
  const logged = t.mock.method(console, "log", () => {});
  const failed = t.mock.method(console, "error", () => {});
  const db = await openTestDb();
  await db.prepare("INSERT INTO contacts (id, name, email) VALUES ('ct_pat', 'Pat Example', 'pat@example.com')").run();
  const env: Env = { ...fakeEnv(), DB: db, EMAIL_LOG_ADDRESS: LOG_ADDRESS, OWNER_EMAILS: OWNER };
  const ok = fakeMessage(rawEmail());
  await worker.email(ok as unknown as ForwardableEmailMessage, env, ctx);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM activities WHERE type = 'email'").first("n"), 1);

  const broken = fakeMessage(rawEmail({ messageId: "<other@mail.example.com>" }));
  const noDb = { prepare() { throw new Error("D1 is down"); }, batch() { throw new Error("D1 is down"); } };
  await worker.email(broken as unknown as ForwardableEmailMessage, { ...env, DB: noDb as unknown as Env["DB"] }, ctx);
  assert.deepEqual(failed.mock.calls.map((call) => call.arguments[0]), [JSON.stringify({ event: "email_log_failed" })]);
  assert.deepEqual(logged.mock.calls, []);
  assert.deepEqual([...ok.calls, ...broken.calls], []);
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

// /mcp itself (the MCP SDK behind the dynamic import) is tested in tests/e2e/mcp.test.ts; these tests stop before it.
// The full production sign-in (OAuth with Access upstream) is in src/auth/oauth-provider.test.ts.
test("in production (no AUTH_MODE), /mcp without a token is 401 with the OAuth challenge", async () => {
  for (const ENVIRONMENT of ["production", "development"]) {
    const res = await mcpPost({ ...fakeEnv(), ENVIRONMENT, OAUTH_KV: new FakeKv() as unknown as KVNamespace });
    assert.equal(res.status, 401, ENVIRONMENT);
    assert.match(
      res.headers.get("WWW-Authenticate") ?? "",
      /^Bearer realm="OAuth", resource_metadata="http:\/\/localhost:4821\/\.well-known\/oauth-protected-resource\/mcp"/,
    );
    assertSecurityHeaders(res);
  }
});

test("in production, /mcp and the sign-in pages fail closed with 500 until OAUTH_KV and the Access settings exist", async () => {
  const res = await mcpPost({ ...fakeEnv(), ENVIRONMENT: "production" });
  assert.equal(res.status, 500);
  assert.match(await res.text(), /Sign-in isn't set up yet\./);
  const authorize = await get("/authorize?response_type=code&client_id=x", { ...fakeEnv(), OAUTH_KV: new FakeKv() as unknown as KVNamespace });
  assert.equal(authorize.status, 500);
});

test("AUTH_MODE=dev in production fails closed with 500 on every route", async () => {
  const env: Env = { ...fakeEnv(), ENVIRONMENT: "production", AUTH_MODE: "dev" };
  const responses = [await get("/", env), await get("/board.css", env), await get("/nope", env), await mcpPost(env), await get("/api/pipeline", env)];
  for (const res of responses) {
    assert.equal(res.status, 500);
    assert.match(await res.text(), /misconfigured/);
    assertSecurityHeaders(res);
  }
});

const BOARD_PATHS = ["/", "/pipeline", "/contacts", "/more", "/rules", "/deals/dl_seed01", "/export", "/theme.css", "/manifest.webmanifest"];
const API_PATHS = ["/api/pipeline", "/api/export.json", "/api/export/contacts.csv"];

test("in production without Access settings the board and /api fail closed with 500; static files and the 404 page still work", async () => {
  for (const ENVIRONMENT of ["production", "development"]) {
    const env: Env = { ...fakeEnv(), ENVIRONMENT, DB: await createTestDb(), OWNER_EMAILS: "owner@example.com" };
    for (const path of BOARD_PATHS) {
      const res = await get(path, env);
      assert.equal(res.status, 500, `${ENVIRONMENT} ${path}`);
      assert.equal(await res.text(), "Sign-in isn't set up yet.\n");
      assertSecurityHeaders(res);
    }
    for (const path of API_PATHS) {
      const res = await get(path, env);
      assert.equal(res.status, 500, `${ENVIRONMENT} ${path}`);
      assert.match(res.headers.get("Content-Type") ?? "", /^application\/json/);
      assert.deepEqual(await res.json(), { error: "Sign-in isn't set up yet." });
    }
    assert.equal((await get("/nope", env)).status, 404);
    assert.equal((await get("/board.css", env)).status, 200);
  }
});

test("in production the board and /api need a valid Access token for an owner email", async () => {
  const key = await makeKey("kid-1");
  // A team domain of its own, so the JWKS cache this test fills is not shared.
  const team = "index-test.cloudflareaccess.com";
  const fetchJwks = accessKeysFetch(key);
  const env: Env = {
    ...fakeEnv(),
    ENVIRONMENT: "production",
    DB: await createTestDb(),
    ACCESS_TEAM_DOMAIN: team,
    ACCESS_AUD: "board-aud",
    OWNER_EMAILS: "owner@example.com",
  };
  const token = (email: string) => signJwt(key, { iss: `https://${team}`, aud: ["board-aud"], email, exp: Date.now() / 1000 + 300 });
  fetchJwks.install();
  try {
    for (const path of [...BOARD_PATHS, ...API_PATHS]) {
      assert.equal((await get(path, env)).status, 401, `no token ${path}`);
      const stranger = await get(path, env, { headers: { "Cf-Access-Jwt-Assertion": await token("stranger@example.com") } });
      assert.equal(stranger.status, 403, `stranger ${path}`);
      const owner = await get(path, env, { headers: { "Cf-Access-Jwt-Assertion": await token("Owner@Example.com") } });
      // The test database has no deals, so the deal page is the board's own 404: signed in, nothing to show.
      assert.equal(owner.status, path.startsWith("/deals/") ? 404 : 200, `owner ${path}`);
    }
  } finally {
    fetchJwks.restore();
  }
});

test("/intake stays outside both sign-ins in production: its own secret is the only check", async () => {
  const env: Env = { ...fakeEnv(), ENVIRONMENT: "production", DB: await createTestDb(), INTAKE_SECRET: "test-intake-secret" };
  const res = await get("/intake", env, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Intake-Secret": "test-intake-secret" },
    body: JSON.stringify({ name: "Pat Example", email: "pat@example.com", message: "Hello there" }),
  });
  assert.equal(res.status, 201);
  assertSecurityHeaders(res);
});

test("a failure while reading answers 500 with no internals and logs only a fixed event", async (t) => {
  const failed = t.mock.method(console, "error", () => {});
  const broken: Env = {
    ...(await devEnv()),
    DB: {
      prepare() {
        throw new Error("D1_ERROR: secret internals");
      },
      batch() {
        throw new Error("D1_ERROR: secret internals");
      },
    } as unknown as Env["DB"],
  };
  const page = await get("/", broken);
  assert.equal(page.status, 500);
  const html = await page.text();
  assert.match(html, /<h1>Something went wrong<\/h1>/);
  assert.doesNotMatch(html, /internals|D1_ERROR/);
  const api = await get("/api/pipeline", broken);
  assert.equal(api.status, 500);
  assert.deepEqual(await api.json(), { error: "Something went wrong on the server. Nothing was changed." });
  assert.deepEqual(
    failed.mock.calls.map((call) => call.arguments[0]),
    [JSON.stringify({ event: "board_failed" }), JSON.stringify({ event: "api_failed" })],
  );
});

test("/mcp in dev mode on a host that is not loopback fails closed", async () => {
  const res = await mcpPost({ ...fakeEnv(), AUTH_MODE: "dev" }, "pipeline.example.com");
  assert.equal(res.status, 500);
});
