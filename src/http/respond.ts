// The Worker's plain answers, every one with the security headers and never cached.
import { withSecurityHeaders } from "../security.ts";

export function htmlResponse(body: string, status: number, headers: Record<string, string> = {}): Response {
  return withSecurityHeaders(
    new Response(body, {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers },
    }),
  );
}

export function textResponse(body: string, status: number, headers: Record<string, string> = {}): Response {
  return withSecurityHeaders(
    new Response(`${body}\n`, {
      status,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers },
    }),
  );
}

/**
 * The same answer for a post made by /live.js (decision 0062): the page to load next in `X-Location`, not a redirect for
 * the browser to follow (a followed redirect is upgraded to https on a plain-http local board and fails).
 */
export function liveDone(location: string, headers: Record<string, string> = {}): Response {
  return withSecurityHeaders(new Response(null, { status: 204, headers: { "X-Location": location, "Cache-Control": "no-store", ...headers } }));
}

/** Post/Redirect/Get: a board write answers with the page to load next, so a reload never repeats it. */
export function seeOther(location: string, headers: Record<string, string> = {}): Response {
  return withSecurityHeaders(new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", ...headers } }));
}
