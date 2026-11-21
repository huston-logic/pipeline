import { accessSignIn, type AccessResult } from "./auth/access.ts";
import { authMode } from "./auth/dev.ts";
import { isOAuthPath } from "./auth/oauth-routes.ts";
import { matchBoardAction } from "./board/actions.ts";
import { type CsrfMode, csrfCookie, csrfFromCookies, newCsrfToken } from "./board/csrf.ts";
import { MANIFEST_PATH, manifestFor } from "./board/manifest.ts";
import { notFoundPage, serverErrorPage } from "./board/pages/not-found.ts";
import { handleBoardPost } from "./board/post.ts";
import { matchBoardPage } from "./board/router.ts";
import { THEME_PATH, themeStylesheet } from "./board/theme.ts";
import { runScheduled } from "./cron.ts";
import type { Env } from "./env.ts";
import { apiMethodNotAllowed, handleApi, isApiPath, json } from "./http/api.ts";
import { handleIntake } from "./http/intake.ts";
import { htmlResponse, textResponse } from "./http/respond.ts";
import { MCP_ROUTE } from "./mcp/route.ts";
import { vapidKeys } from "./push/vapid.ts";
import { withSecurityHeaders } from "./security.ts";

const INTAKE_ROUTE = "/intake";
const SERVICE_WORKER_PATH = "/sw.js";

// A last path segment with an extension (/board.css, /robots.txt) is a static file in out/.
const FILE_PATH = /\/[^/]+\.[A-Za-z0-9]+$/;

const SERVER_ERROR = "Something went wrong on the server. Nothing was changed.";

function cssResponse(body: string): Response {
  return withSecurityHeaders(
    new Response(body, { headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store" } }),
  );
}

function manifestResponse(body: string): Response {
  return withSecurityHeaders(
    new Response(body, { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "no-store" } }),
  );
}

function methodNotAllowed(): Response {
  return withSecurityHeaders(
    new Response("This address only answers GET requests.\n", {
      status: 405,
      headers: { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" },
    }),
  );
}

const isRead = (request: Request) => request.method === "GET" || request.method === "HEAD";

/** Loaded only for a signed-in /mcp request, so the board (and the Node unit tests) never load the MCP SDK. */
async function serveMcp(request: Request, env: Env, ctx: ExecutionContext, email: string): Promise<Response> {
  const { handleMcp } = await import("./mcp/handler.ts");
  return handleMcp(request, env, ctx, email);
}

async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Checked first so a misconfigured sign-in mode refuses every route, not only /mcp.
  const mode = authMode(request, env);
  if (mode.kind === "misconfigured") return textResponse(mode.message, 500);

  const url = new URL(request.url);
  const { pathname } = url;
  // /intake has its own secret instead of a sign-in, so it sits outside both sign-ins (decision 0012).
  if (pathname === INTAKE_ROUTE) return withSecurityHeaders(await handleIntake(request, env, new Date()));

  if (mode.kind === "production" && isOAuthPath(pathname)) {
    // /mcp, /authorize, /callback, /token, /register and /.well-known/*: OAuth with Access as the upstream sign-in.
    try {
      const { handleOAuth } = await import("./auth/oauth-provider.ts");
      return await handleOAuth(request, env, ctx, serveMcp);
    } catch {
      console.error(JSON.stringify({ event: "oauth_failed" }));
      return textResponse(SERVER_ERROR, 500);
    }
  }
  if (pathname === MCP_ROUTE && mode.kind === "dev") {
    return withSecurityHeaders(await serveMcp(request, env, ctx, mode.email));
  }

  // The board and /api: Cloudflare Access in production, the dev sign-in locally. Pages that show no data (static
  // files, the 404 page) need neither.
  const signIn = (): Promise<AccessResult> =>
    mode.kind === "dev" ? Promise.resolve({ ok: true, email: mode.email }) : accessSignIn(request, env);

  if (isApiPath(pathname)) {
    if (!isRead(request)) return apiMethodNotAllowed();
    try {
      const auth = await signIn();
      if (!auth.ok) return json({ error: auth.message }, auth.status);
      return await handleApi(request, env, new Date());
    } catch {
      console.error(JSON.stringify({ event: "api_failed" }));
      return json({ error: SERVER_ERROR }, 500);
    }
  }

  // Board writes: only the paths in src/board/actions.ts; every other POST, PUT, DELETE ... is 405 (decision 0017).
  const csrfMode: CsrfMode = mode.kind === "dev" ? "dev" : "production";
  if (!isRead(request)) {
    const action = request.method === "POST" ? matchBoardAction(pathname) : null;
    if (action === null) return methodNotAllowed();
    try {
      return await handleBoardPost(request, env, csrfMode, signIn, action);
    } catch {
      console.error(JSON.stringify({ event: "board_post_failed" }));
      return htmlResponse(serverErrorPage(), 500);
    }
  }

  // Before the static-file branch: they look like files, but the Worker writes them from the settings.
  if (pathname === THEME_PATH) {
    try {
      const auth = await signIn();
      if (!auth.ok) return textResponse(auth.message, auth.status);
      return cssResponse(await themeStylesheet(env.DB));
    } catch {
      console.error(JSON.stringify({ event: "theme_failed" }));
      return textResponse(SERVER_ERROR, 500);
    }
  }
  if (pathname === MANIFEST_PATH) {
    try {
      const auth = await signIn();
      if (!auth.ok) return textResponse(auth.message, auth.status);
      return manifestResponse(await manifestFor(env.DB));
    } catch {
      console.error(JSON.stringify({ event: "manifest_failed" }));
      return textResponse(SERVER_ERROR, 500);
    }
  }

  const page = matchBoardPage(pathname);
  if (page) {
    try {
      const auth = await signIn();
      if (!auth.ok) return textResponse(auth.message, auth.status);
      // A page that finds no CSRF cookie makes one token for its Set-Cookie and every form on it (decision 0014).
      const cookie = csrfFromCookies(request, csrfMode);
      const csrf = cookie ?? newCsrfToken();
      const result = await page({ db: env.DB, now: new Date(), url, csrf, pushKey: vapidKeys(env)?.publicKey ?? null });
      const headers: Record<string, string> = cookie === null ? { "Set-Cookie": csrfCookie(csrf, csrfMode) } : {};
      return htmlResponse(result.body, result.status, headers);
    } catch {
      console.error(JSON.stringify({ event: "board_failed" }));
      return htmlResponse(serverErrorPage(), 500);
    }
  }

  if (FILE_PATH.test(pathname)) {
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) {
      const secured = withSecurityHeaders(asset);
      // The service worker is checked for a new version on every load, not after a cached copy expires (decision 0030).
      if (pathname === SERVICE_WORKER_PATH) secured.headers.set("Cache-Control", "no-cache");
      return secured;
    }
  }
  return htmlResponse(notFoundPage(), 404);
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env, ctx);
  },

  // The hourly Cron Trigger. Awaited (not waitUntil): the invocation lasts exactly as long as the run.
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runScheduled(env, new Date(controller.scheduledTime));
  },
};
