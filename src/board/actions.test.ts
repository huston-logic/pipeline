// The board's write path (decision 0014, 0017) through the Worker: sign-in, same origin, form body, CSRF token, then
// the service call, the 303 back with ?change=, the change banner and Undo.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { makeKey, signJwt } from "../../tests/helpers/jwt.ts";
import type { AuditRow, DealRow } from "../db/db.ts";
import { createTestDb, type SqliteD1 } from "../db/sqlite-d1.ts";
import type { Env } from "../env.ts";
import worker from "../index.ts";
import type { Ctx } from "../services/change.ts";
import { updateDeal } from "../services/deals.ts";
import { addDeal } from "../services/add-deal.ts";
import { DEFAULT_TZ } from "../time.ts";

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const ORIGIN = "http://localhost:4821";
const OUT_OF_DATE = "This page is out of date. Reload it and try again.";

async function seededDb(): Promise<SqliteD1> {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(new Date(), DEFAULT_TZ));
  return db;
}

const devEnv = (db: SqliteD1): Env => ({
  ENVIRONMENT: "development",
  AUTH_MODE: "dev",
  DB: db,
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
});

const send = (env: Env, path: string, init?: RequestInit) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);

/** The page's CSRF cookie (from Set-Cookie) and the token in its forms. */
async function load(env: Env, path = "/pipeline", cookie?: string) {
  const res = await send(env, path, cookie === undefined ? undefined : { headers: { Cookie: cookie } });
  const body = await res.text();
  const setCookie = res.headers.get("Set-Cookie");
  const tokens = [...body.matchAll(/<input type="hidden" name="csrf" value="([^"]*)">/g)].map((m) => m[1] ?? "");
  return { res, body, setCookie, tokens };
}

async function session(env: Env) {
  const { setCookie, tokens } = await load(env);
  const cookie = (setCookie ?? "").split(";")[0] ?? "";
  return { cookie, token: tokens[0] ?? "" };
}

type PostOptions = {
  origin?: string | null;
  fetchSite?: string;
  cookie?: string | null;
  contentType?: string;
  body?: string;
  headers?: Record<string, string>;
};

async function post(env: Env, path: string, fields: Record<string, string>, options: PostOptions = {}) {
  const { cookie, token } = await session(env);
  const headers: Record<string, string> = { "Content-Type": options.contentType ?? "application/x-www-form-urlencoded" };
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin !== null) headers.Origin = origin;
  if (options.fetchSite !== undefined) headers["Sec-Fetch-Site"] = options.fetchSite;
  const sentCookie = options.cookie === undefined ? cookie : options.cookie;
  if (sentCookie !== null) headers.Cookie = sentCookie;
  const body = options.body ?? new URLSearchParams({ csrf: token, ...fields }).toString();
  const res = await send(env, path, { method: "POST", headers: { ...headers, ...options.headers }, body, redirect: "manual" });
  return { res, body: await res.text(), cookie, token };
}

const auditCount = async (db: SqliteD1) =>
  (await db.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>())?.n ?? 0;
const dealRow = async (db: SqliteD1, id: string) => db.prepare("SELECT * FROM deals WHERE id = ?").bind(id).first<DealRow>();
const changeIdOf = (location: string | null) => /[?&]change=(chg_[a-z0-9]+)/.exec(location ?? "")?.[1] ?? "";

test("a board page sets the CSRF cookie once and puts the same token in every form", async () => {
  const env = devEnv(await seededDb());
  const first = await load(env);
  assert.match(first.setCookie ?? "", /^pipeline-csrf=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax$/);
  const token = /^pipeline-csrf=([^;]+)/.exec(first.setCookie ?? "")?.[1];
  assert.ok(first.tokens.length >= 6, "a Move form on every card");
  assert.deepEqual(new Set(first.tokens), new Set([token]));

  const again = await load(env, "/pipeline", `pipeline-csrf=${token}`);
  assert.equal(again.setCookie, null, "a page that finds the cookie keeps it");
  assert.deepEqual(new Set(again.tokens), new Set([token]));

  const broken = await load(env, "/pipeline", "pipeline-csrf=not-a-token");
  assert.match(broken.setCookie ?? "", /^pipeline-csrf=[A-Za-z0-9_-]{43};/, "a malformed cookie is replaced");
});

test("moving a deal: one audited change by the owner, then 303 back to the page with the change id", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const before = await auditCount(db);
  const { res } = await post(env, "/deals/dl_seed01/move", { stage: "call_done", return_to: "/pipeline" });
  assert.equal(res.status, 303);
  const location = res.headers.get("Location");
  assert.match(location ?? "", /^\/pipeline\?change=chg_[a-z0-9]{12}$/);
  assert.equal(await auditCount(db), before + 1, "exactly one audit row");
  const audit = await db.prepare("SELECT * FROM audit_log WHERE id = ?").bind(changeIdOf(location)).first<AuditRow>();
  assert.equal(audit?.actor, "owner");
  assert.equal(audit?.tool, "update_deal");
  assert.equal((await dealRow(db, "dl_seed01"))?.stage_key, "call_done");
  assert.match(res.headers.get("Cache-Control") ?? "", /no-store/);
  assert.match(res.headers.get("Content-Security-Policy") ?? "", /default-src 'self'/);
});

test("the status corner shows the summary in a status region with an Undo button, and Undo puts the deal back", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const moved = await post(env, "/deals/dl_seed01/move", { stage: "call_done", return_to: "/pipeline?view=list" });
  const location = moved.res.headers.get("Location") ?? "";
  assert.match(location, /^\/pipeline\?view=list&change=chg_/);
  const changeId = changeIdOf(location);
  const page = await load(env, location, moved.cookie);
  assert.match(
    page.body,
    new RegExp(`<div class="corner-notice" role="status">\\n<p class="corner-text">Moved &quot;Website refresh for Example Plumbing&quot; \\(Pat Example\\) to Call done \\(change ${changeId}\\)</p>`),
  );
  assert.match(page.body, new RegExp(`<form class="corner-form" method="post" action="/changes/${changeId}/undo">`));
  assert.match(page.body, /<input type="hidden" name="return_to" value="\/pipeline\?view=list">/, "Undo comes back here, without the old change id");

  const undo = await post(env, `/changes/${changeId}/undo`, { return_to: "/pipeline?view=list" });
  assert.equal(undo.res.status, 303);
  const undoId = changeIdOf(undo.res.headers.get("Location"));
  assert.notEqual(undoId, changeId);
  assert.equal((await dealRow(db, "dl_seed01"))?.stage_key, "call_booked");
  const audit = await db.prepare("SELECT * FROM audit_log WHERE id = ?").bind(undoId).first<AuditRow>();
  assert.equal(audit?.actor, "owner");
  assert.equal(audit?.tool, "undo_change");

  const after = await load(env, undo.res.headers.get("Location") ?? "", moved.cookie);
  assert.match(after.body, /<p class="corner-text">Undone\.<\/p>/);
  assert.doesNotMatch(after.body, /class="corner-form"/, "an undo can't be undone");

  const again = await post(env, `/changes/${changeId}/undo`, { return_to: "/pipeline" });
  assert.equal(again.res.status, 422);
  assert.match(again.body, new RegExp(`${changeId} was already undone`));
  assert.equal(again.body.match(/<h1[\s>]/g)?.length, 1);
  assert.match(again.body, /<a href="\/pipeline">Back to the page<\/a>/);
});

test("the corner ignores a change id of the wrong shape or one that doesn't exist, and says when a change was undone", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  for (const query of ["?change=nonsense", "?change=chg_nothing0000", `?change=${encodeURIComponent("<script>")}`]) {
    assert.doesNotMatch((await load(env, `/contacts${query}`)).body, /class="corner-text"/, query);
  }
  const owner: Ctx = { db, now: new Date(), actor: "ai", tool: "update_deal" };
  const change = await updateDeal(owner, "dl_seed03", { value: 900 });
  const shown = await load(env, `/contacts?change=${change.changeId}`);
  assert.match(shown.body, /<div class="corner-notice" role="status">\n<p class="corner-text">/);
  assert.match(shown.body, /class="corner-form"/);
  db.exec(`UPDATE audit_log SET undone_at = '2026-01-01T00:00:00.000Z', undone_by = 'chg_other' WHERE id = '${change.changeId}'`);
  const undone = await load(env, `/contacts?change=${change.changeId}`);
  assert.match(undone.body, /<p class="corner-text">Undone\.<\/p>/);
  assert.doesNotMatch(undone.body, /class="corner-form"/);
});

test("a move to Won, Lost or Not now asks first and writes nothing; with confirm=yes it closes the deal", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const before = await auditCount(db);
  const ask = await post(env, "/deals/dl_seed01/move", { stage: "won", return_to: "/pipeline" });
  assert.equal(ask.res.status, 200);
  assert.equal(await auditCount(db), before, "nothing written yet");
  assert.equal(ask.body.match(/<h1[\s>]/g)?.length, 1);
  assert.match(ask.body, /<h1>Mark &quot;Website refresh for Example Plumbing&quot; \(Pat Example\) as Won\?<\/h1>/);
  assert.match(ask.body, /<form class="confirm" method="post" action="\/deals\/dl_seed01\/move">/);
  for (const [name, value] of [["stage", "won"], ["confirm", "yes"], ["return_to", "/pipeline"], ["csrf", ask.token]]) {
    assert.match(ask.body, new RegExp(`<input type="hidden" name="${name}" value="${value}">`), name);
  }
  assert.match(ask.body, /<button class="button" type="submit">Mark as Won<\/button>/);
  assert.match(ask.body, /<a class="confirm-cancel" href="\/pipeline">Cancel<\/a>/);
  assert.match(ask.body, /<a href="\/pipeline" aria-current="true">/, "the nav shows the deal's section");

  const outside = await post(env, "/deals/dl_seed02/move", { stage: "not_now", return_to: "/pipeline" });
  assert.match(outside.body, /<h1>Mark deal dl_seed02 \(contact ct_seed02\) as Not now\?<\/h1>/);
  assert.doesNotMatch(outside.body, /Sample Bakery|Robin/, "outside text stays off the confirm page");

  const done = await post(env, "/deals/dl_seed01/move", { stage: "won", confirm: "yes", return_to: "/pipeline" });
  assert.equal(done.res.status, 303);
  const deal = await dealRow(db, "dl_seed01");
  assert.equal(deal?.stage_key, "won");
  assert.equal(deal?.status, "won");
});

test("a refused move shows the plain-English reason on one page, keeps the choice and offers the way back", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const same = await post(env, "/deals/dl_seed01/move", { stage: "call_booked", return_to: "/pipeline" });
  assert.equal(same.res.status, 422);
  assert.equal(same.body.match(/<h1[\s>]/g)?.length, 1);
  assert.match(same.body, /<h1>The deal wasn&#39;t moved<\/h1>/);
  assert.match(same.body, /&quot;Website refresh for Example Plumbing&quot; is already in Call booked\./);
  assert.match(same.body, /<option value="call_booked" selected>/, "the choice is kept");
  assert.match(same.body, /<a href="\/pipeline">Back to the page<\/a>/);

  const unknown = await post(env, "/deals/dl_seed01/move", { stage: "nowhere", return_to: "/pipeline" });
  assert.equal(unknown.res.status, 422);
  assert.match(unknown.body, /There&#39;s no stage &quot;nowhere&quot;/);
  const missing = await post(env, "/deals/dl_seed01/move", { return_to: "/pipeline" });
  assert.equal(missing.res.status, 422);
  assert.match(missing.body, /Choose a stage to move the deal to\./);
});

test("a cross-site post is refused before anything is read: Origin elsewhere, Origin null, or no Origin unless Sec-Fetch-Site is same-origin", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const before = await auditCount(db);
  const fields = { stage: "call_done", return_to: "/pipeline" };
  for (const options of [
    { origin: "https://evil.example" },
    { origin: "http://localhost:4821.evil.example" },
    { origin: "http://localhost:9999" },
    { origin: "null" },
    { origin: null },
    { origin: null, fetchSite: "cross-site" },
    { origin: null, fetchSite: "same-site" },
    { origin: null, fetchSite: "none" },
  ] satisfies PostOptions[]) {
    const { res } = await post(env, "/deals/dl_seed01/move", fields, options);
    assert.equal(res.status, 403, JSON.stringify(options));
  }
  assert.equal(await auditCount(db), before);
  const sameSite = await post(env, "/deals/dl_seed01/move", fields, { origin: null, fetchSite: "same-origin" });
  assert.equal(sameSite.res.status, 303, "a browser that sends no Origin but says same-origin is let through");
});

test("a post without the cookie, or with a token that doesn't match it, gets the out-of-date page and writes nothing", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const before = await auditCount(db);
  const fields = { stage: "call_done", return_to: "/pipeline" };
  const noCookie = await post(env, "/deals/dl_seed01/move", fields, { cookie: null });
  assert.equal(noCookie.res.status, 403);
  assert.match(noCookie.body, new RegExp(OUT_OF_DATE.replace(".", "\\.")));
  assert.equal(noCookie.body.match(/<h1[\s>]/g)?.length, 1);
  const wrong = await post(env, "/deals/dl_seed01/move", fields, { body: new URLSearchParams({ csrf: "A".repeat(43), ...fields }).toString() });
  assert.equal(wrong.res.status, 403);
  assert.match(wrong.body, /This page is out of date/);
  const none = await post(env, "/deals/dl_seed01/move", fields, { body: new URLSearchParams(fields).toString() });
  assert.equal(none.res.status, 403);
  const prodName = await post(env, "/deals/dl_seed01/move", fields, { cookie: `__Host-pipeline-csrf=${"A".repeat(43)}` });
  assert.equal(prodName.res.status, 403, "dev mode reads only the dev cookie name");
  assert.equal(await auditCount(db), before);
});

test("only form posts of at most 16 KB are read: other content types are 415, bigger bodies 413", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const before = await auditCount(db);
  const fields = { stage: "call_done", return_to: "/pipeline" };
  for (const contentType of ["application/json", "multipart/form-data; boundary=x", "text/plain", ""]) {
    const { res } = await post(env, "/deals/dl_seed01/move", fields, { contentType });
    assert.equal(res.status, 415, contentType);
  }
  const charset = await post(env, "/deals/dl_seed01/move", fields, { contentType: "application/x-www-form-urlencoded; charset=UTF-8" });
  assert.equal(charset.res.status, 303, "a charset parameter is fine");

  const big = `stage=call_done&pad=${"x".repeat(16 * 1024)}`;
  assert.equal((await post(env, "/deals/dl_seed01/move", fields, { body: big })).res.status, 413);
  const lying = await post(env, "/deals/dl_seed01/move", fields, { headers: { "Content-Length": String(17 * 1024) } });
  assert.equal(lying.res.status, 413);
  assert.equal(await auditCount(db), before + 1, "only the charset post wrote");
});

test("a POST to a path that is not a board write is 405, a malformed or unknown deal is the 404 page", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  for (const path of ["/pipeline", "/deals/dl_seed01", "/deals/dl_seed01/archive", "/deals/dl_seed01/move/extra", "/changes"]) {
    const { res } = await post(env, path, { stage: "call_done" });
    assert.equal(res.status, 405, path);
    assert.equal(res.headers.get("Allow"), "GET, HEAD", path);
  }
  const api = await post(env, "/api/pipeline", {});
  assert.equal(api.res.status, 405, "/api stays read-only");
  for (const path of ["/deals/not-a-deal/move", "/deals/%3Cscript%3E/move", "/deals/dl_nothing0000/move", "/changes/nonsense/undo"]) {
    const { res, body } = await post(env, path, { stage: "call_done", return_to: "/pipeline" });
    assert.equal(res.status, 404, path);
    assert.match(body, /<h1>Page not found<\/h1>/, path);
  }
});

test("a return_to that isn't a board page on this site falls back to the deal's page", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  for (const returnTo of ["//evil.example", "https://evil.example/", "/\\evil.example", "/%2F%2Fevil.example", "/nope", "", "javascript:alert(1)"]) {
    const { res } = await post(env, "/deals/dl_seed01/move", { stage: "replied", return_to: returnTo });
    assert.equal(res.status, 303, returnTo);
    assert.match(res.headers.get("Location") ?? "", /^\/deals\/dl_seed01\?change=chg_[a-z0-9]{12}$/, returnTo);
    await post(env, "/deals/dl_seed01/move", { stage: "call_booked", return_to: "/pipeline" });
  }
});

test("board posts sit behind the sign-in: misconfigured is 500, production without Access settings is 500, no token is 401", async () => {
  const db = await seededDb();
  const before = await auditCount(db);
  const prod: Env = { ...devEnv(db), AUTH_MODE: undefined, ENVIRONMENT: "production" };
  const misconfigured = await post({ ...prod, AUTH_MODE: "dev" }, "/deals/dl_seed01/move", { stage: "call_done" });
  assert.equal(misconfigured.res.status, 500);
  const notSetUp = await post({ ...prod, OWNER_EMAILS: "owner@example.com" }, "/deals/dl_seed01/move", { stage: "call_done" });
  assert.equal(notSetUp.res.status, 500);
  const noToken = await post(
    { ...prod, ACCESS_TEAM_DOMAIN: "actions-test.cloudflareaccess.com", ACCESS_AUD: "aud", OWNER_EMAILS: "owner@example.com" },
    "/deals/dl_seed01/move",
    { stage: "call_done" },
  );
  assert.equal(noToken.res.status, 401);
  assert.equal(await auditCount(db), before);
});

test("in production a signed-in owner's page sets the __Host- cookie, and a post with it moves the deal", async () => {
  const db = await seededDb();
  const key = await makeKey("kid-actions");
  const team = "actions-prod.cloudflareaccess.com";
  const env: Env = {
    ...devEnv(db),
    AUTH_MODE: undefined,
    ENVIRONMENT: "production",
    ACCESS_TEAM_DOMAIN: team,
    ACCESS_AUD: "board-aud",
    OWNER_EMAILS: "owner@example.com",
  };
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ keys: [key.jwk] })) as typeof fetch;
  try {
    const jwt = await signJwt(key, { iss: `https://${team}`, aud: ["board-aud"], email: "owner@example.com", exp: Date.now() / 1000 + 300 });
    const page = await worker.fetch(new Request("https://board.example.com/pipeline", { headers: { "Cf-Access-Jwt-Assertion": jwt } }), env, ctx);
    const setCookie = page.headers.get("Set-Cookie") ?? "";
    assert.match(setCookie, /^__Host-pipeline-csrf=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
    const token = /=([^;]+)/.exec(setCookie)?.[1] ?? "";
    const res = await worker.fetch(
      new Request("https://board.example.com/deals/dl_seed01/move", {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": jwt,
          Origin: "https://board.example.com",
          Cookie: `__Host-pipeline-csrf=${token}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ csrf: token, stage: "call_done", return_to: "/pipeline" }).toString(),
        redirect: "manual",
      }),
      env,
      ctx,
    );
    assert.equal(res.status, 303);
    const devName = await worker.fetch(
      new Request("https://board.example.com/deals/dl_seed01/move", {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": jwt,
          Origin: "https://board.example.com",
          Cookie: `pipeline-csrf=${token}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ csrf: token, stage: "replied" }).toString(),
        redirect: "manual",
      }),
      env,
      ctx,
    );
    assert.equal(devName.status, 403, "production never reads the dev cookie name");
  } finally {
    globalThis.fetch = original;
  }
});

test("the changes page says who made each change and offers Undo on the ones that can still be undone", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const moved = await post(env, "/deals/dl_seed01/move", { stage: "call_done", return_to: "/changes" });
  const byAi = await updateDeal({ db, now: new Date(), actor: "ai", tool: "update_deal" }, "dl_seed03", { value: 900 });
  const undone = await post(env, `/changes/${byAi.changeId}/undo`, { return_to: "/changes" });
  const undoId = changeIdOf(undone.res.headers.get("Location"));
  const { body } = await load(env, "/changes", moved.cookie);
  const entry = (id: string) => new RegExp(`<li>\\n<p class="row-text">(?:(?!</li>)[\\s\\S])*?<dt>Change id</dt><dd>${id}</dd>(?:(?!</li>)[\\s\\S])*</li>`).exec(body)?.[0] ?? "";
  const movedId = changeIdOf(moved.res.headers.get("Location"));
  assert.match(entry(movedId), /<dt>By<\/dt><dd>You, on the board<\/dd>/);
  assert.match(entry(movedId), new RegExp(`action="/changes/${movedId}/undo"`));
  assert.match(entry(byAi.changeId), /<dt>By<\/dt><dd>Your AI app<\/dd>/);
  assert.doesNotMatch(entry(byAi.changeId), /\/undo"/, "already undone");
  assert.doesNotMatch(entry(undoId), /\/undo"/, "an undo entry");
  assert.match(body, /<p class="lede">The last 30 days, newest first\. Undo a change here, or ask your AI app and give it the change id\.<\/p>/);
});

test("a move to the stage the deal is already in says so, even for a closed stage, without asking first", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const before = await auditCount(db);
  const won = await post(env, "/deals/dl_seed07/move", { stage: "won", return_to: "/pipeline" });
  assert.equal(won.res.status, 422);
  assert.match(won.body, /&quot;Salon booking site&quot; is already in Won\./);
  assert.doesNotMatch(won.body, /name="confirm"/, "no confirm page");
  assert.equal(await auditCount(db), before);
});

test("an undo that would remove records asks first and writes nothing; confirmed, it removes them", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const lead = await addDeal({ db, now: new Date(), actor: "ai", tool: "add_deal" }, { name: "Lee Example", dealTitle: "Garage plans" });
  const before = await auditCount(db);
  const ask = await post(env, `/changes/${lead.changeId}/undo`, { return_to: "/changes" });
  assert.equal(ask.res.status, 200);
  assert.equal(await auditCount(db), before, "nothing written yet");
  assert.equal(ask.body.match(/<h1[\s>]/g)?.length, 1);
  assert.match(ask.body, /<h1>Undo this change\?<\/h1>/);
  assert.match(ask.body, /It removes 1 contact and 1 deal\. This can't be reversed\./);
  assert.match(ask.body, new RegExp(`<form class="confirm" method="post" action="/changes/${lead.changeId}/undo">`));
  for (const [name, value] of [["confirm", "yes"], ["return_to", "/changes"], ["csrf", ask.token]]) {
    assert.match(ask.body, new RegExp(`<input type="hidden" name="${name}" value="${value}">`), name);
  }
  assert.match(ask.body, /<a class="confirm-cancel" href="\/changes">Cancel<\/a>/);
  assert.ok(await db.prepare("SELECT id FROM contacts WHERE id = ?").bind(lead.contactId).first());

  const done = await post(env, `/changes/${lead.changeId}/undo`, { confirm: "yes", return_to: "/changes" });
  assert.equal(done.res.status, 303);
  assert.equal(await db.prepare("SELECT id FROM contacts WHERE id = ?").bind(lead.contactId).first(), null);
});

test("an undo that only puts values back is still one click", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const edited = await updateDeal({ db, now: new Date(), actor: "ai", tool: "update_deal" }, "dl_seed03", { value: 900 });
  const undone = await post(env, `/changes/${edited.changeId}/undo`, { return_to: "/changes" });
  assert.equal(undone.res.status, 303);
});
