// Message encryption for web push (RFC 8291, with the aes128gcm content coding of RFC 8188), Web Crypto only. One
// record: the payload, the 0x02 last-record delimiter and no padding. Decision 0030: the payload is a fixed,
// name-free {"kind":"brief"}, encrypted because an empty push is not confirmed to reach every push service.
import { base64UrlBytes, concatBytes, fromBase64Url, utf8 } from "./bytes.ts";

export const RECORD_SIZE = 4096;

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

/**
 * ECDH's deriveBits parameters. The runtime reads the standard `public` member; the generated Workers types spell it
 * `$public` (their generator's escape for a reserved word), so the object is typed by hand here.
 */
export const ecdhWith = (publicKey: CryptoKey) => ({ name: "ECDH", public: publicKey }) as unknown as SubtleCryptoDeriveKeyAlgorithm;

/** What the browser's subscription gives: its P-256 public key (65 bytes) and its 16-byte auth secret, base64url. */
export type PushTarget = { p256dh: string; auth: string };

/** Fixed sender key and salt, for the RFC's test vector only. Without them each message gets fresh ones. */
export type EncryptOptions = {
  sender?: { publicKey: string; privateKeyJwk: JsonWebKey };
  salt?: Uint8Array;
};

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

async function senderKeys(options: EncryptOptions): Promise<{ publicRaw: Uint8Array; privateKey: CryptoKey }> {
  if (options.sender) {
    return {
      publicRaw: fromBase64Url(options.sender.publicKey),
      privateKey: await crypto.subtle.importKey("jwk", options.sender.privateKeyJwk, ECDH, false, ["deriveBits"]),
    };
  }
  const pair = (await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
  const publicRaw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { publicRaw, privateKey: pair.privateKey };
}

/** The request body for one push: the aes128gcm header (salt, record size, sender key) and the one encrypted record. */
export async function encryptPayload(
  payload: Uint8Array,
  target: PushTarget,
  options: EncryptOptions = {},
): Promise<Uint8Array> {
  const uaPublic = base64UrlBytes(target.p256dh, 65);
  if (uaPublic === null || uaPublic[0] !== 0x04) throw new Error("The subscription's p256dh key isn't a P-256 public key.");
  const authSecret = base64UrlBytes(target.auth, 16);
  if (authSecret === null) throw new Error("The subscription's auth secret isn't 16 bytes.");

  const { publicRaw, privateKey } = await senderKeys(options);
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, ECDH, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdhWith(uaKey), privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concatBytes(utf8("WebPush: info\0"), uaPublic, publicRaw), 32);
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const record = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concatBytes(payload, new Uint8Array([2]))));

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = publicRaw.length;
  return concatBytes(header, publicRaw, record);
}
