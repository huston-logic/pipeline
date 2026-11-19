// Test-only JWT helpers: an RSA key pair generated in the test run (never a real key), and tokens signed with it.
export interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  /** The public key as a JWKS entry. */
  jwk: JsonWebKey & { kid: string };
}

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

export async function makeKey(kid: string): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(
    { ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { kid, privateKey: pair.privateKey, jwk: { kty: exported.kty, n: exported.n, e: exported.e, alg: "RS256", use: "sig", kid } };
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

export async function signJwt(key: TestKey, payload: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const input = `${encode({ alg: "RS256", typ: "JWT", kid: key.kid, ...header })}.${encode(payload)}`;
  const signature = await crypto.subtle.sign(RS256, key.privateKey, new TextEncoder().encode(input));
  return `${input}.${Buffer.from(signature).toString("base64url")}`;
}

/** An HS256 token "signed" with the public modulus as the HMAC secret: the classic algorithm-confusion attempt. */
export async function hs256Jwt(key: TestKey, payload: Record<string, unknown>): Promise<string> {
  const input = `${encode({ alg: "HS256", typ: "JWT", kid: key.kid })}.${encode(payload)}`;
  const hmac = await crypto.subtle.importKey("raw", new TextEncoder().encode(key.jwk.n ?? ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(input));
  return `${input}.${Buffer.from(signature).toString("base64url")}`;
}

export function unsignedJwt(key: TestKey, payload: Record<string, unknown>): string {
  return `${encode({ alg: "none", typ: "JWT", kid: key.kid })}.${encode(payload)}.`;
}

/** A JWKS fetcher that serves `keys()` and counts its calls. */
export function jwksServer(keys: () => TestKey[]) {
  const calls: string[] = [];
  const fetchJwks = async (url: string) => {
    calls.push(url);
    return { keys: keys().map((k) => k.jwk) };
  };
  return { calls, fetchJwks };
}
