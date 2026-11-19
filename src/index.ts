import { homePage } from "./board/pages/home.ts";
import { notFoundPage } from "./board/pages/not-found.ts";
import type { Env } from "./env.ts";
import { withSecurityHeaders } from "./security.ts";

const pages = new Map<string, () => string>([["/", homePage]]);

// A last path segment with an extension (/board.css, /robots.txt) is a static file in out/.
const FILE_PATH = /\/[^/]+\.[A-Za-z0-9]+$/;

function htmlResponse(body: string, status: number): Response {
  return withSecurityHeaders(
    new Response(body, {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    }),
  );
}

function methodNotAllowed(): Response {
  return withSecurityHeaders(
    new Response("The board is read-only. Send a GET request instead.\n", {
      status: 405,
      headers: { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" },
    }),
  );
}

async function handleFetch(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed();

  const { pathname } = new URL(request.url);
  const page = pages.get(pathname);
  if (page) return htmlResponse(page(), 200);

  if (FILE_PATH.test(pathname)) {
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return withSecurityHeaders(asset);
  }
  return htmlResponse(notFoundPage(), 404);
}

export default {
  fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env);
  },

  // The hourly rules run and the daily brief are added here in later tasks; no cron is configured yet.
  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {},
};
