import assert from "node:assert/strict";
import { test } from "node:test";
import type { Env } from "../env.ts";
import { fromBase64Url, toBase64Url, utf8 } from "./bytes.ts";
import { vapidHeaders, vapidKeys } from "./vapid.ts";

const NOW = new Date("2026-11-19T15:00:00.000Z");
const ENDPOINT = "https://push.example.net/send/abc123?x=1";

/** A fresh VAPID pair in the secrets' formats: the uncompressed public point and the private scalar d. */
async function fakeSecrets(): Promise<{ VAPID_PUBLIC_KEY: string; VAPID_PRIVATE_KEY: string; VAPID_SUBJECT: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return { VAPID_PUBLIC_KEY: toBase64Url(raw), VAPID_PRIVATE_KEY: jwk.d ?? "", VAPID_SUBJECT: "mailto:owner@example.com" };
}

const envWith = (extra: Partial<Env>) => extra as Env;

test("vapidKeys: null unless all three secrets are set and well formed", async () => {
  const secrets = await fakeSecrets();
  assert.notEqual(vapidKeys(envWith(secrets)), null);
  assert.equal(vapidKeys(envWith({})), null);
  assert.equal(vapidKeys(envWith({ ...secrets, VAPID_PUBLIC_KEY: undefined })), null);
  assert.equal(vapidKeys(envWith({ ...secrets, VAPID_PRIVATE_KEY: "" })), null);
  assert.equal(vapidKeys(envWith({ ...secrets, VAPID_SUBJECT: undefined })), null);
  assert.equal(vapidKeys(envWith({ ...secrets, VAPID_SUBJECT: "owner@example.com" })), null, "needs mailto: or https:");
  assert.equal(vapidKeys(envWith({ ...secrets, VAPID_SUBJECT: "http://example.com" })), null);
  assert.notEqual(vapidKeys(envWith({ ...secrets, VAPID_SUBJECT: "https://example.com" })), null);
  assert.equal(vapidKeys(envWith({ ...secrets, VAPID_PUBLIC_KEY: secrets.VAPID_PUBLIC_KEY.slice(4) })), null, "a short key");
  assert.equal(vapidKeys(envWith({ ...secrets, VAPID_PRIVATE_KEY: "not base64url!" })), null);
});

test("vapidHeaders: an ES256 JWT for the endpoint's origin that verifies with the public key, and k = that key", async () => {
  const secrets = await fakeSecrets();
  const keys = vapidKeys(envWith(secrets));
  assert.ok(keys);
  const headers = await vapidHeaders(ENDPOINT, keys, NOW);
  assert.deepEqual(Object.keys(headers), ["Authorization"]);
  const match = /^vapid t=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(headers.Authorization ?? "");
  assert.ok(match, headers.Authorization);
  const [, head = "", body = "", signature = "", k = ""] = match;
  assert.equal(k, secrets.VAPID_PUBLIC_KEY);

  const decode = (part: string) => JSON.parse(new TextDecoder().decode(fromBase64Url(part))) as Record<string, unknown>;
  assert.deepEqual(decode(head), { typ: "JWT", alg: "ES256" });
  const claims = decode(body);
  assert.deepEqual(claims, {
    aud: "https://push.example.net",
    exp: NOW.getTime() / 1000 + 12 * 3600,
    sub: "mailto:owner@example.com",
  });

  const publicKey = await crypto.subtle.importKey("raw", fromBase64Url(k), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const signed = utf8(`${head}.${body}`);
  const sig = fromBase64Url(signature);
  assert.equal(sig.length, 64, "JWS ES256 is r || s, 64 bytes");
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, sig, signed));
});

test("vapidHeaders refuses an endpoint that isn't https", async () => {
  const keys = vapidKeys(envWith(await fakeSecrets()));
  assert.ok(keys);
  await assert.rejects(vapidHeaders("http://push.example.net/x", keys, NOW), /https/);
});
