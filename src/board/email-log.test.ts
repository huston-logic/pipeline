import assert from "node:assert/strict";
import { test } from "node:test";
import { devEnv, h1Count, load, seededDb, send } from "../../tests/helpers/board.ts";
import { LOG_ADDRESS } from "../../tests/helpers/fake-email.ts";
import type { Env } from "../env.ts";
import { boardRoutes, moreItems } from "./routes.ts";

const withAddress = async (address: string | undefined): Promise<Env> => ({
  ...devEnv(await seededDb()),
  EMAIL_LOG_ADDRESS: address,
});

const mainOf = (body: string) => /<main id="main" tabindex="-1"[^>]*>([\s\S]*)<\/main>/.exec(body)?.[1] ?? "";

test("Email logging shows the address to copy and the two lines on how to Bcc it (decision 0031)", async () => {
  const { res, body } = await load(await withAddress(LOG_ADDRESS), "/email-log");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.equal(h1Count(body), 1);
  const main = mainOf(body);
  assert.match(main, /<h1>Email logging<\/h1>/);
  assert.match(main, /To log an email, add this address in Bcc when you write to a lead or contact\./);
  assert.match(main, /Only mail you send from your own address is logged; replies from others are not\./);
  assert.match(main, new RegExp(`<label for="log-address">Log address</label>\\s*<input id="log-address" type="text" value="${LOG_ADDRESS}" readonly`));
  assert.match(
    main,
    /<button class="button button-quiet button-small" type="button" data-copy="log-address" data-copy-status="log-address-status" data-copy-fail="[^"]+" hidden>Copy address<\/button>/,
  );
  assert.match(main, /<p class="copy-status" id="log-address-status" aria-live="polite"><\/p>/);
  assert.match(body, /<script src="\/board.js" defer>/, "board.js runs the Copy button");
});

test("the address is never in a link, the title or the description", async () => {
  const { body } = await load(await withAddress(LOG_ADDRESS), "/email-log");
  const head = /<head>[\s\S]*<\/head>/.exec(body)?.[0] ?? "";
  assert.ok(!head.includes(LOG_ADDRESS));
  for (const link of body.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)) assert.ok(!link[0].includes(LOG_ADDRESS), link[0]);
  assert.doesNotMatch(body, /mailto:/);
});

test("without EMAIL_LOG_ADDRESS the page says it isn't set up, with no field and no script", async () => {
  for (const address of [undefined, "", "  "]) {
    const { res, body } = await load(await withAddress(address), "/email-log");
    assert.equal(res.status, 200);
    const main = mainOf(body);
    assert.match(main, /Email logging isn&#39;t set up for this copy\.|Email logging isn't set up for this copy\./);
    assert.doesNotMatch(main, /<input|data-copy/);
    assert.doesNotMatch(body.replace('<script src="/live.js" defer></script>\n<script src="/clock.js" defer></script>', ""), /<script/);
  }
});

test("an address with markup in it is escaped", async () => {
  const { body } = await load(await withAddress('log-"><b>x@log.example.com'), "/email-log");
  assert.match(body, /value="log-&quot;&gt;&lt;b&gt;x@log.example.com"/);
  assert.doesNotMatch(body, /<b>x@/);
});

test("the page needs the board sign-in, like every board page", async () => {
  const env: Env = { ...(await withAddress(LOG_ADDRESS)), AUTH_MODE: undefined, ENVIRONMENT: "production" };
  const res = await send(env, "/email-log");
  assert.notEqual(res.status, 200);
  assert.ok(!(await res.text()).includes(LOG_ADDRESS));
});

test("a stored brief's Logged email line shows on the Brief page (its section is one the reader keeps)", async () => {
  const env = await withAddress(LOG_ADDRESS);
  const item = { section: "logged_email", id: "email_log", line: "- 2 logged emails matched no one.", untrusted: false };
  await env.DB.prepare("INSERT INTO briefs (id, local_date, composed_at, text, items) VALUES ('br_emaillog', '2030-01-02', '2030-01-02T15:00:00.000Z', 'x', ?)")
    .bind(JSON.stringify([item]))
    .run();
  const main = mainOf((await load(env, "/brief")).body);
  assert.match(main, /<h2 id="brief-logged_email">Logged email<\/h2>\s*<ul class="panel rows"><li>2 logged emails matched no one\.<\/li><\/ul>/);
});

test("Email logging is listed under More and in the board routes", () => {
  assert.ok(boardRoutes.includes("/email-log"));
  assert.ok(moreItems.some((item) => item.href === "/email-log" && item.label === "Email logging"));
});
