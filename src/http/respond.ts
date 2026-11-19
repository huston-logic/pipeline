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

/** Post/Redirect/Get: a board write answers with the page to load next, so a reload never repeats it. */
export function seeOther(location: string): Response {
  return withSecurityHeaders(new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } }));
}
