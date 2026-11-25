// Svix webhook signatures, as Resend sends them (headers svix-id, svix-timestamp, svix-signature).
const SECRET_PREFIX = "whsec_";
const TOLERANCE_SECONDS = 300;
const SIGNATURE_PREFIX = "v1,";

export interface SvixHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

function fromBase64(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** True when the timestamp is within five minutes of now and any `v1,` entry is the HMAC-SHA256 of `id.timestamp.body`. */
export async function verifySvix(secret: string, headers: SvixHeaders, rawBody: string | Uint8Array, now: Date): Promise<boolean> {
  if (!secret.startsWith(SECRET_PREFIX)) return false;
  const keyBytes = fromBase64(secret.slice(SECRET_PREFIX.length));
  if (keyBytes === null || keyBytes.length === 0) return false;
  if (!/^\d{1,12}$/.test(headers.timestamp)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(headers.timestamp)) > TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prefix = new TextEncoder().encode(`${headers.id}.${headers.timestamp}.`);
  const bodyBytes = typeof rawBody === "string" ? new TextEncoder().encode(rawBody) : rawBody;
  const signed = new Uint8Array(prefix.length + bodyBytes.length);
  signed.set(prefix);
  signed.set(bodyBytes, prefix.length);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed));

  let matched = false;
  for (const entry of headers.signature.split(" ")) {
    if (!entry.startsWith(SIGNATURE_PREFIX)) continue;
    const given = fromBase64(entry.slice(SIGNATURE_PREFIX.length));
    if (given !== null && sameBytes(given, expected)) matched = true;
  }
  return matched;
}
