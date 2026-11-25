import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb, type SqliteD1 } from "../db/sqlite-d1.ts";
import type { Env } from "../env.ts";
import worker from "../index.ts";
import { handleUnsubscribe } from "./unsubscribe.ts";

const NOW = new Date("2026-11-24T18:00:00.000Z");
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdE";
const OTHER = "ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210-_ZyXwV";

interface Setup {
  db: SqliteD1;
  env: Env;
  limitKeys: string[];
  stylesheets: string[];
}

async function setup(options: { allow?: boolean; limiter?: boolean; campaigns?: boolean } = {}): Promise<Setup> {
  const db = await createTestDb();
  const limitKeys: string[] = [];
  const stylesheets: string[] = [];
  db.exec(`UPDATE settings SET business_name = 'Example Plumbing', campaigns = ${options.campaigns === false ? 0 : 1};
    INSERT INTO contacts (id, name, email, person_status, sub_status) VALUES ('ct_unsub1', 'Pat Example', 'pat@example.com', 'contact', NULL);
    INSERT INTO campaigns (id, name, status, audience) VALUES ('cp_unsub1', 'News', 'sent', '{"kind":"people","people":["ct_unsub1"]}');
    INSERT INTO campaign_steps (id, campaign_id, position, subject, body) VALUES ('cs_unsub1', 'cp_unsub1', 1, 'Hi', 'Hi.');
    INSERT INTO campaign_recipients (id, campaign_id, step_id, contact_id, email, status, unsub_token)
      VALUES ('rc_unsub1', 'cp_unsub1', 'cs_unsub1', 'ct_unsub1', 'pat@example.com', 'delivered', '${TOKEN}')`);
  const env: Env = {
    ENVIRONMENT: "production",
    DB: db,
    ASSETS: {
      fetch: async (request: Request) => {
        stylesheets.push(new URL(request.url).pathname);
        return new Response("body{}", { headers: { "Content-Type": "text/css" } });
      },
    },
    ...(options.limiter === false
      ? {}
      : {
          INTAKE_RATE_LIMIT: {
            async limit({ key }: { key: string }) {
              limitKeys.push(key);
              return { success: options.allow ?? true };
            },
          },
        }),
  };
  return { db, env, limitKeys, stylesheets };
}

const call = (env: Env, path: string, init: RequestInit = {}) =>
  handleUnsubscribe(new Request(`https://pipeline.example.com${path}`, init), env, NOW);

const form = (body = "") => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.7" }, body });

const count = async (db: SqliteD1, sql: string): Promise<number> => (await db.prepare(sql).first<{ n: number }>())?.n ?? -1;

test("GET shows only the business name and one button", async () => {
  const { env } = await setup();
  const res = await call(env, `/unsubscribe/${TOKEN}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.match(res.headers.get("Content-Security-Policy") ?? "", /default-src 'self'/);
  const page = await res.text();
  assert.match(page, /<h1>Stop getting emails from Example Plumbing\?<\/h1>/);
  assert.match(page, /<title>Unsubscribe<\/title>/);
  assert.match(page, /<link rel="stylesheet" href="\/unsubscribe\/board\.css">/);
  assert.equal(page.match(/<button/g)?.length, 1);
  assert.equal(page.match(/<form/g)?.length, 1);
  assert.doesNotMatch(page, /Pat|pat@example\.com|ct_unsub1|cp_unsub1|News/);
  assert.match(page, new RegExp(`<form method="post" action="/unsubscribe/${TOKEN}">`));
});

test("GET changes nothing and HEAD works", async () => {
  const { env, db } = await setup();
  assert.equal((await call(env, `/unsubscribe/${TOKEN}`, { method: "HEAD" })).status, 200);
  await call(env, `/unsubscribe/${TOKEN}`);
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM email_suppressions"), 0);
});

test("the page's button suppresses the address and sets unsubscribed_at", async () => {
  const { env, db } = await setup();
  const res = await call(env, `/unsubscribe/${TOKEN}`, form());
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /<h1>You're unsubscribed\.<\/h1>/);
  assert.match(page, /You won't get any more of these emails from Example Plumbing\./);
  const suppression = await db.prepare("SELECT * FROM email_suppressions").first<Record<string, unknown>>();
  assert.equal(suppression?.email, "pat@example.com");
  assert.equal(suppression?.reason, "unsubscribed");
  assert.equal(suppression?.contact_id, "ct_unsub1");
  assert.equal(suppression?.campaign_id, "cp_unsub1");
  assert.equal(suppression?.cleared_at, null);
  const recipient = await db.prepare("SELECT unsubscribed_at, version FROM campaign_recipients").first<{ unsubscribed_at: string; version: number }>();
  assert.equal(recipient?.unsubscribed_at, NOW.toISOString());
  assert.equal(recipient?.version, 2);
  const audit = await db.prepare("SELECT actor, tool, summary FROM audit_log ORDER BY rowid DESC").first<Record<string, string>>();
  assert.deepEqual({ actor: audit?.actor, tool: audit?.tool }, { actor: "system", tool: "unsubscribe" });
  assert.equal(audit?.summary?.replace(/chg_\w+/, ""), "Unsubscribed contact ct_unsub1 from campaign emails (change )");
});

test("a mail client's one-click POST works", async () => {
  const { env, db } = await setup();
  const res = await call(env, `/unsubscribe/${TOKEN}`, form("List-Unsubscribe=One-Click"));
  assert.equal(res.status, 200);
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM email_suppressions WHERE reason = 'unsubscribed'"), 1);
});

test("a one-click POST with any content type or no body works", async () => {
  const { env, db } = await setup();
  const res = await call(env, `/unsubscribe/${TOKEN}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x".repeat(5000) });
  assert.equal(res.status, 200);
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM email_suppressions"), 1);
});

test("a repeat is harmless", async () => {
  const { env, db } = await setup();
  await call(env, `/unsubscribe/${TOKEN}`, form());
  const changes = await count(db, "SELECT COUNT(*) AS n FROM audit_log");
  const res = await call(env, `/unsubscribe/${TOKEN}`, form());
  assert.equal(res.status, 200);
  assert.match(await res.text(), /You're unsubscribed\./);
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM email_suppressions"), 1);
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM audit_log"), changes);
});

test("an address already blocked gets no second suppression, only unsubscribed_at", async () => {
  const { env, db } = await setup();
  db.exec("INSERT INTO email_suppressions (id, email, reason, contact_id) VALUES ('su_bounce1', 'pat@example.com', 'bounced', 'ct_unsub1')");
  const res = await call(env, `/unsubscribe/${TOKEN}`, form());
  assert.equal(res.status, 200);
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM email_suppressions"), 1);
  const recipient = await db.prepare("SELECT unsubscribed_at FROM campaign_recipients").first<{ unsubscribed_at: string | null }>();
  assert.equal(recipient?.unsubscribed_at, NOW.toISOString());
});

test("an unknown or malformed token is the 404 page and changes nothing", async () => {
  const { env, db } = await setup();
  for (const path of [`/unsubscribe/${OTHER}`, "/unsubscribe/short", `/unsubscribe/${TOKEN}x`, "/unsubscribe/", "/unsubscribe/a/b"]) {
    for (const init of [{}, form()]) {
      const res = await call(env, path, init);
      assert.equal(res.status, 404, path);
      assert.match(await res.text(), /<h1>This link doesn't work\.<\/h1><p>Nothing changed\.<\/p>/);
    }
  }
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM email_suppressions"), 0);
});

test("the test link says nothing changed and changes nothing", async () => {
  const { env, db } = await setup();
  const get = await call(env, "/unsubscribe/test");
  assert.equal(get.status, 200);
  const page = await get.text();
  assert.match(page, /<h1>This link is from a test email\.<\/h1>/);
  assert.match(page, /Nothing changed\./);
  assert.doesNotMatch(page, /<form|<button/);
  const post = await call(env, "/unsubscribe/test", form("List-Unsubscribe=One-Click"));
  assert.equal(post.status, 200);
  assert.match(await post.text(), /Nothing changed\./);
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM email_suppressions"), 0);
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM audit_log"), 0);
});

test("it works with campaigns off", async () => {
  const { env, db } = await setup({ campaigns: false });
  assert.equal((await call(env, `/unsubscribe/${TOKEN}`)).status, 200);
  assert.equal((await call(env, `/unsubscribe/${TOKEN}`, form())).status, 200);
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM email_suppressions"), 1);
});

test("/unsubscribe/board.css serves the stylesheet from assets", async () => {
  const { env, stylesheets } = await setup();
  const res = await call(env, "/unsubscribe/board.css");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "body{}");
  assert.deepEqual(stylesheets, ["/board.css"]);
  assert.match(res.headers.get("Content-Security-Policy") ?? "", /default-src 'self'/);
});

const SECURITY = /default-src 'self'/;

test("a known token over the limit still unsubscribes, and is never counted", async () => {
  const { env, db, limitKeys } = await setup({ allow: false });
  const res = await call(env, `/unsubscribe/${TOKEN}`, form("List-Unsubscribe=One-Click"));
  assert.equal(res.status, 200);
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM email_suppressions"), 1);
  assert.deepEqual(limitKeys, []);
});

test("a limiter that throws still unsubscribes, and an unknown token is then a plain 404", async () => {
  const { env, db } = await setup();
  env.INTAKE_RATE_LIMIT = {
    async limit() {
      throw new Error("limiter down");
    },
  };
  assert.equal((await call(env, `/unsubscribe/${OTHER}`, form())).status, 404);
  assert.equal((await call(env, `/unsubscribe/${TOKEN}`, form())).status, 200);
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM email_suppressions"), 1);
});

test("an unknown or malformed token over the limit is 429, keyed by address, with security headers", async () => {
  const { env, db, limitKeys } = await setup({ allow: false });
  for (const path of [`/unsubscribe/${OTHER}`, "/unsubscribe/short"]) {
    const res = await call(env, path, form());
    assert.equal(res.status, 429);
    assert.match(res.headers.get("Content-Security-Policy") ?? "", SECURITY);
  }
  assert.deepEqual(limitKeys, ["unsubscribe:203.0.113.7", "unsubscribe:203.0.113.7"]);
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM email_suppressions"), 0);
  // A GET of an unknown token is not counted.
  assert.equal((await call(env, `/unsubscribe/${OTHER}`)).status, 404);
  assert.equal(limitKeys.length, 2);
});

test("each page has its own fixed title, the button is the board's, and 404 and 405 carry security headers", async () => {
  const { env } = await setup();
  const title = async (res: Response) => /<title>(.*)<\/title>/.exec(await res.text())?.[1];
  const confirm = await call(env, `/unsubscribe/${TOKEN}`);
  const confirmPage = await confirm.clone().text();
  assert.match(confirmPage, /<button class="button" type="submit">Unsubscribe<\/button>/);
  assert.equal(await title(confirm), "Unsubscribe");
  assert.equal(await title(await call(env, `/unsubscribe/${TOKEN}`, form())), "You&#39;re unsubscribed");
  assert.equal(await title(await call(env, "/unsubscribe/test")), "Test email link");
  const missing = await call(env, `/unsubscribe/${OTHER}`);
  assert.match(missing.headers.get("Content-Security-Policy") ?? "", SECURITY);
  assert.equal(await title(missing), "Link not found");
  const wrong = await call(env, `/unsubscribe/${TOKEN}`, { method: "PUT" });
  assert.equal(wrong.status, 405);
  assert.match(wrong.headers.get("Content-Security-Policy") ?? "", SECURITY);
});

test("without the rate limit binding a POST is allowed", async () => {
  const { env } = await setup({ limiter: false });
  assert.equal((await call(env, `/unsubscribe/${TOKEN}`, form())).status, 200);
});

test("other methods are 405", async () => {
  const { env } = await setup();
  for (const method of ["PUT", "DELETE", "PATCH"]) {
    const res = await call(env, `/unsubscribe/${TOKEN}`, { method });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("Allow"), "GET, HEAD, POST");
  }
});

test("the Worker answers it before any sign-in, in production, with no Access setup", async () => {
  const { env, db } = await setup();
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const get = await worker.fetch(new Request(`https://pipeline.example.com/unsubscribe/${TOKEN}`), env, ctx);
  assert.equal(get.status, 200);
  const post = await worker.fetch(new Request(`https://pipeline.example.com/unsubscribe/${TOKEN}`, form()), env, ctx);
  assert.equal(post.status, 200);
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM email_suppressions"), 1);
  assert.equal((await worker.fetch(new Request("https://pipeline.example.com/unsubscribe/board.css"), env, ctx)).status, 200);
});
