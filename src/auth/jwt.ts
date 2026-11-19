// RS256 JWT verification with Web Crypto, for Cloudflare Access tokens (the board, /api) and Access for SaaS id tokens
// (the /mcp sign-in). Only RS256 is accepted: `none`, HS256 and every other algorithm are refused before any key is
// used. Signing keys come from a JWKS URL, cached per isolate for five minutes; a token with an unknown `kid` refetches
// the keys once (at most every 30 seconds, so junk tokens can't make the Worker hammer the JWKS host).

/** The token is not valid. `reason` is a fixed word for logs and tests; it never holds token content. */
export class JwtError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`The sign-in token isn't valid (${reason}).`);
    this.name = "JwtError";
    this.reason = reason;
  }
}

/** Fetches a JWKS document. Throwing (or a document without keys) means the keys are unavailable, not a bad token. */
export type JwksFetcher = (url: string) => Promise<unknown>;

export interface VerifyJwtOptions {
  jwksUrl: string;
  /** Exact `iss` values accepted. */
  issuers: readonly string[];
  /** Must be the `aud` string or one of the `aud` array's entries. */
  audience: string;
  fetchJwks?: JwksFetcher;
  /** Milliseconds since the epoch; tests pass a fixed clock. */
  now?: () => number;
}

export const CLOCK_SKEW_SECONDS = 60;
const KEYS_TTL_MS = 5 * 60_000;
const REFETCH_MIN_MS = 30_000;
const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const SEGMENT = /^[A-Za-z0-9_-]+$/;

const defaultFetchJwks: JwksFetcher = async (url) => {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`The signing keys could not be fetched (status ${res.status}).`);
  }
  return res.json();
};

type KeySet = { keys: Map<string, CryptoKey>; fetchedAt: number };

// One cache per fetcher, so tests that pass their own fetcher never share keys with each other or the Worker.
const caches = new WeakMap<JwksFetcher, Map<string, KeySet>>();

async function importKeys(document: unknown): Promise<Map<string, CryptoKey>> {
  const list = typeof document === "object" && document !== null ? (document as { keys?: unknown }).keys : undefined;
  if (!Array.isArray(list)) throw new Error("The signing keys document has no keys.");
  const keys = new Map<string, CryptoKey>();
  for (const entry of list as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const jwk = entry as Record<string, unknown>;
    if (jwk.kty !== "RSA" || typeof jwk.kid !== "string" || typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
    if (jwk.use !== undefined && jwk.use !== "sig") continue;
    if (jwk.alg !== undefined && jwk.alg !== "RS256") continue;
    try {
      const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, RS256, false, ["verify"]);
      keys.set(jwk.kid, key);
    } catch {
      // A key this runtime can't import can't have signed a token we accept.
    }
  }
  return keys;
}

async function signingKey(kid: string, url: string, fetchJwks: JwksFetcher, now: number): Promise<CryptoKey | undefined> {
  let byUrl = caches.get(fetchJwks);
  if (!byUrl) caches.set(fetchJwks, (byUrl = new Map()));
  const refresh = async () => {
    const set = { keys: await importKeys(await fetchJwks(url)), fetchedAt: now };
    byUrl.set(url, set);
    return set;
  };
  let set = byUrl.get(url);
  if (!set || now - set.fetchedAt >= KEYS_TTL_MS) set = await refresh();
  if (!set.keys.has(kid) && now - set.fetchedAt >= REFETCH_MIN_MS) set = await refresh();
  return set.keys.get(kid);
}

function decodeSegment(segment: string): Uint8Array {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

function decodeJson(segment: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(decodeSegment(segment)));
  } catch {
    throw new JwtError("malformed");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new JwtError("malformed");
  return value as Record<string, unknown>;
}

/** Verifies the signature and the iss, aud, exp and nbf claims, and returns the claims. Throws JwtError if invalid. */
export async function verifyRs256Jwt(token: string, options: VerifyJwtOptions): Promise<Record<string, unknown>> {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3 || !parts.every((part) => SEGMENT.test(part))) throw new JwtError("malformed");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodeJson(headerPart);
  if (header.alg !== "RS256") throw new JwtError("algorithm");
  if (typeof header.kid !== "string" || header.kid === "") throw new JwtError("kid");
  const claims = decodeJson(payloadPart);

  const now = (options.now ?? Date.now)();
  const key = await signingKey(header.kid, options.jwksUrl, options.fetchJwks ?? defaultFetchJwks, now);
  if (!key) throw new JwtError("unknown_key");
  let signature: Uint8Array;
  try {
    signature = decodeSegment(signaturePart);
  } catch {
    throw new JwtError("malformed");
  }
  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  if (!(await crypto.subtle.verify(RS256, key, signature, signed))) throw new JwtError("signature");

  if (typeof claims.iss !== "string" || !options.issuers.includes(claims.iss)) throw new JwtError("issuer");
  const audiences = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
  if (!audiences.includes(options.audience)) throw new JwtError("audience");
  const seconds = now / 1000;
  if (typeof claims.exp !== "number" || seconds > claims.exp + CLOCK_SKEW_SECONDS) throw new JwtError("expired");
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || seconds < claims.nbf - CLOCK_SKEW_SECONDS)) {
    throw new JwtError("not_yet_valid");
  }
  return claims;
}

/** The token's email claim, trimmed and lowercased, or a JwtError when it has none. */
export function emailClaim(claims: Record<string, unknown>): string {
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (email === "") throw new JwtError("email");
  return email;
}
