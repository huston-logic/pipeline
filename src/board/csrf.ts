// The board's CSRF token (decision 0014): a double-submit cookie. A board page that finds no cookie makes one token
// and puts it in both its Set-Cookie and every form's hidden `csrf` field; a board post must carry the same value in
// both. `__Host-` cookies need HTTPS, so local dev over http://localhost uses a plain name, accepted only there.
import { secretMatches } from "../http/limits.ts";

export type CsrfMode = "dev" | "production";

/** The hidden form field that carries the token. */
export const CSRF_FIELD = "csrf";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const csrfCookieName = (mode: CsrfMode): string => (mode === "dev" ? "pipeline-csrf" : "__Host-pipeline-csrf");

export const isCsrfToken = (value: string): boolean => TOKEN.test(value);

/** 32 random bytes as unpadded base64url. */
export function newCsrfToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * The Set-Cookie value. A session cookie: a page loaded after the browser restarts sets a new one. SameSite=Lax, not
 * Strict (decision 0014, amended in R3): Strict drops the cookie when the owner arrives from another site (the Access
 * sign-in, an email link, the AI app), so that page would mint a new token and break every other open tab. Lax still
 * withholds the cookie on cross-site posts, and the same-origin check runs before the token anyway.
 */
export function csrfCookie(token: string, mode: CsrfMode): string {
  const secure = mode === "dev" ? "" : " Secure;";
  return `${csrfCookieName(mode)}=${token}; Path=/;${secure} HttpOnly; SameSite=Lax`;
}

/** The token in the request's cookie for this sign-in mode, or null when it is missing or not a token. */
export function csrfFromCookies(request: Request, mode: CsrfMode): string | null {
  const name = csrfCookieName(mode);
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const split = part.indexOf("=");
    if (split < 0 || part.slice(0, split).trim() !== name) continue;
    const value = part.slice(split + 1).trim();
    return isCsrfToken(value) ? value : null;
  }
  return null;
}

/** Whether the form's token is the cookie's, compared in constant time. */
export async function csrfMatches(cookie: string, field: string | null): Promise<boolean> {
  if (field === null || !isCsrfToken(field)) return false;
  return secretMatches(field, cookie);
}
