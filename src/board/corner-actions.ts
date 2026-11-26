// The status corner's Close (run 12): POST /corner/close remembers, for five minutes and in a cookie, which change the
// owner closed, so the corner stops showing it. It writes no data. B3's corner reads the cookie with closedChangeFrom.
import { isChangeId } from "../ids.ts";
import { type ActionContext, type ActionResult, backTo, type Route } from "./action-kit.ts";

export const CORNER_COOKIE = "pipeline_corner";
const MAX_AGE_SECONDS = 300;

/** The change id the owner closed, from the request's cookie, or null when there is none or it is not a change id. */
export function closedChangeFrom(request: Request, secure: boolean): string | null {
  const name = cornerCookieName(secure);
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const split = part.indexOf("=");
    if (split < 0 || part.slice(0, split).trim() !== name) continue;
    const value = part.slice(split + 1).trim();
    return isChangeId(value) ? value : null;
  }
  return null;
}

/** `__Host-` in secure mode, exactly as the CSRF cookie (csrf.ts); the plain name only over http://localhost. */
const cornerCookieName = (secure: boolean): string => (secure ? `__Host-${CORNER_COOKIE}` : CORNER_COOKIE);

/** The Set-Cookie value that closes a change's corner; `secure` comes from the same sign-in mode as the CSRF cookie's. */
export const closeCookie = (changeId: string, secure: boolean): string =>
  `${cornerCookieName(secure)}=${changeId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`;

async function close(ctx: ActionContext): Promise<ActionResult> {
  const change = ctx.form.get("change") ?? "";
  const location = backTo(ctx, "/");
  if (!isChangeId(change)) return { kind: "redirect", location };
  return { kind: "redirect", location, headers: { "Set-Cookie": closeCookie(change, ctx.secure) } };
}

export const CORNER_ROUTES: Route[] = [{ path: /^\/corner\/(close)$/, handle: (ctx) => close(ctx) }];
