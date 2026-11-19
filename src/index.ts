import { accessSignIn, type AccessResult } from "./auth/access.ts";
import { authMode } from "./auth/dev.ts";
import { isOAuthPath } from "./auth/oauth-routes.ts";
import { notFoundPage, serverErrorPage } from "./board/pages/not-found.ts";
import { matchBoardPage } from "./board/router.ts";
import { runScheduled } from "./cron.ts";
import type { Env } from "./env.ts";
import { apiMethodNotAllowed, handleApi, isApiPath, json } from "./http/api.ts";
import { handleIntake } from "./http/intake.ts";
import { MCP_ROUTE } from "./mcp/route.ts";
import { withSecurityHeaders } from "./security.ts";

const INTAKE_ROUTE = "/intake";

// A last path segment with an extension (/board.css, /robots.txt) is a static file in out/.
const FILE_PATH = /\/[^/]+\.[A-Za-z0-9]+$/;

const SERVER_ERROR = "Something went wrong on the server. Nothing was changed.";

function htmlResponse(body: string, status: number): Response {
  return withSecurityHeaders(
    new Response(body, {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    }),
  );
}

function textResponse(body: string, status: number): Response {
  return withSecurityHeaders(
    new Response(`${body}\n`, {
      status,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
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

  const { pathname } = new URL(request.url);
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

  if (!isRead(request)) return methodNotAllowed();

  const page = matchBoardPage(pathname);
  if (page) {
    try {
      const auth = await signIn();
      if (!auth.ok) return textResponse(auth.message, auth.status);
      const result = await page(env.DB, new Date());
      return htmlResponse(result.body, result.status);
    } catch {
      console.error(JSON.stringify({ event: "board_failed" }));
      return htmlResponse(serverErrorPage(), 500);
    }
  }

  if (FILE_PATH.test(pathname)) {
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return withSecurityHeaders(asset);
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
