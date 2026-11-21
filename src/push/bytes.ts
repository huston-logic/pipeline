// Byte helpers for web push: base64url without padding (RFC 4648 section 5), the encoding of every push key.

const BASE64URL = /^[A-Za-z0-9_-]*$/;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Throws on anything that is not base64url (padding is not accepted either). */
export function fromBase64Url(text: string): Uint8Array {
  if (!BASE64URL.test(text) || text.length % 4 === 1) throw new Error("Not base64url.");
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

/** The bytes of a base64url value, or null when it is not base64url or not `length` bytes long. */
export function base64UrlBytes(text: string, length: number): Uint8Array | null {
  try {
    const bytes = fromBase64Url(text);
    return bytes.length === length ? bytes : null;
  } catch {
    return null;
  }
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
