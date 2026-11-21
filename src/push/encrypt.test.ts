import assert from "node:assert/strict";
import { test } from "node:test";
import { fromBase64Url, toBase64Url } from "./bytes.ts";
import { ecdhWith, encryptPayload, RECORD_SIZE } from "./encrypt.ts";

// RFC 8291 Appendix A: the example message, keys and salt, and the body they must produce.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_" +
    "yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** The JWK of a P-256 key pair from its raw private scalar and uncompressed public point. */
function jwkOf(privateD: string, publicRaw: string): JsonWebKey {
  const point = fromBase64Url(publicRaw);
  return { kty: "EC", crv: "P-256", d: privateD, x: toBase64Url(point.slice(1, 33)), y: toBase64Url(point.slice(33, 65)) };
}

test("encryptPayload reproduces RFC 8291 Appendix A byte for byte with the RFC's keys and salt", async () => {
  const body = await encryptPayload(
    new TextEncoder().encode(RFC.plaintext),
    { p256dh: RFC.uaPublic, auth: RFC.authSecret },
    { sender: { publicKey: RFC.asPublic, privateKeyJwk: jwkOf(RFC.asPrivate, RFC.asPublic) }, salt: fromBase64Url(RFC.salt) },
  );
  assert.equal(toBase64Url(body), RFC.body);
});

test("the header holds the salt, a 4096-byte record size and the sender's 65-byte public key", async () => {
  const body = await encryptPayload(new TextEncoder().encode('{"kind":"brief"}'), { p256dh: RFC.uaPublic, auth: RFC.authSecret });
  assert.equal(RECORD_SIZE, 4096);
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  assert.equal(view.getUint32(16), 4096);
  assert.equal(body[20], 65);
  assert.equal(body[21], 0x04, "an uncompressed point");
  // 16 salt + 4 rs + 1 idlen + 65 key, then the payload, its 0x02 delimiter and the 16-byte tag.
  assert.equal(body.length, 86 + 16 + 1 + 16);
});

test("each call uses a fresh salt and sender key, so two bodies for the same message differ", async () => {
  const message = new TextEncoder().encode('{"kind":"brief"}');
  const one = await encryptPayload(message, { p256dh: RFC.uaPublic, auth: RFC.authSecret });
  const two = await encryptPayload(message, { p256dh: RFC.uaPublic, auth: RFC.authSecret });
  assert.notEqual(toBase64Url(one), toBase64Url(two));
  assert.notEqual(toBase64Url(one.slice(0, 16)), toBase64Url(two.slice(0, 16)));
});

test("the receiver can decrypt what encryptPayload wrote (RFC 8291 section 3.4, from the browser's side)", async () => {
  const message = '{"kind":"brief"}';
  const body = await encryptPayload(new TextEncoder().encode(message), { p256dh: RFC.uaPublic, auth: RFC.authSecret });
  const salt = body.slice(0, 16);
  const senderPublic = body.slice(21, 86);
  const ciphertext = body.slice(86);

  const uaKey = await crypto.subtle.importKey("jwk", jwkOf(RFC.uaPrivate, RFC.uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const asKey = await crypto.subtle.importKey("raw", senderPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdhWith(asKey), uaKey, 256));
  const hkdf = async (saltBytes: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) =>
    new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: saltBytes, info },
        await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]),
        bytes * 8,
      ),
    );
  const text = (s: string) => new TextEncoder().encode(s);
  const keyInfo = new Uint8Array([...text("WebPush: info\0"), ...fromBase64Url(RFC.uaPublic), ...senderPublic]);
  const ikm = await hkdf(fromBase64Url(RFC.authSecret), shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, text("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, text("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, ciphertext));
  assert.equal(plain.at(-1), 0x02, "the last record's delimiter");
  assert.equal(new TextDecoder().decode(plain.slice(0, -1)), message);
});

test("a subscription with a malformed key is refused before anything is sent", async () => {
  const message = new TextEncoder().encode("{}");
  await assert.rejects(encryptPayload(message, { p256dh: "AAAA", auth: RFC.authSecret }), /p256dh/);
  await assert.rejects(encryptPayload(message, { p256dh: RFC.uaPublic, auth: "AAAA" }), /auth/);
});
