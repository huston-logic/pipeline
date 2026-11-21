// The Notifications page and its three write routes (decision 0030), driven through the Worker.
import assert from "node:assert/strict";
import { test } from "node:test";
import { auditOf, changeIdOf, devEnv, formFields, h1Count, load, post, seededDb } from "../../tests/helpers/board.ts";
import type { PushSubscriptionRow } from "../db/db.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import type { Env } from "../env.ts";
import { toBase64Url } from "../push/bytes.ts";
import { moreItems, boardRoutes } from "./routes.ts";

async function fakeSecrets() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return { VAPID_PUBLIC_KEY: toBase64Url(raw), VAPID_PRIVATE_KEY: jwk.d ?? "", VAPID_SUBJECT: "mailto:owner@example.com" };
}

async function browserKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { p256dh: toBase64Url(raw), auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) };
}

async function pushEnv(db: SqliteD1): Promise<Env> {
  return { ...devEnv(db), ...(await fakeSecrets()) };
}

const subs = async (db: SqliteD1) => (await db.prepare("SELECT * FROM push_subscriptions ORDER BY created_at, id").all<PushSubscriptionRow>()).results;

/** The subscribe form as push.js sends it: the page's own fields with the browser's subscription filled in. */
async function turnOn(env: Env, n: number) {
  const page = await load(env, "/notifications");
  const fields = formFields(page.body, "/notifications/on");
  const keys = await browserKeys();
  fields.set("endpoint", `https://push.example.net/send/device-${n}`);
  fields.set("p256dh", keys.p256dh);
  fields.set("auth", keys.auth);
  return post(env, "/notifications/on", fields, { cookie: page.cookie, token: page.token });
}

test("Notifications is a board page under More", () => {
  assert.ok(boardRoutes.includes("/notifications"));
  assert.ok(moreItems.some((item) => item.href === "/notifications" && item.label === "Notifications"));
});

test("without the keys the page says so and has nothing to tap, and loads no script", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  for (const missing of [{}, { VAPID_SUBJECT: undefined }]) {
    const page = await load({ ...env, ...(Object.keys(missing).length === 0 ? {} : { ...(await fakeSecrets()), ...missing }) }, "/notifications");
    assert.equal(page.res.status, 200);
    assert.equal(h1Count(page.body), 1);
    assert.match(page.body, /<title>Notifications · /);
    assert.match(page.body, /This copy has no notification keys yet\./);
    assert.doesNotMatch(page.body, /<form/);
    assert.doesNotMatch(page.body, /<button/);
    assert.doesNotMatch(page.body, /<script/);
  }
});

test("with the keys: the turn-on form (hidden until push.js shows it), the can't line, push.js and no device yet", async () => {
  const db = await seededDb();
  const env = await pushEnv(db);
  const page = await load(env, "/notifications");
  assert.equal(page.res.status, 200);
  assert.equal(h1Count(page.body), 1);
  assert.match(page.body, /<script src="\/push\.js" defer><\/script>/);
  assert.doesNotMatch(page.body, /board\.js/);
  assert.match(page.body, new RegExp(`<form class="push-on" method="post" action="/notifications/on" data-push-key="${env.VAPID_PUBLIC_KEY}" data-push-status="push-status" hidden>`));
  assert.match(page.body, /<button class="button" type="submit">Turn on notifications<\/button>/);
  for (const name of ["endpoint", "p256dh", "auth"]) assert.match(page.body, new RegExp(`<input type="hidden" name="${name}" value="">`));
  assert.match(page.body, /<p data-push-unsupported>This browser can't turn notifications on\. On an iPhone, add the board to the Home Screen first and open it from there\.<\/p>/);
  assert.match(page.body, /<p class="push-status" id="push-status" role="status"><\/p>/);
  assert.match(page.body, /No device has notifications on yet\./);
  assert.doesNotMatch(page.body, /Send a test/, "nothing to test yet");
  assert.doesNotMatch(page.body, /VAPID_PRIVATE_KEY|"d":/);
  assert.equal(page.body.includes(env.VAPID_PRIVATE_KEY ?? "?"), false, "the private key never reaches the page");
});

test("Turn on: push_subscribe by the owner, back to the page with the banner; the device is listed with Turn off", async () => {
  const db = await seededDb();
  const env = await pushEnv(db);
  const res = await turnOn(env, 1);
  assert.equal(res.res.status, 303);
  assert.match(res.location, /^\/notifications\?change=chg_[a-z2-7]+$/);
  const change = await auditOf(db, changeIdOf(res.location));
  assert.equal(change?.actor, "owner");
  assert.equal(change?.tool, "push_subscribe");
  const [row] = await subs(db);
  assert.ok(row);

  const page = await load(env, res.location);
  assert.match(page.body, /<div class="banner" role="status">\s*<p class="banner-text">Turned on notifications on one device \(ps_/);
  assert.doesNotMatch(page.body, /push\.example\.net/, "the endpoint is never shown");
  assert.match(page.body, new RegExp(`action="/notifications/${row.id}/off"`));
  assert.match(page.body, /Turn off<span class="visually-hidden"> notifications on device 1<\/span>/);
  assert.match(page.body, /action="\/notifications\/test"/);
  assert.match(page.body, /<button class="button" type="submit">Send a test<\/button>/);
});

test("the same browser turning on again is no change: back to the page with a note", async () => {
  const db = await seededDb();
  const env = await pushEnv(db);
  const first = await turnOn(env, 1);
  const page = await load(env, "/notifications");
  const fields = formFields(page.body, "/notifications/on");
  const [row] = await subs(db);
  assert.ok(row);
  fields.set("endpoint", row.endpoint);
  fields.set("p256dh", row.p256dh);
  fields.set("auth", row.auth);
  const again = await post(env, "/notifications/on", fields, { cookie: page.cookie, token: page.token });
  assert.equal(again.res.status, 303);
  assert.equal(again.location, "/notifications?note=already");
  assert.ok(first.location);
  assert.match((await load(env, again.location)).body, /<p class="push-note" role="status">Notifications are already on for this device\.<\/p>/);
  assert.equal((await subs(db)).length, 1);
});

test("a subscription that isn't usable is a 422 with the reason, and nothing is written", async () => {
  const db = await seededDb();
  const env = await pushEnv(db);
  const page = await load(env, "/notifications");
  const fields = formFields(page.body, "/notifications/on");
  fields.set("endpoint", "http://push.example.net/x");
  fields.set("p256dh", "AAAA");
  fields.set("auth", "AAAA");
  const res = await post(env, "/notifications/on", fields, { cookie: page.cookie, token: page.token });
  assert.equal(res.res.status, 422);
  assert.match(res.body, /isn&#39;t a notification subscription this board can use/);
  assert.equal((await subs(db)).length, 0);
});

test("without the keys the write routes refuse with the same plain message", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const res = await post(env, "/notifications/test", {});
  assert.equal(res.res.status, 422);
  assert.match(res.body, /This copy has no notification keys yet\./);
});

test("Send a test: one push to each device that is on, then the page says how it went", async (t) => {
  const db = await seededDb();
  const env = await pushEnv(db);
  await turnOn(env, 1);
  await turnOn(env, 2);
  await turnOn(env, 3);
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(url);
    return new Response(null, { status: url.endsWith("device-3") ? 410 : 201 });
  });
  const res = await post(env, "/notifications/test", {});
  assert.equal(res.res.status, 303);
  assert.equal(res.location, "/notifications?sent=2&gone=1&failed=0");
  assert.equal(urls.length, 3);
  const page = await load(env, res.location);
  assert.match(page.body, /<p class="push-note" role="status">Test sent to 2 devices\. 1 device no longer accepts notifications and was turned off\.<\/p>/);
  assert.equal((await subs(db)).filter((row) => row.gone_at === null).length, 2);
});

test("the test note reads only small numbers from the address; anything else shows nothing", async () => {
  const db = await seededDb();
  const env = await pushEnv(db);
  assert.match((await load(env, "/notifications?sent=0&gone=0&failed=0")).body, /No device has notifications on, so nothing was sent\./);
  assert.match((await load(env, "/notifications?sent=1&gone=0&failed=2")).body, /Test sent to 1 device\. 2 couldn&#39;t be reached\. Try again later\./);
  for (const query of ["?sent=abc", "?sent=1e9&gone=0&failed=0", "?sent=<b>&gone=0&failed=0", "?note=other"]) {
    assert.doesNotMatch((await load(env, `/notifications${query}`)).body, /class="push-note"/, query);
  }
});

test("Turn off on this phone: rows carry their endpoint's SHA-256 (never the endpoint); the off form removes by endpoint", async () => {
  const db = await seededDb();
  const env = await pushEnv(db);
  await turnOn(env, 1);
  await turnOn(env, 2);
  const page = await load(env, "/notifications");
  assert.match(page.body, /<form class="push-off" method="post" action="\/notifications\/off" data-push-off hidden>/);
  assert.match(page.body, /<button class="button button-quiet" type="submit">Turn off on this phone<\/button>/);
  assert.equal(page.body.match(/<span class="tag" data-push-here hidden>This phone<\/span>/g)?.length, 2, "one hidden marker per row");
  assert.doesNotMatch(page.body, /push\.example\.net/);
  const [one, two] = await subs(db);
  assert.ok(one && two);
  for (const row of [one, two]) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(row.endpoint)));
    const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
    assert.match(page.body, new RegExp(`<li data-push-device="${hex}">`));
  }

  // What push.js sends once it has filled the endpoint from this browser's own subscription.
  const fields = formFields(page.body, "/notifications/off");
  fields.set("endpoint", two.endpoint);
  const res = await post(env, "/notifications/off", fields, { cookie: page.cookie, token: page.token });
  assert.equal(res.res.status, 303);
  const change = await auditOf(db, changeIdOf(res.location));
  assert.equal(change?.tool, "push_remove");
  assert.equal(change?.actor, "owner");
  assert.deepEqual((await subs(db)).filter((row) => row.gone_at === null).map((row) => row.id), [one.id]);

  fields.set("endpoint", "https://push.example.net/send/unknown");
  const refused = await post(env, "/notifications/off", fields, { cookie: page.cookie, token: page.token });
  assert.equal(refused.res.status, 422);
  assert.match(refused.body, /Notifications aren&#39;t on for this device\./);
  assert.doesNotMatch(refused.body, /push\.example\.net/);
});

test("Turn off: push_remove by the owner, undoable from the banner; an unknown id is 404", async () => {
  const db = await seededDb();
  const env = await pushEnv(db);
  await turnOn(env, 1);
  const [row] = await subs(db);
  assert.ok(row);
  const res = await post(env, `/notifications/${row.id}/off`, {});
  assert.equal(res.res.status, 303);
  const changeId = changeIdOf(res.location);
  assert.equal((await auditOf(db, changeId))?.tool, "push_remove");
  const page = await load(env, res.location);
  assert.match(page.body, /Turned off notifications on one device/);
  assert.match(page.body, /No device has notifications on yet\./);
  assert.match(page.body, new RegExp(`action="/changes/${changeId}/undo"`));

  const undo = await post(env, `/changes/${changeId}/undo`, { return_to: "/notifications" });
  assert.equal(undo.res.status, 303);
  assert.equal((await subs(db))[0]?.gone_at, null, "back on");

  assert.equal((await post(env, "/notifications/ps_nosuchdevice/off", {})).res.status, 422);
  assert.equal((await post(env, "/notifications/not-an-id/off", {})).res.status, 404);
});
