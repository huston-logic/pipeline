// VAPID (RFC 8292): the Authorization header that tells a push service which server sends, signed with this copy's
// key. ES256 JWT with aud = the endpoint's origin, exp = now + 12 hours (the RFC allows up to 24) and sub = the
// VAPID_SUBJECT secret. The keys are per-copy secrets (decision 0030); without all three, push is off.
import type { Env } from "../env.ts";
import { base64UrlBytes, toBase64Url, utf8 } from "./bytes.ts";

export type VapidKeys = { publicKey: string; privateKeyJwk: JsonWebKey; subject: string };

const EXPIRES_SECONDS = 12 * 3600;
/**
 * A VAPID subject: "mailto:" with an "@" that has something on both sides, or "https://" and something more; no
 * whitespace anywhere. Checked with plain string scans (linear time), not a backtracking regular expression.
 */
export function isVapidSubject(text: string): boolean {
  if (/\s/.test(text)) return false;
  if (text.startsWith("mailto:")) return text.slice("mailto:".length + 1, -1).includes("@");
  return text.startsWith("https://") && text.length > "https://".length;
}

/** The keys from the three secrets, or null when one is missing or malformed (push is then off). */
export function vapidKeys(env: Pick<Env, "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY" | "VAPID_SUBJECT">): VapidKeys | null {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: d, VAPID_SUBJECT: subject } = env;
  if (!publicKey || !d || !subject || !isVapidSubject(subject)) return null;
  const point = base64UrlBytes(publicKey, 65);
  if (point === null || point[0] !== 0x04 || base64UrlBytes(d, 32) === null) return null;
  const privateKeyJwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d,
    x: toBase64Url(point.slice(1, 33)),
    y: toBase64Url(point.slice(33, 65)),
  };
  return { publicKey, privateKeyJwk, subject };
}

const segment = (value: object) => toBase64Url(utf8(JSON.stringify(value)));

export async function vapidHeaders(endpoint: string, keys: VapidKeys, now: Date): Promise<Record<string, string>> {
  const url = new URL(endpoint);
  if (url.protocol !== "https:") throw new Error("A push endpoint must be https.");
  const claims = { aud: url.origin, exp: Math.floor(now.getTime() / 1000) + EXPIRES_SECONDS, sub: keys.subject };
  const unsigned = `${segment({ typ: "JWT", alg: "ES256" })}.${segment(claims)}`;
  const key = await crypto.subtle.importKey("jwk", keys.privateKeyJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(unsigned)));
  return { Authorization: `vapid t=${unsigned}.${toBase64Url(signature)}, k=${keys.publicKey}` };
}
